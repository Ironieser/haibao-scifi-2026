// 海豹杯 2026 获奖作品站 — Pages Functions 后端（/api/*）
// 接口与表结构以 SPEC.md 为准。

const WORK_IDS = new Set([
  'huidao-mingtian', 'zhuan-rengong', 'yiqie-ruchang', 'shuzi-shibolie',
  'dengdai-geduo', 'qinfen-de-heli', 'jingyinqu', 'taiyang-de-zangli',
  'gongzuo', 'mr-man', 'yinger-gongchang', 'shenhai-shenjingyuan',
  'zhuxingzhe-jiuguan', 'ta-de-shou', 'xinming-de-zangli', 'qidian',
  'shengri-dangao', 'suoluomen',
]);

const MAX_BODY = 8 * 1024;
const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const STATS_TTL = 30;
const COMMENTS_TTL = 5;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const REPLIES_PER_COMMENT = 50;
const DEFAULT_NAME = '匿名读者';

// 限流规则：[key 前缀, 窗口毫秒, 上限, 超限提示]
const BURST_MS = 15 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
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

function getCache() {
  try { return typeof caches !== 'undefined' ? caches.default : null; } catch (_) { return null; }
}

async function cached(ctx, key, ttl, build) {
  const cache = getCache();
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
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

async function handleStats(env, ctx, url) {
  return cached(ctx, statsCacheKey(url), STATS_TTL, async () => {
    const works = {};
    for (const id of WORK_IDS) works[id] = { likes: 0, favs: 0, comments: 0 };
    const { results } = await env.DB.prepare('SELECT work, kind, n FROM counters').all();
    const field = { like: 'likes', fav: 'favs', comment: 'comments' };
    for (const r of results || []) {
      if (works[r.work] && field[r.kind]) works[r.work][field[r.kind]] = r.n;
    }
    return { works };
  });
}

async function handleReaction(env, request, work, kind) {
  const body = await readJson(request);
  const actor = await actorFrom(env, body);
  const on = requireBool(body.on);
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

  const ip = await ipHash(env, request);
  await hitLimits(env, [
    { key: `ip15:${ip}`, window: BURST_MS, max: 1, message: (w) => `发言太快了，请 ${w} 秒后再试` },
    { key: `ipday:${ip}`, window: DAY_MS, max: 50, message: () => '今天这个网络的发言已达上限（50 条），请明天再来' },
    { key: `devday:${actor}`, window: DAY_MS, max: 50, message: () => '你今天的发言已达上限（50 条），请明天再来' },
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

  // GET /api/stats
  if (parts.length === 1 && parts[0] === 'stats') {
    if (method !== 'GET') return methodNotAllowed('GET');
    return handleStats(env, ctx, url);
  }

  // /api/works/:id/(like|fav|comments)
  if (parts[0] === 'works' && parts.length === 3) {
    const [, work, action] = parts;
    if (!['like', 'fav', 'comments'].includes(action)) throw new HttpError(404, '接口不存在');
    if (!WORK_IDS.has(work)) throw new HttpError(404, '作品不存在');
    if (action === 'like' || action === 'fav') {
      if (method !== 'POST') return methodNotAllowed('POST');
      return handleReaction(env, request, work, action);
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
    return context.request.method.toUpperCase() === 'HEAD' ? new Response(null, resp) : resp;
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.message, err.headers);
    console.error('api error', err && err.stack ? err.stack : err);
    return errorResponse(500, '服务器出错了，请稍后再试');
  }
}
