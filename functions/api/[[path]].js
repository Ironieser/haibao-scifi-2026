// 海豹杯 2026 获奖作品站 — Pages Functions 后端（/api/*）
// 接口与表结构以 SPEC.md 为准。
// 片段级热门划线：GET/POST /api/works/:id/hot（handleHot*）；页面打开合并请求：POST /api/hit（handleHit）。
// 旧的段级热门划线接口 /api/works/:id/marks（handleListMarks / handlePostMarks）保留给旧页面，新前端不再调用。

import {
  handleView, handleViews, handleViewsSeries, handleRecentComments, recordView, loadParts, cacheKey,
  summaryPart, seriesPart, recentPart, patchSeries, viewsOut,
} from '../../src/views.js';

const WORK_IDS = new Set([
  'huidao-mingtian', 'zhuan-rengong', 'yiqie-ruchang', 'shuzi-shibolie',
  'dengdai-geduo', 'qinfen-de-heli', 'jingyinqu', 'taiyang-de-zangli',
  'gongzuo', 'mr-man', 'yinger-gongchang', 'shenhai-shenjingyuan',
  'zhuxingzhe-jiuguan', 'ta-de-shou', 'xinming-de-zangli', 'qidian',
  'shengri-dangao', 'suoluomen',
]);

const VIEW_PAGES = new Set([...WORK_IDS, 'home', 'favorites', 'notes', 'stats', 'other']);
const MAX_BODY = 8 * 1024;
const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const STATS_TTL = 30;
const COMMENTS_TTL = 5;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const REPLIES_PER_COMMENT = 50;
const DEFAULT_NAME = '匿名读者';
const MARKS_TTL = 60;
const MARKS_TOP = 50;          // 热门段落最多返回 50 段
const MARKS_MIN = 2;           // n >= 2 才算热门（与 schema.sql 中部分索引的条件一致，须为字面量）
const MARK_P_MAX = 5000;       // 段落编号上限（最长的作品约 1200 段）
const MARK_BATCH_MAX = 30;     // 一次请求最多 30 段（跨段划线）
const MARK_DAY_MAX = 300;      // 同一设备每天最多 300 次（按段计）

// 片段级热门划线：常量集中在这里，调整阈值只改这几行
const HOT = {
  MIN: 3,            // 至少 3 人（须与 schema.sql 部分索引 hot_cov_top 的 maxn >= 3 一致，查询里也写字面量 3）
  RATIO: 0.02,       // 且至少为该作品有划线读者数的 2%：阈值 = max(MIN, ceil(RATIO × readers))
  TOP: 50,           // 每部作品最多显示 n 最高的 50 个片段
  MIN_LEN: 2,        // 短于 2 个字的片段不显示
  TTL: 60,           // GET 边缘缓存秒数
  POS_MAX: 5000,     // 段内字符偏移上限：0 ≤ s < e ≤ 5000
  SEGS_MAX: 20,      // 每段最多 20 个区间
  ITEMS_MAX: 30,     // 一次请求最多 30 段
  RETRIES: 5,        // 乐观并发冲突时最多尝试次数（每次之间随机退避）；仍冲突则走「只写本人区间 + 重算该段」的兜底
  HEAL_TRIES: 8,     // 重算该段时比较并交换的最多尝试次数
  HEAL_EVERY: 10,    // maxn 跨越 10 的倍数时从 mark_ranges 重算该段（自愈）
};

// 限流（device 为客户端随机生成，可被脚本轮换，所以写接口另加宽松的 IP 软限流；大陆 CGNAT / 校园网共用出口 IP，IP 上限放宽）
const BURST_MS = 15 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LIMITS = {
  COMMENT_DEV_BURST: 1,    // 同一设备 15 秒 1 条
  COMMENT_DEV_DAY: 50,     // 同一设备每天 50 条
  COMMENT_IP_BURST: 5,     // 同一 IP 15 秒 5 条
  COMMENT_IP_DAY: 300,     // 同一 IP 每天 300 条
  WRITE_IP_DAY: 2000,      // 同一 IP 每天 点赞 + 收藏 + 评论点赞 + 划线同步 合计 2000 次请求（D1 计数，每次写请求 +1 行写入）
  HIT_IP_MIN: 120,         // 同一 IP 每分钟 120 次 /api/hit 或 /api/view（只在 isolate 内存里计数，不写 D1）
};

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// 可缓存的响应在 extra 里给 'Cache-Control': 'public, max-age=N'；这里同时写入内部头 X-HB-TTL: N，
// 由 onRequest 出口统一改写成最终的 Cache-Control（见 finalize），不依赖 Cache API 命中时带回来的头。
function json(data, status = 200, extra = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...extra,
  };
  const m = /^public, max-age=(\d+)$/.exec(headers['Cache-Control']);
  if (m) headers['X-HB-TTL'] = m[1];
  return new Response(JSON.stringify(data), { status, headers });
}

