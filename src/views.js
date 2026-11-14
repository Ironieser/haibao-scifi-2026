// 浏览量统计：PV（按页面、按天）与 UV（按天、按匿名设备），以及「可缓存数据块」的公共加载逻辑。
// 为了守住 D1 免费额度（每天 10 万行写入），计数先在 isolate 内存里累加，最多每 FLUSH_MS 批量写一次
// （窗口内第一条计数安排一次延时写入，见 scheduleFlush）；isolate 被强制回收时可能丢失少量未写入的计数，这是可接受的近似。
// flush 同时增量维护两份汇总，读取时不再对 views 全表 GROUP BY：
//   view_totals(page, n)       每个页面的累计 PV（行数 ≤ 页面白名单）
//   views(page = '*', day, n)  每日全站 PV（近 30 天走势按主键前缀读取 30 行）
// 由 functions/api/[[path]].js 路由调用：POST /api/hit、POST /api/view（旧）、GET /api/views（旧）、
// GET /api/views/series、GET /api/comments/recent。

const FLUSH_MS = 20 * 1000;   // 线上 waitUntil 最长 30 秒，定时写入须在此之内
const MAX_PENDING_UV = 2000; // 单个 isolate 内存里最多攒这么多新访客就强制写一次
const MAX_SEEN_UV = 20000;   // 本 isolate 今天已写入过的访客（再来时不必再查库），超过就清空重来
export const SUMMARY_TTL = 60;
export const SERIES_TTL = 300;
export const RECENT_TTL = 30;
const SERIES_DAYS = 30;
const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const PAGE_RE = /^[a-z0-9-]{1,40}$/;
const ALL = '*'; // views 表里的全站每日汇总行（PAGE_RE 不允许 '*'，不会与真实页面冲突）

let pendingPv = new Map(); // "page|day" -> n
let pendingUv = new Map(); // "day|actorHash" -> true
let seenUv = new Set();    // "day|actorHash"：本 isolate 已提交过的访客
let seenDay = '';
let lastFlush = 0;
let flushing = null;

