# 海豹杯 2026 获奖作品站

**在线阅读：https://scifi.ironieser.cc**

《睡前消息》马督工发起的海豹奖科幻小说征文赛（第 0 届）获奖作品集。同一批小说，人类评委和 AI 评委各评一次：18 部获奖作品，奖金合计 301,072 元。规则见《睡前消息》第 1026 期，颁奖与点评见第 1130 期。

觉得这个站有用，欢迎点个 ⭐ Star。

## 功能

- **获奖信息**：人类评委奖、AI 评委奖（奖金是 2 的幂）、鱼竿奖；两份名单的对照图
- **在线阅读**：版式尽量忠实于原稿（分场、粗斜体、公文/书信/系统提示等特殊版式），字号、行距、页宽、字体、背景可调，记住阅读位置，键盘翻页
- **划线与笔记**：选中文字即可划线、写笔记，「我的笔记」可导出 Markdown；划线超过阈值的句子对所有读者公开显示「N 人划线」（笔记内容不会上传）
- **下载**：每部作品提供 TXT 与 EPUB，另有全部作品打包
- **讨论**：评论、回复、点赞、收藏
- **分享**：微信二维码、微博、QQ、邮件，以及带二维码的金句分享图
- **督工点评**：节目第 1130 期的点评摘要，每条链接到视频对应时间点
- **公开访问统计**：全站浏览量、每日读者、作品阅读排行（/stats/）

## 技术

纯静态页面 + 一个很小的 Cloudflare Worker，全部跑在免费额度内：

- **页面**：Python 标准库脚本生成静态 HTML（`scripts/build.py`），原生 JS，无框架、无第三方 CDN（照顾中国大陆访问）
- **API**：Cloudflare Workers（`src/worker.js` → `functions/api/[[path]].js`），每次打开页面只发一个请求（`/api/hit`）；静态资源不经过 Worker
- **数据库**：Cloudflare D1（`schema.sql`），点赞、收藏、评论、划线聚合、浏览量；计数增量更新、浏览量内存批量写入，所有热点查询走主键或索引
- **设计**：孔版印刷（Risograph）套印风格，粉 = 人类评委，蓝 = AI 评委，叠印紫 = 两边都获奖，黄 = 鱼竿奖；每部作品一张手写 SVG 封面（`art/`），展示字体为得意黑子集

## 本地构建

```bash
# 原稿 → 段落 JSON → 清洗（产物已在 content/works/，一般不需要重跑）
python3 -I scripts/convert.py <原稿目录> <临时目录> && python3 -I scripts/clean.py <临时目录>

# 生成站点（字体子集化后需再构建一次以更新字体哈希）
python3 -I scripts/build.py && python3 -I scripts/export.py && python3 -I scripts/fonts.py && python3 -I scripts/og.py && python3 -I scripts/build.py

# 本地运行（需要 .dev.vars 中的 SALT / ADMIN_TOKEN）
npx wrangler d1 execute haibao --local -c wrangler.worker.jsonc --file=schema.sql
npx wrangler dev -c wrangler.worker.jsonc --local
bash scripts/test_api.sh http://localhost:8787

# 部署
npx wrangler deploy -c wrangler.worker.jsonc
```

## 目录

- `data/works.json`：获奖名单与作品元数据；`data/commentary.json`：督工点评摘要
- `content/works/`：清洗后的正文（段落块 + 行内格式区间）
- `art/`：封面与首页插画（规范见 `art/STYLE.md`）、附录截图
- `scripts/`：转换、清洗、构建、导出、字体子集化、分享图；`scripts/assets/`：站点 CSS/JS
- `functions/`、`src/`：API；`schema.sql`、`scripts/migrate_views.sql`：数据库
- `SPEC.md`：设计与接口规格

## 版权

- 代码、样式、脚本与原创插画：MIT（见 `LICENSE`）
- 获奖小说正文与作者创作说明：版权归各作品作者所有
- 节目点评摘要引自《睡前消息》第 1130 期，以原视频为准
- 展示字体「得意黑」：SIL Open Font License 1.1

发现错字、排版问题或有建议，欢迎提 Issue，或写信给 ironieser@gmail.com。