// /api 出口统一兜底（Workers 入口 src/worker.js 与 Pages Functions 都经过 onRequest）：
// 线上从 caches.default 命中的响应会带回 zone 的 Browser Cache TTL（max-age=14400），浏览器会把计数、评论缓存 4 小时。
// 这里一律重建响应：有 X-HB-TTL 的设为 public, max-age=<我们的短 TTL>，其余设为 no-store；删除 Age / Expires 与内部头。
const MAX_TTL = 300;
function finalize(resp, head) {
  const h = new Headers(resp.headers);
  const ttl = Number(h.get('X-HB-TTL'));
  h.delete('X-HB-TTL');
  h.delete('Age');
  h.delete('Expires');
  h.set('Cache-Control', ttl > 0 && ttl <= MAX_TTL && resp.status === 200 ? `public, max-age=${ttl}` : 'no-store');
  h.set('X-Content-Type-Options', 'nosniff');
  return new Response(head ? null : resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

function errorResponse(status, message, extra) {
  return json({ error: message }, status, extra);
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 读取请求体，超过 8KB 直接拒绝（同时检查 Content-Length 与实际字节数）
async function readBody(request) {
  const len = request.headers.get('Content-Length');
  if (len && Number(len) > MAX_BODY) throw new HttpError(413, '请求内容过大');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      try { await reader.cancel(); } catch (_) { /* ignore */ }
      throw new HttpError(413, '请求内容过大');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

async function readJson(request, { optional = false } = {}) {
  const text = await readBody(request);
  if (!text.trim()) {
    if (optional) return {};
    throw new HttpError(400, '请求格式错误，需要 JSON');
  }
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new HttpError(400, '请求格式错误，需要 JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, '请求格式错误，需要 JSON 对象');
  return data;
}

function requireSalt(env) {
  if (!env.SALT) throw new HttpError(500, '服务器未配置 SALT');
  return env.SALT;
}

async function actorFrom(env, body) {
  const device = body.device;
  if (typeof device !== 'string' || !DEVICE_RE.test(device)) throw new HttpError(400, '设备标识无效');
  return sha256hex(requireSalt(env) + device);
}

async function ipHash(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return sha256hex(requireSalt(env) + ip);
}

function requireBool(v) {
  if (typeof v !== 'boolean') throw new HttpError(400, '参数 on 必须是 true 或 false');
  return v;
}

// 去掉控制字符（保留换行）、双向文本控制符与 BOM
function cleanText(s, { multiline }) {
  let t = String(s).replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  t = t.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩﻿]/g, '');
  if (!multiline) t = t.replace(/\n/g, ' ');
  else t = t.replace(/[ 　]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function charLen(s) {
  return [...s].length;
}

function originAllowed(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  let host;
  try { host = new URL(origin).host; } catch (_) { return false; }
  if (!host) return false;
  const reqHost = request.headers.get('Host');
  return host === url.host || (reqHost && host === reqHost);
}

// ---------- 缓存 ----------

function statsCacheKey(url) {
  return new Request(`${url.origin}/api/stats`, { method: 'GET' });
}

function commentsCacheKey(url, work, before, limit) {
  return new Request(`${url.origin}/api/works/${work}/comments?before=${before}&limit=${limit}`, { method: 'GET' });
}

function marksCacheKey(url, work) {
  return new Request(`${url.origin}/api/works/${work}/marks`, { method: 'GET' });
}

function getCache() {
  try { return typeof caches !== 'undefined' ? caches.default : null; } catch (_) { return null; }
}

async function cached(ctx, key, ttl, build) {
  const cache = getCache();
  if (cache) {
    try {
      const hit = await cache.match(key);
      // 命中：只取正文，重建响应头（命中带回的 Cache-Control / Age 不可信）
      if (hit) return new Response(hit.body, { status: 200, headers: {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttl}`, 'X-HB-TTL': String(ttl),
      } });
    } catch (_) { /* 缓存不可用时直接查库 */ }
  }
  const data = await build();
  const resp = json(data, 200, { 'Cache-Control': `public, max-age=${ttl}` });
  if (cache) ctx.waitUntil(cache.put(key, resp.clone()).catch(() => {}));
  return resp;
}

function purgeComments(ctx, url, work) {
  const cache = getCache();
  if (!cache) return;
  // 只清第一页（最常访问），其余页 5 秒内自然过期
  ctx.waitUntil(cache.delete(commentsCacheKey(url, work, 0, DEFAULT_LIMIT)).catch(() => {}));
}

// ---------- 计数 SQL ----------
// 增量计数，不做任何随数据量增长的 COUNT(*)（D1 按读取行数计费）。
// 同一个 batch（= 一个事务，D1 对单库串行执行）里依次：
//   1. 计数 ±1，条件是「主键点查：这一行当前是否存在」——必须放在改动 reactions 之前；
//   2. INSERT OR IGNORE / DELETE reactions；
//   3. 主键点查读回计数。
// 条件用 EXISTS/NOT EXISTS 主键点查而不是 changes()：语义不依赖「上一条语句」是谁，
// 读取量同样是 O(1)。（本地已验证 changes() 写法也正确，但 EXISTS 写法对执行环境没有额外假设。）
const COUNTER_INC_IF_ABSENT = `
  INSERT INTO counters (work, kind, n)
  SELECT ?1, ?2, 1
  WHERE NOT EXISTS (SELECT 1 FROM reactions WHERE work = ?1 AND kind = ?2 AND actor = ?3)
  ON CONFLICT (work, kind) DO UPDATE SET n = n + 1`;

const COUNTER_DEC_IF_PRESENT = `
  UPDATE counters SET n = MAX(n - 1, 0)
  WHERE work = ?1 AND kind = ?2
    AND EXISTS (SELECT 1 FROM reactions WHERE work = ?1 AND kind = ?2 AND actor = ?3)`;

const COUNTER_GET = 'SELECT n FROM counters WHERE work = ?1 AND kind = ?2';

// 评论计数 = 可见评论数（顶层被删后其回复也不可见）。
// 删除前按「目标当前是否可见」决定减多少：可见则减 1 + 它的可见回复数（仅限这一条串，走 comments_work 索引）。
// 发表评论：顶层评论或父评论仍可见时 +1（父评论若恰好被并发删除，这条回复不可见，也不计数）
const COMMENT_COUNTER_INC = `
  INSERT INTO counters (work, kind, n)
  SELECT ?1, 'comment', 1
  WHERE ?2 IS NULL OR EXISTS (SELECT 1 FROM comments WHERE id = ?2 AND deleted = 0)
  ON CONFLICT (work, kind) DO UPDATE SET n = n + 1`;

const COMMENT_COUNTER_DEC_FOR_DELETE = `
  UPDATE counters SET n = MAX(n - (
      1 + (SELECT COUNT(*) FROM comments WHERE work = ?1 AND parent = ?2 AND deleted = 0)
    ), 0)
  WHERE work = ?1 AND kind = 'comment'
    AND EXISTS (
      SELECT 1 FROM comments c WHERE c.id = ?2 AND c.deleted = 0
        AND (c.parent IS NULL OR EXISTS (SELECT 1 FROM comments p WHERE p.id = c.parent AND p.deleted = 0))
    )`;

// ---------- 处理函数 ----------

// 点赞 / 收藏 / 评论计数（counters 表 ≤ 18 × 3 行）。与 GET /api/stats 共用缓存键。
function statsPart(url) {
  return {
    key: statsCacheKey(url),
    ttl: STATS_TTL,
    stmts: (db) => [db.prepare('SELECT work, kind, n FROM counters')],
    build: ([rows]) => {
      const works = {};
      for (const id of WORK_IDS) works[id] = { likes: 0, favs: 0, comments: 0 };
      const field = { like: 'likes', fav: 'favs', comment: 'comments' };
      for (const r of rows) {
        if (works[r.work] && field[r.kind]) works[r.work][field[r.kind]] = r.n;
      }
      return { works };
    },
  };
}

async function handleStats(env, ctx, url) {
  const [data] = await loadParts(env, ctx.waitUntil, [statsPart(url)]);
  return json(data, 200, { 'Cache-Control': `public, max-age=${STATS_TTL}` });
}

async function handleReaction(env, request, work, kind) {
  const body = await readJson(request);
  const actor = await actorFrom(env, body);
  const on = requireBool(body.on);
  await ipWriteLimit(env, request);
  const stmts = on
    ? [
        env.DB.prepare(COUNTER_INC_IF_ABSENT).bind(work, kind, actor),
        env.DB.prepare('INSERT OR IGNORE INTO reactions (work, kind, actor, created) VALUES (?1, ?2, ?3, ?4)')
          .bind(work, kind, actor, Date.now()),
      ]
    : [
        env.DB.prepare(COUNTER_DEC_IF_PRESENT).bind(work, kind, actor),
        env.DB.prepare('DELETE FROM reactions WHERE work = ?1 AND kind = ?2 AND actor = ?3').bind(work, kind, actor),
      ];
  stmts.push(env.DB.prepare(COUNTER_GET).bind(work, kind));
  const res = await env.DB.batch(stmts);
  const n = res[2].results?.[0]?.n ?? 0;
  return json(kind === 'like' ? { on, likes: n } : { on, favs: n });
}

function rowToComment(r) {
  return { id: r.id, parent: r.parent ?? null, name: r.name, body: r.body, created: r.created, likes: r.likes };
}

async function handleListComments(env, ctx, url, work) {
  const beforeRaw = url.searchParams.get('before');
  const limitRaw = url.searchParams.get('limit');
  let before = 0;
  if (beforeRaw !== null && beforeRaw !== '') {
    if (!/^\d{1,15}$/.test(beforeRaw)) throw new HttpError(400, '参数 before 无效');
    before = Number(beforeRaw);
  }
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null && limitRaw !== '') {
    if (!/^\d{1,4}$/.test(limitRaw)) throw new HttpError(400, '参数 limit 无效');
    limit = Math.min(MAX_LIMIT, Math.max(1, Number(limitRaw)));
  }

  return cached(ctx, commentsCacheKey(url, work, before, limit), COMMENTS_TTL, async () => {
    const top = await env.DB.prepare(
      `SELECT id, parent, name, body, created, likes FROM comments
       WHERE work = ?1 AND parent IS NULL AND deleted = 0 AND (?2 = 0 OR id < ?2)
       ORDER BY id DESC LIMIT ?3`
    ).bind(work, before, limit + 1).all();
    const rows = top.results || [];
    const more = rows.length > limit;
    const comments = rows.slice(0, limit).map((r) => ({ ...rowToComment(r), replies: [] }));
    if (comments.length) {
      const byId = new Map(comments.map((c) => [c.id, c]));
      const rep = await env.DB.prepare(
        `SELECT id, parent, name, body, created, likes FROM (
           SELECT id, parent, name, body, created, likes,
                  ROW_NUMBER() OVER (PARTITION BY parent ORDER BY id ASC) AS rn
           FROM comments
           WHERE work = ?1 AND deleted = 0 AND parent IN (SELECT value FROM json_each(?2))
         ) WHERE rn <= ?3 ORDER BY id ASC`
      ).bind(work, JSON.stringify([...byId.keys()]), REPLIES_PER_COMMENT).all();
      for (const r of rep.results || []) byId.get(r.parent)?.replies.push(rowToComment(r));
    }
    return { comments, more };
  });
}

// 写接口（点赞、收藏、评论点赞、划线）共用的 IP 日上限：1 次 ratelimit 行写入
async function ipWriteLimit(env, request) {
  const ip = await ipHash(env, request);
  await hitLimits(env, [{ key: `ipw:${ip}`, window: DAY_MS, max: LIMITS.WRITE_IP_DAY,
    message: () => '这个网络今天的操作次数过多，请明天再试' }]);
}

// /api/hit、/api/view 的 IP 每分钟上限：只在本 isolate 内存里计数（不写 D1），是软限流
const hitWindow = new Map(); // ip -> {n, reset}
function hitRateOk(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  if (hitWindow.size > 20000) {
    for (const [k, v] of hitWindow) if (v.reset <= now) hitWindow.delete(k);
    if (hitWindow.size > 20000) hitWindow.clear();
  }
  let e = hitWindow.get(ip);
  if (!e || e.reset <= now) { e = { n: 0, reset: now + 60 * 1000 }; hitWindow.set(ip, e); }
  e.n += 1;
  return e.n <= LIMITS.HIT_IP_MIN;
}

async function hitLimits(env, keys) {
  // keys: [{key, window, max, message}]，先全部 +1，任一超限则回滚 +1 并报错
  const now = Date.now();
  const stmts = keys.map((k) => env.DB.prepare(
    `INSERT INTO ratelimit (key, n, reset) VALUES (?1, 1, ?2)
     ON CONFLICT (key) DO UPDATE SET
       n = CASE WHEN reset <= ?3 THEN 1 ELSE n + 1 END,
       reset = CASE WHEN reset <= ?3 THEN ?2 ELSE reset END
     RETURNING n, reset`
  ).bind(k.key, now + k.window, now));
  const res = await env.DB.batch(stmts);
  let violated = null;
  res.forEach((r, i) => {
    const row = r.results?.[0];
    if (!violated && row && row.n > keys[i].max) violated = { ...keys[i], reset: row.reset };
  });
  if (violated) {
    await env.DB.batch(keys.map((k) => env.DB.prepare(
      'UPDATE ratelimit SET n = n - 1 WHERE key = ?1 AND n > 0'
    ).bind(k.key)));
    const wait = Math.max(1, Math.ceil((violated.reset - now) / 1000));
    throw new HttpError(429, violated.message(wait), { 'Retry-After': String(wait) });
  }
}

async function handlePostComment(env, ctx, request, url, work) {
  const body = await readJson(request);
  const actor = await actorFrom(env, body);

  let name = body.name == null ? '' : body.name;
  if (typeof name !== 'string') throw new HttpError(400, '昵称格式不正确');
  name = cleanText(name, { multiline: false }) || DEFAULT_NAME;
  if (charLen(name) > 20) throw new HttpError(400, '昵称最多 20 个字');

  if (typeof body.body !== 'string') throw new HttpError(400, '评论内容不能为空');
  const text = cleanText(body.body, { multiline: true });
  const n = charLen(text);
  if (n < 2) throw new HttpError(400, '评论内容至少 2 个字');
  if (n > 1000) throw new HttpError(400, '评论内容最多 1000 个字');

  let parent = null;
  if (body.parent !== undefined && body.parent !== null) {
    if (!Number.isSafeInteger(body.parent) || body.parent <= 0) throw new HttpError(400, '回复的评论不存在');
    const p = await env.DB.prepare(
      'SELECT id FROM comments WHERE id = ?1 AND work = ?2 AND parent IS NULL AND deleted = 0'
    ).bind(body.parent, work).first();
    if (!p) throw new HttpError(400, '回复的评论不存在或已删除');
    parent = body.parent;
  }

  // IP + device 组合限流：设备严格（15 秒 1 条、每天 50 条），IP 宽松（15 秒 5 条、每天 300 条，避免误伤共用出口 IP 的读者）
  const ip = await ipHash(env, request);
  await hitLimits(env, [
    { key: `dev15:${actor}`, window: BURST_MS, max: LIMITS.COMMENT_DEV_BURST, message: (w) => `发言太快了，请 ${w} 秒后再试` },
    { key: `devday:${actor}`, window: DAY_MS, max: LIMITS.COMMENT_DEV_DAY, message: () => `你今天的发言已达上限（${LIMITS.COMMENT_DEV_DAY} 条），请明天再来` },
    { key: `ip15:${ip}`, window: BURST_MS, max: LIMITS.COMMENT_IP_BURST, message: (w) => `这个网络发言太频繁了，请 ${w} 秒后再试` },
    { key: `ipday:${ip}`, window: DAY_MS, max: LIMITS.COMMENT_IP_DAY, message: () => `今天这个网络的发言已达上限（${LIMITS.COMMENT_IP_DAY} 条），请明天再来` },
  ]);

  const created = Date.now();
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO comments (work, parent, name, body, actor, ip, created)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       RETURNING id, parent, name, body, created, likes`
    ).bind(work, parent, name, text, actor, ip, created),
    env.DB.prepare(COMMENT_COUNTER_INC).bind(work, parent),
  ]);
  const row = ins.results?.[0];
  const comment = rowToComment(row);
  if (comment.parent === null) comment.replies = [];

  purgeComments(ctx, url, work);
  // 偶尔清理过期的限流记录：走 ratelimit_reset 索引，只读已过期的行，且每次最多 200 行
  if (Math.random() < 0.05) {
    ctx.waitUntil(env.DB.prepare(
      'DELETE FROM ratelimit WHERE key IN (SELECT key FROM ratelimit WHERE reset < ?1 ORDER BY reset LIMIT 200)'
    ).bind(Date.now()).run().catch(() => {}));
  }
  return json({ comment }, 201);
}

async function findComment(env, cid) {
  return env.DB.prepare('SELECT id, work, actor FROM comments WHERE id = ?1 AND deleted = 0').bind(cid).first();
}

async function handleCommentLike(env, request, cid) {
  const body = await readJson(request);
  const actor = await actorFrom(env, body);
  const on = requireBool(body.on);
  const c = await findComment(env, cid);
  if (!c) throw new HttpError(404, '评论不存在或已删除');
  await ipWriteLimit(env, request);
  // 与作品点赞相同：先按主键点查决定 ±1，再改 comment_likes，最后读回
  const stmts = on
    ? [
        env.DB.prepare(
          `UPDATE comments SET likes = likes + 1 WHERE id = ?1
             AND NOT EXISTS (SELECT 1 FROM comment_likes WHERE cid = ?1 AND actor = ?2)`
        ).bind(cid, actor),
        env.DB.prepare('INSERT OR IGNORE INTO comment_likes (cid, actor) VALUES (?1, ?2)').bind(cid, actor),
      ]
    : [
        env.DB.prepare(
          `UPDATE comments SET likes = MAX(likes - 1, 0) WHERE id = ?1
             AND EXISTS (SELECT 1 FROM comment_likes WHERE cid = ?1 AND actor = ?2)`
        ).bind(cid, actor),
        env.DB.prepare('DELETE FROM comment_likes WHERE cid = ?1 AND actor = ?2').bind(cid, actor),
      ];
  stmts.push(env.DB.prepare('SELECT likes FROM comments WHERE id = ?1').bind(cid));
  const res = await env.DB.batch(stmts);
  return json({ on, likes: res[2].results?.[0]?.likes ?? 0 });
}

async function isAdmin(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m || !env.ADMIN_TOKEN) return false;
  // 比较哈希值，避免逐字节比较的时间差
  const [a, b] = await Promise.all([sha256hex(m[1].trim()), sha256hex(String(env.ADMIN_TOKEN))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleDeleteComment(env, ctx, request, url, cid) {
  const admin = await isAdmin(env, request);
  const body = await readJson(request, { optional: true });
  const c = await findComment(env, cid);
  if (!c) throw new HttpError(404, '评论不存在或已删除');
  if (!admin) {
    if (body.device === undefined) {
      throw new HttpError(request.headers.get('Authorization') ? 403 : 401, '没有删除权限');
    }
    const actor = await actorFrom(env, body);
    if (actor !== c.actor) throw new HttpError(403, '只能删除自己发表的评论');
  }
  // 先按删除前的可见性扣减计数，再软删除（同一事务）
  await env.DB.batch([
    env.DB.prepare(COMMENT_COUNTER_DEC_FOR_DELETE).bind(c.work, cid),
    env.DB.prepare('UPDATE comments SET deleted = 1 WHERE id = ?1 AND deleted = 0').bind(cid),
  ]);
  purgeComments(ctx, url, c.work);
  return json({ ok: true });
}


// ---------- 热门划线 ----------
// GET：主键前缀 work + 部分索引 mark_counts_top（n >= 2），只读取前 50 行；边缘缓存 60 秒。
async function handleListMarks(env, ctx, url, work) {
  return cached(ctx, marksCacheKey(url, work), MARKS_TTL, async () => {
    const { results } = await env.DB.prepare(
      `SELECT p, n FROM mark_counts WHERE work = ?1 AND n >= 2 ORDER BY n DESC LIMIT ${MARKS_TOP}`
    ).bind(work).all();
    return { top: (results || []).map((r) => ({ p: r.p, n: r.n })) };
  });
}

function parseMarkParagraphs(v) {
  const list = Array.isArray(v) ? v : [v];
  if (!list.length || list.length > MARK_BATCH_MAX) throw new HttpError(400, `参数 p 必须是 1–${MARK_BATCH_MAX} 个段落编号`);
  const out = [];
  for (const x of list) {
    if (!Number.isSafeInteger(x) || x < 1 || x > MARK_P_MAX) throw new HttpError(400, '参数 p 必须是有效的段落编号');
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

// POST {device, p, on}：p 为段落编号（或最多 30 个编号的数组，用于跨段划线）。
// 与点赞相同的增量写法，全部为主键点查，O(段数)。限流与写入放在同一个 batch（同一事务）里：
//   1. 限流计数 +段数（窗口 24 小时）；
//   2. 每段：计数 ±1（条件：未超限，且 marks 中这一行当前不存在/存在），再插入/删除 marks；
//   3. 删除归零的计数行，读回计数与限流值。
// 超限时 2 中的语句因条件不满足而不生效，整个请求返回 429。
async function handlePostMarks(env, request, work) {
  const body = await readJson(request);
  const actor = await actorFrom(env, body);
  const on = requireBool(body.on);
  const ps = parseMarkParagraphs(body.p);
  await ipWriteLimit(env, request);
  const now = Date.now();
  const rlKey = `markday:${actor}`;
  const RL_OK = `(SELECT n FROM ratelimit WHERE key = ?4) <= ${MARK_DAY_MAX}`;
  const stmts = [
    env.DB.prepare(
      `INSERT INTO ratelimit (key, n, reset) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET
         n = CASE WHEN reset <= ?4 THEN ?2 ELSE n + ?2 END,
         reset = CASE WHEN reset <= ?4 THEN ?3 ELSE reset END`
    ).bind(rlKey, ps.length, now + DAY_MS, now),
  ];
  for (const p of ps) {
    if (on) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO mark_counts (work, p, n)
           SELECT ?1, ?2, 1
           WHERE ${RL_OK} AND NOT EXISTS (SELECT 1 FROM marks WHERE work = ?1 AND p = ?2 AND actor = ?3)
           ON CONFLICT (work, p) DO UPDATE SET n = n + 1`
        ).bind(work, p, actor, rlKey),
        env.DB.prepare(
          `INSERT OR IGNORE INTO marks (work, p, actor) SELECT ?1, ?2, ?3 WHERE ${RL_OK}`
        ).bind(work, p, actor, rlKey),
      );
    } else {
      stmts.push(
        env.DB.prepare(
          `UPDATE mark_counts SET n = MAX(n - 1, 0)
           WHERE work = ?1 AND p = ?2 AND ${RL_OK}
             AND EXISTS (SELECT 1 FROM marks WHERE work = ?1 AND p = ?2 AND actor = ?3)`
        ).bind(work, p, actor, rlKey),
        env.DB.prepare(
          `DELETE FROM marks WHERE work = ?1 AND p = ?2 AND actor = ?3 AND ${RL_OK}`
        ).bind(work, p, actor, rlKey),
        env.DB.prepare('DELETE FROM mark_counts WHERE work = ?1 AND p = ?2 AND n <= 0').bind(work, p),
      );
    }
  }
  stmts.push(env.DB.prepare('SELECT n FROM ratelimit WHERE key = ?1').bind(rlKey));
  stmts.push(env.DB.prepare(
    'SELECT p, n FROM mark_counts WHERE work = ?1 AND p IN (SELECT value FROM json_each(?2))'
  ).bind(work, JSON.stringify(ps)));
  const res = await env.DB.batch(stmts);
  const used = res[res.length - 2].results?.[0]?.n ?? 0;
  if (used > MARK_DAY_MAX) {
    throw new HttpError(429, `今天的划线操作已达上限（${MARK_DAY_MAX} 次），本机划线照常保存，热门划线计数明天恢复同步`);
  }
  const counts = new Map((res[res.length - 1].results || []).map((r) => [r.p, r.n]));
  const items = ps.map((p) => ({ p, n: counts.get(p) ?? 0 }));
  return json(Array.isArray(body.p) ? { on, items } : { on, p: items[0].p, n: items[0].n, items });
}

// ---------- 片段级热门划线 ----------
// 区间：[s, e) 为段内纯文本字符偏移。segs = 某读者在某段的区间并集（排序、合并后的 JSON 字符串，作为比较并交换的值）。
// cov  = 该段所有读者区间的覆盖计数，游程编码 [[s, e, n], ...]（只存 n ≥ 1 的游程，相邻同值合并）。

function hotThreshold(readers) {
  return Math.max(HOT.MIN, Math.ceil(HOT.RATIO * (readers || 0)));
}

// 校验并规范化一段的区间列表：整数、0 ≤ s < e ≤ POS_MAX、最多 SEGS_MAX 个；排序后合并重叠与相接的区间
function normSegs(v) {
  if (!Array.isArray(v) || v.length > HOT.SEGS_MAX) throw new HttpError(400, `每段最多 ${HOT.SEGS_MAX} 个划线区间`);
  const list = v.map((x) => {
    if (!Array.isArray(x) || x.length !== 2) throw new HttpError(400, '划线区间格式应为 [起点, 终点]');
    const [a, b] = x;
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b > HOT.POS_MAX || a >= b) {
      throw new HttpError(400, `划线区间无效：需要 0 ≤ 起点 < 终点 ≤ ${HOT.POS_MAX} 的整数`);
    }
    return [a, b];
  }).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [a, b] of list) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function parseHotItems(v) {
  if (!Array.isArray(v) || !v.length || v.length > HOT.ITEMS_MAX) {
    throw new HttpError(400, `参数 items 必须是 1–${HOT.ITEMS_MAX} 个段落`);
  }
  const seen = new Set();
  return v.map((it) => {
    if (!it || typeof it !== 'object') throw new HttpError(400, '参数 items 格式不正确');
    const p = it.p;
    if (!Number.isSafeInteger(p) || p < 1 || p > MARK_P_MAX) throw new HttpError(400, '参数 p 必须是有效的段落编号');
    if (seen.has(p)) throw new HttpError(400, '同一段落在一次请求里只能出现一次');
    seen.add(p);
    const segs = normSegs(it.segs);
    return { p, segs, str: segs.length ? JSON.stringify(segs) : null };
  });
}

function parseJsonArray(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}

// 覆盖计数的差分：事件扫描。terms = [{segs:[[s,e]...], w}] 与已有 cov 的游程一起累加
function sweep(cov, terms) {
  const ev = new Map();
  const add = (pos, d) => ev.set(pos, (ev.get(pos) || 0) + d);
  for (const [a, b, n] of cov) { add(a, n); add(b, -n); }
  for (const { segs, w } of terms) for (const [a, b] of segs) { add(a, w); add(b, -w); }
  const pos = [...ev.keys()].sort((x, y) => x - y);
  const out = [];
  let cur = 0, maxn = 0;
  for (let i = 0; i < pos.length; i++) {
    cur += ev.get(pos[i]);
    const next = pos[i + 1];
    if (next === undefined) break;
    const n = Math.max(0, cur); // 理论上不会为负；万一数据漂移就截到 0，留待自愈重算
    if (n <= 0) continue;
    const last = out[out.length - 1];
    if (last && last[1] === pos[i] && last[2] === n) last[1] = next;
    else out.push([pos[i], next, n]);
    if (n > maxn) maxn = n;
  }
  return { cov: out, maxn };
}

// 覆盖计数 → 达到阈值的片段：连续（首尾相接）且 n ≥ T 的游程合并为一个片段，n 取片段内最大值
function hotPieces(p, cov, T) {
  const out = [];
  let cur = null;
  for (const [a, b, n] of cov) {
    if (n < T) { cur = null; continue; }
    if (cur && cur.e === a) { cur.e = b; if (n > cur.n) cur.n = n; }
    else { cur = { p, s: a, e: b, n }; out.push(cur); }
  }
  return out.filter((x) => x.e - x.s >= HOT.MIN_LEN);
}

function hotCacheKey(url, work) {
  return cacheKey(url.origin, `/api/works/${work}/hot`);
}

// 读取：有划线读者数 1 行 + 部分索引 hot_cov_top 上 maxn 最高的最多 50 段。
// 每个达到阈值的段至少贡献一个 n = maxn 的片段，所以「n 最高的 50 个片段」一定落在 maxn 最高的 50 段里。
function hotPart(url, work) {
  return {
    key: hotCacheKey(url, work),
    ttl: HOT.TTL,
    stmts: (db) => [
      db.prepare('SELECT n FROM work_highlighters WHERE work = ?1').bind(work),
      db.prepare(
        `SELECT p, cov, maxn FROM hot_cov WHERE work = ?1 AND maxn >= 3 ORDER BY maxn DESC LIMIT ${HOT.TOP}`
      ).bind(work),
    ],
    build: ([hl, rows]) => {
      const readers = hl[0]?.n || 0;
      const threshold = hotThreshold(readers);
      let segs = [];
      for (const r of rows) {
        if (r.maxn < threshold) continue;
        segs = segs.concat(hotPieces(r.p, parseJsonArray(r.cov), threshold));
      }
      segs.sort((a, b) => b.n - a.n || a.p - b.p || a.s - b.s);
      segs = segs.slice(0, HOT.TOP).sort((a, b) => a.p - b.p || a.s - b.s);
      return { threshold, readers, segs };
    },
  };
}

async function handleGetHot(env, ctx, url, work) {
  const [data] = await loadParts(env, ctx.waitUntil, [hotPart(url, work)]);
  return json(data, 200, { 'Cache-Control': `public, max-age=${HOT.TTL}` });
}

function randomTok() {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// 读当前状态：本人在这些段的 segs、这些段的 cov（主键点查，O(段数)）
function hotStateStmts(env, work, actor, ps) {
  const list = JSON.stringify(ps);
  return [
    env.DB.prepare(
      'SELECT p, segs FROM mark_ranges WHERE work = ?1 AND actor = ?2 AND p IN (SELECT value FROM json_each(?3))'
    ).bind(work, actor, list),
    env.DB.prepare(
      'SELECT p, cov, maxn, tok FROM hot_cov WHERE work = ?1 AND p IN (SELECT value FROM json_each(?2))'
    ).bind(work, list),
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 自愈 / 兜底：从 mark_ranges 重算这一段的覆盖计数（读取该段所有读者的行，只在 maxn 跨越 10 的倍数或并发冲突兜底时发生），
// 快照与令牌在同一个 batch（同一事务）里读取，再用令牌比较并交换写回；被别的写入抢先就重读重算。
async function healHot(env, work, p) {
  for (let i = 0; i < HOT.HEAL_TRIES; i++) {
    if (i) await sleep(5 + Math.random() * 25 * i);
    const [rows, cur] = await env.DB.batch([
      env.DB.prepare('SELECT segs FROM mark_ranges WHERE work = ?1 AND p = ?2').bind(work, p),
      env.DB.prepare('SELECT tok FROM hot_cov WHERE work = ?1 AND p = ?2').bind(work, p),
    ]);
    const tok = cur.results?.[0]?.tok;
    const terms = (rows.results || []).map((r) => ({ segs: parseJsonArray(r.segs), w: 1 }));
    const { cov, maxn } = sweep([], terms);
    const res = tok === undefined
      ? await env.DB.prepare(
        `INSERT INTO hot_cov (work, p, cov, maxn, tok) SELECT ?1, ?2, ?3, ?4, ?5
         WHERE NOT EXISTS (SELECT 1 FROM hot_cov WHERE work = ?1 AND p = ?2)`
      ).bind(work, p, JSON.stringify(cov), maxn, randomTok()).run()
      : await env.DB.prepare('UPDATE hot_cov SET cov = ?3, maxn = ?4, tok = ?5 WHERE work = ?1 AND p = ?2 AND tok = ?6')
        .bind(work, p, JSON.stringify(cov), maxn, randomTok(), tok).run();
    if (res.meta?.changes) return true;
  }
  console.error('hot heal gave up', work, p);
  return false;
}

// POST /api/works/:id/hot  {device, items:[{p, segs:[[s,e],...]}]}  →  {ok, done:[p], failed:[p]}
// 客户端在某段的划线集合变化时上传该段的新区间并集（空数组 = 该段已无划线）。只上传区间，不上传笔记与原文。
// 流程（每次尝试 2 次 D1 往返）：
//   1. 读：限流计数 +段数（与旧接口共用每设备每天 300 段次）、本人旧 segs、该段 cov 与令牌 tok；
//   2. 在 Worker 里算差分：cov' = cov + [新区间] − [旧区间]；
//   3. 写（同一 batch = 同一事务）：
//      a. hot_cov 比较并交换：只有 tok 仍是读到的值、且本人 segs 仍是读到的值时才写入 cov' 与新的随机令牌 T；
//      b. mark_ranges 写入/删除，条件是 hot_cov.tok = T（即 a 成功）——两者要么都生效、要么都不生效；
//      c. 本人首次在该作品划线：work_highlighters +1 并登记 mark_actors（同样以 a 成功为条件，且 NOT EXISTS 防重复）；
//      d. 读回各段 tok，判断哪些段提交成功。
//   冲突（并发写同一段）的段重新读取后重试，最多 HOT.RETRIES 次；本人并发重复提交相同内容时，重读后发现无变化即成功。
async function handlePostHot(env, ctx, request, work) {
  const body = await readJson(request);
  const actor = await actorFrom(env, body);
  const items = parseHotItems(body.items);
  const ip = await ipHash(env, request);
  const now = Date.now();
  const byP = new Map(items.map((it) => [it.p, it]));
  const rl = (key, n) => env.DB.prepare(
    `INSERT INTO ratelimit (key, n, reset) VALUES (?1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET
       n = CASE WHEN reset <= ?4 THEN ?2 ELSE n + ?2 END,
       reset = CASE WHEN reset <= ?4 THEN ?3 ELSE reset END
     RETURNING n`
  ).bind(key, n, now + DAY_MS, now);

  let pending = items.map((it) => it.p);
  const first = await env.DB.batch([
    rl(`markday:${actor}`, items.length),
    rl(`ipw:${ip}`, 1),
    env.DB.prepare('SELECT 1 AS x FROM mark_actors WHERE work = ?1 AND actor = ?2').bind(work, actor),
    ...hotStateStmts(env, work, actor, pending),
  ]);
  if ((first[0].results?.[0]?.n ?? 0) > MARK_DAY_MAX) {
    throw new HttpError(429, `今天的划线同步已达上限（${MARK_DAY_MAX} 段次），本机划线照常保存，热门划线明天再同步`);
  }
  if ((first[1].results?.[0]?.n ?? 0) > LIMITS.WRITE_IP_DAY) {
    throw new HttpError(429, '这个网络今天的操作次数过多，本机划线照常保存，热门划线明天再同步');
  }
  let known = !!first[2].results?.length;
  let state = [first[3], first[4]];
  const done = [];
  const heal = [];

  for (let attempt = 0; attempt < HOT.RETRIES && pending.length; attempt++) {
    if (attempt > 0) {
      await sleep(3 + Math.random() * 20 * attempt);   // 随机退避，错开并发写同一段的请求
      state = await env.DB.batch(hotStateStmts(env, work, actor, pending));
    }
    const mine = new Map((state[0].results || []).map((r) => [r.p, r.segs]));
    const covs = new Map((state[1].results || []).map((r) => [r.p, r]));
    const stmts = [];
    const tries = []; // {p, tok, before, after, adds}
    for (const p of pending) {
      const it = byP.get(p);
      const oldStr = mine.has(p) ? mine.get(p) : null;
      if (oldStr === it.str) { done.push(p); continue; } // 没有变化（或并发的另一请求已写入相同内容）
      const row = covs.get(p);
      const { cov, maxn } = sweep(row ? parseJsonArray(row.cov) : [], [
        { segs: it.segs, w: 1 }, { segs: parseJsonArray(oldStr), w: -1 },
      ]);
      const tok = randomTok();
      const mineIs = '(SELECT segs FROM mark_ranges WHERE work = ?1 AND p = ?2 AND actor = ?6) IS ?7';
      if (row) {
        stmts.push(env.DB.prepare(
          `UPDATE hot_cov SET cov = ?3, maxn = ?4, tok = ?5 WHERE work = ?1 AND p = ?2 AND tok = ?8 AND ${mineIs}`
        ).bind(work, p, JSON.stringify(cov), maxn, tok, actor, oldStr, row.tok));
      } else {
        stmts.push(env.DB.prepare(
          `INSERT INTO hot_cov (work, p, cov, maxn, tok) SELECT ?1, ?2, ?3, ?4, ?5
           WHERE NOT EXISTS (SELECT 1 FROM hot_cov WHERE work = ?1 AND p = ?2) AND ${mineIs}`
        ).bind(work, p, JSON.stringify(cov), maxn, tok, actor, oldStr));
      }
      const committed = 'EXISTS (SELECT 1 FROM hot_cov WHERE work = ?1 AND p = ?2 AND tok = ?4)';
      stmts.push(it.str
        ? env.DB.prepare(
          `INSERT INTO mark_ranges (work, p, actor, segs) SELECT ?1, ?2, ?3, ?5 WHERE ${committed}
           ON CONFLICT (work, p, actor) DO UPDATE SET segs = excluded.segs`
        ).bind(work, p, actor, tok, it.str)
        : env.DB.prepare(`DELETE FROM mark_ranges WHERE work = ?1 AND p = ?2 AND actor = ?3 AND ${committed}`)
          .bind(work, p, actor, tok));
      tries.push({ p, tok, before: row ? row.maxn : 0, after: maxn, adds: !!it.str });
    }
    if (!tries.length) { pending = []; break; }
    const addTries = tries.filter((t) => t.adds);
    if (!known && addTries.length) {
      const anyCommitted = `EXISTS (SELECT 1 FROM hot_cov WHERE work = ?1
        AND p IN (SELECT value FROM json_each(?3)) AND tok IN (SELECT value FROM json_each(?4)))`;
      const ps = JSON.stringify(addTries.map((t) => t.p)), toks = JSON.stringify(addTries.map((t) => t.tok));
      stmts.push(
        env.DB.prepare(
          `INSERT INTO work_highlighters (work, n) SELECT ?1, 1
           WHERE NOT EXISTS (SELECT 1 FROM mark_actors WHERE work = ?1 AND actor = ?2) AND ${anyCommitted}
           ON CONFLICT (work) DO UPDATE SET n = n + 1`
        ).bind(work, actor, ps, toks),
        env.DB.prepare(`INSERT OR IGNORE INTO mark_actors (work, actor) SELECT ?1, ?2 WHERE ${anyCommitted}`)
          .bind(work, actor, ps, toks),
      );
    }
    stmts.push(env.DB.prepare(
      'SELECT p, tok FROM hot_cov WHERE work = ?1 AND p IN (SELECT value FROM json_each(?2))'
    ).bind(work, JSON.stringify(tries.map((t) => t.p))));
    const res = await env.DB.batch(stmts);
    const now2 = new Map((res[res.length - 1].results || []).map((r) => [r.p, r.tok]));
    const retry = [];
    for (const t of tries) {
      if (now2.get(t.p) === t.tok) {
        done.push(t.p);
        if (t.adds) known = true;
        const a = Math.floor(t.before / HOT.HEAL_EVERY), b = Math.floor(t.after / HOT.HEAL_EVERY);
        if (a !== b) heal.push(t.p);
      } else retry.push(t.p);
    }
    pending = retry;
  }
  // 兜底：多次冲突仍未提交的段（同一段被大量并发写入），只按「本人旧区间未变」写入本人区间，再从 mark_ranges 重算该段。
  // 重算读取该段全部读者的行，但只在这种罕见情况下发生；重算完成前热门显示可能短暂偏少。
  if (pending.length) {
    const st = await env.DB.batch(hotStateStmts(env, work, actor, pending).slice(0, 1));
    const mine = new Map((st[0].results || []).map((r) => [r.p, r.segs]));
    const stmts = [];
    for (const p of pending) {
      const it = byP.get(p);
      const oldStr = mine.has(p) ? mine.get(p) : null;
      if (oldStr === it.str) continue;
      const same = '(SELECT segs FROM mark_ranges WHERE work = ?1 AND p = ?2 AND actor = ?3) IS ?4';
      stmts.push(it.str
        ? env.DB.prepare(
          `INSERT INTO mark_ranges (work, p, actor, segs) SELECT ?1, ?2, ?3, ?5 WHERE ${same}
           ON CONFLICT (work, p, actor) DO UPDATE SET segs = excluded.segs`
        ).bind(work, p, actor, oldStr, it.str)
        : env.DB.prepare(`DELETE FROM mark_ranges WHERE work = ?1 AND p = ?2 AND actor = ?3 AND segs IS ?4`)
          .bind(work, p, actor, oldStr));
    }
    const adds = pending.filter((p) => byP.get(p).str);
    if (!known && adds.length) {
      const mineNow = `EXISTS (SELECT 1 FROM mark_ranges WHERE work = ?1 AND actor = ?2 AND p IN (SELECT value FROM json_each(?3)))`;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO work_highlighters (work, n) SELECT ?1, 1
           WHERE NOT EXISTS (SELECT 1 FROM mark_actors WHERE work = ?1 AND actor = ?2) AND ${mineNow}
           ON CONFLICT (work) DO UPDATE SET n = n + 1`
        ).bind(work, actor, JSON.stringify(adds)),
        env.DB.prepare(`INSERT OR IGNORE INTO mark_actors (work, actor) SELECT ?1, ?2 WHERE ${mineNow}`)
          .bind(work, actor, JSON.stringify(adds)),
      );
    }
    stmts.push(hotStateStmts(env, work, actor, pending)[0]);
    const res = await env.DB.batch(stmts);
    const after = new Map((res[res.length - 1].results || []).map((r) => [r.p, r.segs]));
    const left = [];
    for (const p of pending) {
      if ((after.has(p) ? after.get(p) : null) === byP.get(p).str) { done.push(p); heal.push(p); } else left.push(p);
    }
    pending = left;
  }
  for (const p of new Set(heal)) ctx.waitUntil(healHot(env, work, p).catch((e) => console.error('hot heal failed', e)));
  done.sort((a, b) => a - b);
  return json({ ok: pending.length === 0, done, failed: pending.sort((a, b) => a - b) });
}

// ---------- 页面打开合并请求 ----------
// POST /api/hit  {page, device, work?, hot?, recent?, series?}（device 可省略：省略时只计 PV 不计 UV）
//   → {views:{total, today:{pv,uv}, pages}, stats:{works}, hot?, recent?, series?}
// 一次 Worker 调用：记一次浏览（内存批量写入），并返回页面需要的公开数据。各部分仍按各自的边缘缓存键缓存
// （与 GET /api/stats、/api/works/:id/hot、/api/comments/recent、/api/views/series 共用），未命中的部分合并成一个 D1 batch。
//   hot：作品页且 hot !== false（读者关闭「热门划线」时前端传 false）；recent：首页（或显式 recent:true）；
//   series：/stats/ 页（或显式 series:true）。
async function handleHit(env, ctx, request, url) {
  const body = await readJson(request, { optional: true });
  const page = typeof body.page === 'string' ? body.page : '';
  const work = typeof body.work === 'string' ? body.work : (WORK_IDS.has(page) ? page : '');
  if (work && !WORK_IDS.has(work)) throw new HttpError(404, '作品不存在');
  // 不在白名单里的页面（如 404）不计浏览，但仍返回公开数据（页脚的全站浏览量等）
  await recordView({ env, waitUntil: ctx.waitUntil, page, device: body.device, validPages: VIEW_PAGES });
  const want = {
    hot: !!work && body.hot !== false,
    recent: body.recent === undefined ? page === 'home' : body.recent === true,
    series: body.series === undefined ? page === 'stats' : body.series === true,
  };
  const names = ['summary', 'stats'];
  const parts = [summaryPart(url.origin), statsPart(url)];
  if (want.hot) { names.push('hot'); parts.push(hotPart(url, work)); }
  if (want.recent) { names.push('recent'); parts.push(recentPart(url.origin)); }
  if (want.series) { names.push('series'); parts.push(seriesPart(url.origin)); }
  const got = await loadParts(env, ctx.waitUntil, parts);
  const d = Object.fromEntries(names.map((n, i) => [n, got[i]]));
  const out = { views: viewsOut(d.summary), stats: d.stats };
  if (d.hot) out.hot = d.hot;
  if (d.recent) out.recent = d.recent;
  if (d.series) out.series = patchSeries(d.series.series, d.summary);
  return json(out);
}

// ---------- 路由 ----------

function methodNotAllowed(allow) {
  return errorResponse(405, '不支持的请求方法', { Allow: allow });
}

async function route(context) {
  const { request, env } = context;
  const ctx = { waitUntil: (p) => context.waitUntil(p) };
  const url = new URL(request.url);
  const rawMethod = request.method.toUpperCase();
  const method = rawMethod === 'HEAD' ? 'GET' : rawMethod;
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

  if (method !== 'GET' && !originAllowed(request, url)) {
    throw new HttpError(403, '不允许跨站请求');
  }
  if (!env.DB) throw new HttpError(500, '服务器未配置数据库');

  // 浏览量与讨论动态（实现见 src/views.js）
  const vctx = { request, env, waitUntil: (pr) => ctx.waitUntil(pr), json, errorResponse };
  if (parts.length === 1 && parts[0] === 'view') {
    if (method !== 'POST') return methodNotAllowed('POST');
    if (!hitRateOk(request)) throw new HttpError(429, '请求太频繁，请稍后再试', { 'Retry-After': '60' });
    const body = await readJson(request, { optional: true });
    return handleView({ ...vctx, body, validPages: VIEW_PAGES });
  }
  if (parts.length === 1 && parts[0] === 'hit') {
    if (method !== 'POST') return methodNotAllowed('POST');
    if (!hitRateOk(request)) throw new HttpError(429, '请求太频繁，请稍后再试', { 'Retry-After': '60' });
    return handleHit(env, ctx, request, url);
  }
  if (parts.length === 1 && parts[0] === 'views') {
    if (method !== 'GET') return methodNotAllowed('GET');
    return handleViews(vctx);
  }
  if (parts.length === 2 && parts[0] === 'views' && parts[1] === 'series') {
    if (method !== 'GET') return methodNotAllowed('GET');
    return handleViewsSeries(vctx);
  }
  if (parts.length === 2 && parts[0] === 'comments' && parts[1] === 'recent') {
    if (method !== 'GET') return methodNotAllowed('GET');
    return handleRecentComments(vctx);
  }

  // GET /api/stats
  if (parts.length === 1 && parts[0] === 'stats') {
    if (method !== 'GET') return methodNotAllowed('GET');
    return handleStats(env, ctx, url);
  }

  // /api/works/:id/(like|fav|comments|marks|hot)
  if (parts[0] === 'works' && parts.length === 3) {
    const [, work, action] = parts;
    if (!['like', 'fav', 'comments', 'marks', 'hot'].includes(action)) throw new HttpError(404, '接口不存在');
    if (!WORK_IDS.has(work)) throw new HttpError(404, '作品不存在');
    if (action === 'like' || action === 'fav') {
      if (method !== 'POST') return methodNotAllowed('POST');
      return handleReaction(env, request, work, action);
    }
    if (action === 'hot') {
      if (method === 'GET') return handleGetHot(env, ctx, url, work);
      if (method === 'POST') return handlePostHot(env, ctx, request, work);
      return methodNotAllowed('GET, POST');
    }
    if (action === 'marks') {
      if (method === 'GET') return handleListMarks(env, ctx, url, work);
      if (method === 'POST') return handlePostMarks(env, request, work);
      return methodNotAllowed('GET, POST');
    }
    if (method === 'GET') return handleListComments(env, ctx, url, work);
    if (method === 'POST') return handlePostComment(env, ctx, request, url, work);
    return methodNotAllowed('GET, POST');
  }

  // /api/comments/:cid[/like]
  if (parts[0] === 'comments' && (parts.length === 2 || (parts.length === 3 && parts[2] === 'like'))) {
    const cidRaw = parts[1];
    if (!/^[1-9]\d{0,14}$/.test(cidRaw)) throw new HttpError(404, '评论不存在');
    const cid = Number(cidRaw);
    if (parts.length === 3) {
      if (method !== 'POST') return methodNotAllowed('POST');
      return handleCommentLike(env, request, cid);
    }
    if (method !== 'DELETE') return methodNotAllowed('DELETE');
    return handleDeleteComment(env, ctx, request, url, cid);
  }

  throw new HttpError(404, '接口不存在');
}

export async function onRequest(context) {
  try {
    const resp = await route(context);
    // HEAD 按 GET 处理，但不返回正文
    return finalize(resp, context.request.method.toUpperCase() === 'HEAD');
  } catch (err) {
    if (err instanceof HttpError) return finalize(errorResponse(err.status, err.message, err.headers));
    console.error('api error', err && err.stack ? err.stack : err);
    return finalize(errorResponse(500, '服务器出错了，请稍后再试'));
  }
}