// 以北京时间计日
export function dayCN(ts = Date.now()) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function shortHash(salt, text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|uv|' + text));
  return [...new Uint8Array(buf).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function flush(env) {
  if (!pendingPv.size && !pendingUv.size) return;
  const pv = pendingPv;
  const uv = pendingUv;
  pendingPv = new Map();
  pendingUv = new Map();
  lastFlush = Date.now();
  const stmts = [];
  const byPage = new Map();
  const byDay = new Map();
  for (const [key, n] of pv) {
    const [page, day] = key.split('|');
    byPage.set(page, (byPage.get(page) || 0) + n);
    byDay.set(day, (byDay.get(day) || 0) + n);
    stmts.push(env.DB.prepare(
      'INSERT INTO views (page, day, n) VALUES (?1, ?2, ?3) ON CONFLICT(page, day) DO UPDATE SET n = n + ?3'
    ).bind(page, day, n));
  }
  for (const [page, n] of byPage) {
    stmts.push(env.DB.prepare(
      'INSERT INTO view_totals (page, n) VALUES (?1, ?2) ON CONFLICT(page) DO UPDATE SET n = n + ?2'
    ).bind(page, n));
  }
  for (const [day, n] of byDay) {
    stmts.push(env.DB.prepare(
      'INSERT INTO views (page, day, n) VALUES (?1, ?2, ?3) ON CONFLICT(page, day) DO UPDATE SET n = n + ?3'
    ).bind(ALL, day, n));
  }
  for (const key of uv.keys()) {
    const [day, actor] = key.split('|');
    // 先按主键判断这个访客今天是否已计过（O(1)），再登记
    stmts.push(env.DB.prepare(
      'INSERT INTO uv (day, n) SELECT ?1, 1 WHERE NOT EXISTS (SELECT 1 FROM visitors WHERE day = ?1 AND actor = ?2) ' +
      'ON CONFLICT(day) DO UPDATE SET n = n + 1'
    ).bind(day, actor));
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO visitors (day, actor) VALUES (?1, ?2)').bind(day, actor));
  }
  // 偶尔清理两天前的去重记录（按主键前缀范围删除）
  if (Math.random() < 0.02) {
    stmts.push(env.DB.prepare('DELETE FROM visitors WHERE day < ?1').bind(dayCN(Date.now() - 2 * 86400 * 1000)));
  }
  // D1 batch 单次语句数有限，分块提交
  for (let i = 0; i < stmts.length; i += 90) {
    await env.DB.batch(stmts.slice(i, i + 90));
  }
}

// 定时批量写入：窗口内第一条新计数安排一次 FLUSH_MS 后的写入（挂在该请求的 waitUntil 上，线上 waitUntil 最长 30 秒），
// 之后的计数只进内存，由这次写入一并带走。这样即使 isolate 之后没有新请求，计数也不会滞留在内存里。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let timer = null;
let timerAt = 0;
function scheduleFlush(env, waitUntil, force) {
  const now = Date.now();
  if (force && !flushing) {
    flushing = flush(env).catch((e) => console.error('views flush failed', e)).finally(() => { flushing = null; });
    waitUntil(flushing);
    return;
  }
  if (timer && now - timerAt < 60 * 1000) return;   // 已安排（超过 60 秒仍未完成视为失效，重新安排）
  const wait = Math.max(0, FLUSH_MS - (now - lastFlush));
  timerAt = now;
  const t = sleep(wait)
    .then(() => flushing)
    .then(() => flush(env))
    .catch((e) => console.error('views flush failed', e))
    .finally(() => { if (timer === t) timer = null; });
  timer = t;
  waitUntil(t);
}

// 记一次浏览（只写内存，按需触发批量写入）。page 格式无效时返回 false。
export async function recordView({ env, waitUntil, page, device, validPages }) {
  page = String(page || '');
  device = String(device || '');
  if (!PAGE_RE.test(page)) return false;
  if (!validPages.has(page)) page = 'other';   // 白名单外的页面（如 404、旧页面里的未知 key）一律记为 other
  const day = dayCN();
  const k = page + '|' + day;
  pendingPv.set(k, (pendingPv.get(k) || 0) + 1);
  if (DEVICE_RE.test(device) && env.SALT) {
    if (seenDay !== day || seenUv.size > MAX_SEEN_UV) { seenUv = new Set(); seenDay = day; }
    const uk = day + '|' + (await shortHash(env.SALT, device));
    if (!seenUv.has(uk)) { seenUv.add(uk); pendingUv.set(uk, true); }
  }
  if (lastFlush === 0) lastFlush = Date.now(); // 新 isolate 先攒一会儿
  scheduleFlush(env, waitUntil, pendingUv.size >= MAX_PENDING_UV);
  return true;
}

// ---------- 可缓存数据块 ----------
// part = { key: Request（边缘缓存键）, ttl: 秒, stmts: (db) => [D1 语句], build: (rows[][]) => 数据 }
// loadParts 先并行查边缘缓存（caches.default），未命中的块把语句拼进同一个 D1 batch（一次往返），再分别写回缓存。
function getCache() {
  try { return typeof caches !== 'undefined' ? caches.default : null; } catch (_) { return null; }
}

export function cacheKey(origin, path) {
  return new Request(origin + path, { method: 'GET' });
}

export async function loadParts(env, waitUntil, parts) {
  const cache = getCache();
  const out = new Array(parts.length);
  const miss = [];
  await Promise.all(parts.map(async (pt, i) => {
    if (cache) {
      try {
        const hit = await cache.match(pt.key);
        if (hit) { out[i] = await hit.json(); return; }
      } catch (_) { /* 缓存不可用时直接查库 */ }
    }
    miss.push(i);
  }));
  if (!miss.length) return out;
  miss.sort((a, b) => a - b);
  const groups = miss.map((i) => parts[i].stmts(env.DB));
  const res = await env.DB.batch(groups.flat());
  let off = 0;
  miss.forEach((i, k) => {
    const n = groups[k].length;
    out[i] = parts[i].build(res.slice(off, off + n).map((r) => r.results || []));
    off += n;
    if (cache) {
      const resp = new Response(JSON.stringify(out[i]), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${parts[i].ttl}` },
      });
      waitUntil(cache.put(parts[i].key, resp).catch(() => {}));
    }
  });
  return out;
}

// 浏览量汇总：view_totals（≤ 25 行）+ 今日全站 PV（1 行）+ 今日 UV（1 行）
export function summaryPart(origin) {
  return {
    key: cacheKey(origin, '/api/views/summary'),
    ttl: SUMMARY_TTL,
    stmts: (db) => {
      const today = dayCN();
      return [
        db.prepare('SELECT page, n FROM view_totals'),
        db.prepare('SELECT n FROM views WHERE page = ?1 AND day = ?2').bind(ALL, today),
        db.prepare('SELECT n FROM uv WHERE day = ?1').bind(today),
      ];
    },
    build: ([pages, pv, uv]) => {
      const map = {};
      let total = 0;
      for (const r of pages) { map[r.page] = r.n; total += r.n; }
      return { total, today: { pv: pv[0]?.n || 0, uv: uv[0]?.n || 0 }, pages: map, day: dayCN() };
    },
  };
}

// 近 30 天走势：views 主键前缀 (page = '*', day >= since) 30 行 + uv 主键范围 30 行
export function seriesPart(origin) {
  return {
    key: cacheKey(origin, '/api/views/series'),
    ttl: SERIES_TTL,
    stmts: (db) => {
      const since = dayCN(Date.now() - (SERIES_DAYS - 1) * 86400 * 1000);
      return [
        db.prepare('SELECT day, n FROM views WHERE page = ?1 AND day >= ?2').bind(ALL, since),
        db.prepare('SELECT day, n FROM uv WHERE day >= ?1').bind(since),
      ];
    },
    build: ([pvs, uvs]) => {
      const pvMap = Object.fromEntries(pvs.map((r) => [r.day, r.n]));
      const uvMap = Object.fromEntries(uvs.map((r) => [r.day, r.n]));
      const series = [];
      for (let i = SERIES_DAYS - 1; i >= 0; i--) {
        const d = dayCN(Date.now() - i * 86400 * 1000);
        series.push({ day: d, pv: pvMap[d] || 0, uv: uvMap[d] || 0 });
      }
      return { series };
    },
  };
}

// 走势缓存更久（300 秒）：用更新更勤的汇总（60 秒）覆盖其中「今天」这一项
export function patchSeries(series, summary) {
  const s = series.map((d) => ({ ...d }));
  const last = s[s.length - 1];
  if (last && summary && summary.day === last.day) { last.pv = summary.today.pv; last.uv = summary.today.uv; }
  return s;
}

export function viewsOut(summary) {
  return { total: summary.total, today: summary.today, pages: summary.pages };
}

// 最新 8 条可见评论（全站），供首页「讨论动态」。按主键倒序，只读少量行。
export function recentPart(origin) {
  return {
    key: cacheKey(origin, '/api/comments/recent'),
    ttl: RECENT_TTL,
    stmts: (db) => [db.prepare('SELECT id, work, name, body, created FROM comments WHERE deleted = 0 ORDER BY id DESC LIMIT 8')],
    build: ([rows]) => ({
      comments: rows.map((r) => ({ ...r, body: r.body.length > 120 ? r.body.slice(0, 120) + '…' : r.body })),
    }),
  };
}

// ---------- 旧接口（保留给仍在浏览器缓存里的旧页面；新前端只调 POST /api/hit） ----------

// POST /api/view  {device, page}
export async function handleView({ env, waitUntil, body, validPages, json, errorResponse }) {
  const ok = await recordView({ env, waitUntil, page: body?.page, device: body?.device, validPages });
  if (!ok) return errorResponse(400, '页面参数无效');
  return json({ ok: true });
}

// GET /api/views  →  { total, today:{pv,uv}, pages:{page: total}, series:[{day,pv,uv}] }
export async function handleViews({ request, env, waitUntil, json }) {
  const origin = new URL(request.url).origin;
  const [summary, series] = await loadParts(env, waitUntil, [summaryPart(origin), seriesPart(origin)]);
  return json({ ...viewsOut(summary), series: patchSeries(series.series, summary) }, 200,
    { 'Cache-Control': `public, max-age=${SUMMARY_TTL}` });
}

// GET /api/views/series  →  { series:[{day,pv,uv}] }（30 天）
export async function handleViewsSeries({ request, env, waitUntil, json }) {
  const origin = new URL(request.url).origin;
  const [series] = await loadParts(env, waitUntil, [seriesPart(origin)]);
  return json(series, 200, { 'Cache-Control': `public, max-age=${SERIES_TTL}` });
}

// GET /api/comments/recent  →  { comments:[...] }
export async function handleRecentComments({ request, env, waitUntil, json }) {
  const origin = new URL(request.url).origin;
  const [recent] = await loadParts(env, waitUntil, [recentPart(origin)]);
  return json(recent, 200, { 'Cache-Control': `public, max-age=${RECENT_TTL}` });
}
