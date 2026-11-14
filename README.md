# 海豹杯 2026 获奖作品站

线上地址：https://scifi.ironieser.cc

2026 年海豹杯科幻文学大赛（睡前消息）获奖作品的阅读、下载与讨论站。

## 架构
- Cloudflare Workers + 静态资源（`wrangler.worker.jsonc`）：页面、正文、封面、下载文件直接由静态资源返回，不消耗 Worker 调用；只有 `/api/*` 进入 Worker（`src/worker.js` → `functions/api/[[path]].js`）。
- D1 数据库 `haibao`（`schema.sql`）：点赞、收藏、评论、评论点赞、限流。
- 免费计划额度内运行；超额时 API 暂时报错，阅读与下载不受影响。

## 构建与部署
```bash
# 原始稿件 → 段落 JSON → 清洗（已完成，产物在 content/works/）
python3 -I scripts/convert.py <稿件目录> <临时目录> && python3 -I scripts/clean.py <临时目录>
# 生成站点
python3 -I scripts/fonts.py && python3 -I scripts/build.py && python3 -I scripts/export.py
# 部署
npx wrangler deploy -c wrangler.worker.jsonc
```
本地开发：`npx wrangler dev -c wrangler.worker.jsonc --local`（需要 `.dev.vars` 中的 SALT / ADMIN_TOKEN），API 冒烟测试：`bash scripts/test_api.sh http://localhost:8787`。

## 管理
删除评论：`curl -X DELETE https://scifi.ironieser.cc/api/comments/<id> -H "Authorization: Bearer $(cat .admin_token)"`（`.admin_token` 仅存本地，未入库）。

## 目录
- `data/works.json` 获奖名单与作品元数据；`content/works/` 清洗后的正文
- `art/` 封面与首页插画（SVG，规范见 `art/STYLE.md`）
- `scripts/` 转换、清洗、构建、导出、字体子集化；`scripts/assets/` 站点 CSS/JS
- `SPEC.md` 设计与接口规格

作品版权归作者所有。展示字体：得意黑（OFL）子集。
