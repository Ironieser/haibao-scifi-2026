// 浏览量统计：PV（按页面、按天）与 UV（按天、按匿名设备）。
// 为了守住 D1 免费额度（每天 10 万行写入），计数先在 isolate 内存里累加，最多每 FLUSH_MS 批量写一次；
// isolate 被回收时可能丢失少量未写入的计数，这是可接受的近似。
// 由 functions/api/[[path]].js 路由调用：POST /api/view、GET /api/views。

const FLUSH_MS = 10 * 1000;
const MAX_PENDING_UV = 2000; // 单个 isolate 内存里最多攒这么多新访客就强制写一次
const VIEWS_TTL = 60;
const SERIES_DAYS = 30;
const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const PAGE_RE = /^[a-z0-9-]{1,40}$/;

let pendingPv = new Map(); // "page|day" -> n
let pendingUv = new Map(); // "day|actorHash" -> true
let lastFlush = 0;
let flushing = null;

// 以北京时间计日
export function dayCN(ts = Date.now()) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function shortHash(salt, text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + "|uv|" + text));
  return [...new Uint8Array(buf).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function flush(env) {
  if (!pendingPv.size && !pendingUv.size) return;
  const pv = pendingPv;
  const uv = pendingUv;
  pendingPv = new Map();
  pendingUv = new Map();
  lastFlush = Date.now();
  const stmts = [];
  for (const [key, n] of pv) {
    const [page, day] = key.split("|");
    stmts.push(env.DB.prepare(
      "INSERT INTO views (page, day, n) VALUES (?1, ?2, ?3) ON CONFLICT(page, day) DO UPDATE SET n = n + ?3"
    ).bind(page, day, n));
  }
  for (const key of uv.keys()) {
    const [day, actor] = key.split("|");
    // 先按主键判断这个访客今天是否已计过（O(1)），再登记
    stmts.push(env.DB.prepare(
      "INSERT INTO uv (day, n) SELECT ?1, 1 WHERE NOT EXISTS (SELECT 1 FROM visitors WHERE day = ?1 AND actor = ?2) " +
      "ON CONFLICT(day) DO UPDATE SET n = n + 1"
    ).bind(day, actor));
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO visitors (day, actor) VALUES (?1, ?2)").bind(day, actor));
  }
  // D1 batch 单次语句数有限，分块提交
  for (let i = 0; i < stmts.length; i += 90) {
    await env.DB.batch(stmts.slice(i, i + 90));
  }
}

function scheduleFlush(env, waitUntil, force) {
  if (flushing) return;
  if (!force && Date.now() - lastFlush < FLUSH_MS) return;
  flushing = flush(env).catch((e) => console.error("views flush failed", e)).finally(() => { flushing = null; });
  waitUntil(flushing);
}

// POST /api/view  {device, page}
export async function handleView({ env, waitUntil, body, validPages, json, errorResponse }) {
  const page = String(body?.page || "");
  const device = String(body?.device || "");
  if (!PAGE_RE.test(page) || !validPages.has(page)) return errorResponse(400, "页面参数无效");
  const day = dayCN();
  const k = page + "|" + day;
  pendingPv.set(k, (pendingPv.get(k) || 0) + 1);
  if (DEVICE_RE.test(device) && env.SALT) {
    pendingUv.set(day + "|" + (await shortHash(env.SALT, device)), true);
  }
  if (lastFlush === 0) lastFlush = Date.now(); // 新 isolate 先攒一会儿
  scheduleFlush(env, waitUntil, pendingUv.size >= MAX_PENDING_UV);
  return json({ ok: true });
}

// GET /api/views  →  { total, today:{pv,uv}, pages:{page: total}, series:[{day,pv,uv}] }
export async function handleViews({ request, env, waitUntil, json }) {
  const cache = caches.default;
  const key = new Request(new URL("/api/views", request.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const today = dayCN();
  const since = dayCN(Date.now() - (SERIES_DAYS - 1) * 86400 * 1000);
  const [pages, days, uvs] = await env.DB.batch([
    env.DB.prepare("SELECT page, SUM(n) AS n FROM views GROUP BY page"),
    env.DB.prepare("SELECT day, SUM(n) AS n FROM views WHERE day >= ?1 GROUP BY day ORDER BY day").bind(since),
    env.DB.prepare("SELECT day, n FROM uv WHERE day >= ?1 ORDER BY day").bind(since),
  ]);
  const pageMap = {};
  let total = 0;
  for (const r of pages.results) { pageMap[r.page] = r.n; total += r.n; }
  const uvMap = Object.fromEntries(uvs.results.map((r) => [r.day, r.n]));
  const pvMap = Object.fromEntries(days.results.map((r) => [r.day, r.n]));
  const series = [];
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const d = dayCN(Date.now() - i * 86400 * 1000);
    series.push({ day: d, pv: pvMap[d] || 0, uv: uvMap[d] || 0 });
  }
  const res = json({ total, today: { pv: pvMap[today] || 0, uv: uvMap[today] || 0 }, pages: pageMap, series }, 200,
    { "Cache-Control": `public, max-age=${VIEWS_TTL}` });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
