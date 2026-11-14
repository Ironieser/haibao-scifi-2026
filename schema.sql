-- 海豹杯 2026 获奖作品站 D1 表结构（数据库 haibao，binding DB）
-- 本地：npx wrangler d1 execute haibao --local --file=schema.sql
-- 线上：npx wrangler d1 execute haibao --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS reactions (work TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (work, kind, actor));
CREATE TABLE IF NOT EXISTS counters (work TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (work, kind));
CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, work TEXT NOT NULL, parent INTEGER, name TEXT NOT NULL, body TEXT NOT NULL, actor TEXT NOT NULL, ip TEXT NOT NULL, created INTEGER NOT NULL, likes INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS comments_work ON comments (work, parent, deleted, id);
CREATE TABLE IF NOT EXISTS comment_likes (cid INTEGER NOT NULL, actor TEXT NOT NULL, PRIMARY KEY (cid, actor));
CREATE TABLE IF NOT EXISTS ratelimit (key TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL);
-- 过期限流记录清理（DELETE ... WHERE reset < ?）走此索引，避免全表扫描
CREATE INDEX IF NOT EXISTS ratelimit_reset ON ratelimit (reset);
-- 热门划线（公开、匿名）：marks 记录「谁划过哪一段」（同一段每人只计一次），mark_counts 为增量计数。
-- WITHOUT ROWID：主键即聚簇索引，每次写入只写一行（不再额外写一份主键索引），节省 D1 写入额度。
CREATE TABLE IF NOT EXISTS marks (work TEXT NOT NULL, p INTEGER NOT NULL, actor TEXT NOT NULL, PRIMARY KEY (work, p, actor)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS mark_counts (work TEXT NOT NULL, p INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (work, p)) WITHOUT ROWID;
-- 热门段落查询（WHERE work = ? AND n >= 2 ORDER BY n DESC LIMIT 50）走此部分索引：只读取前 50 条，
-- 且只有 n >= 2 的段落进入索引（大多数段落 n <= 1，不产生额外写入）。
CREATE INDEX IF NOT EXISTS mark_counts_top ON mark_counts (work, n) WHERE n >= 2;

-- 浏览量（src/views.js）：PV 按页面×天聚合；UV 按天计数，visitors 用于去重
CREATE TABLE IF NOT EXISTS views (page TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (page, day)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS uv (day TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS visitors (day TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY (day, actor)) WITHOUT ROWID;
-- 浏览量汇总（增量维护，避免对 views 全表 GROUP BY）：
--   view_totals 每个页面一行累计 PV（行数 ≤ 页面白名单，约 25 行）；
--   views 中 page = '*' 的行是每日全站 PV（近 30 天走势按主键前缀 (page='*', day>=?) 读取 30 行）。
-- 由 src/views.js 的 flush 同时维护；已有数据用 scripts/migrate_views.sql 一次性回填（可重复执行）。
CREATE TABLE IF NOT EXISTS view_totals (page TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;

-- 片段级热门划线（公开、匿名，只存字符区间，不存笔记）：
--   mark_ranges：某读者（actor 为 SHA-256 哈希）在某段的划线区间并集 segs = JSON [[s,e],...]（已排序、合并，≤ 20 个）。
--     该段没有划线时删除这一行。
--   hot_cov：某段的覆盖计数，cov = 游程编码 JSON [[s,e,n],...]（n ≥ 1，相邻同值已合并），maxn = 段内最大覆盖人数；
--     tok 为每次写入生成的随机令牌，用于乐观并发控制（比较并交换，见 functions/api/[[path]].js handlePostHot）。
--   mark_actors / work_highlighters：作品「有划线的读者数」，actor 首次在该作品划线时 +1（之后不减）。
CREATE TABLE IF NOT EXISTS mark_ranges (work TEXT NOT NULL, p INTEGER NOT NULL, actor TEXT NOT NULL, segs TEXT NOT NULL, PRIMARY KEY (work, p, actor)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS hot_cov (work TEXT NOT NULL, p INTEGER NOT NULL, cov TEXT NOT NULL, maxn INTEGER NOT NULL DEFAULT 0, tok TEXT NOT NULL DEFAULT '', PRIMARY KEY (work, p)) WITHOUT ROWID;
-- 热门片段查询（WHERE work = ? AND maxn >= 3 ORDER BY maxn DESC LIMIT 50）走此部分索引；
-- 条件 maxn >= 3 须与代码中的 HOT_MIN 一致（查询里也要写字面量 3，SQLite 才会选用部分索引）。
CREATE INDEX IF NOT EXISTS hot_cov_top ON hot_cov (work, maxn) WHERE maxn >= 3;
CREATE TABLE IF NOT EXISTS mark_actors (work TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY (work, actor)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS work_highlighters (work TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
