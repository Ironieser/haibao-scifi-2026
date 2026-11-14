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
