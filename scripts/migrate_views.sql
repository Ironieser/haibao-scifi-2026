-- 一次性回填浏览量汇总（可重复执行，结果幂等）：
--   view_totals ← 按页面汇总 views（不含 '*' 行）；
--   views 中 page = '*' 的每日全站 PV ← 按天汇总 views（不含 '*' 行）。
-- 顺序：先执行 schema.sql（建新表）→ 部署新版 Worker → 再执行本文件。
--   npx wrangler d1 execute haibao --remote -c wrangler.worker.jsonc --file=scripts/migrate_views.sql
-- 部署后、回填前，新版 Worker 已开始对 view_totals / '*' 行做增量累加；回填会先删除再按 views 明细重算，
-- 明细行也包含这些增量，因此不会重复或遗漏；用 UPSERT（ON CONFLICT ... DO UPDATE）写回，
-- 即使回填中途有 flush 插入了同一主键也不会报错。只读写 view_totals 与 page = '*' 的行，不改动任何原有明细。
DELETE FROM view_totals;
INSERT INTO view_totals (page, n) SELECT page, SUM(n) FROM views WHERE page <> '*' GROUP BY page
  ON CONFLICT (page) DO UPDATE SET n = excluded.n;
DELETE FROM views WHERE page = '*';
INSERT INTO views (page, day, n) SELECT '*', day, SUM(n) FROM views WHERE page <> '*' GROUP BY day
  ON CONFLICT (page, day) DO UPDATE SET n = excluded.n;
