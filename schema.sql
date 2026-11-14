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
