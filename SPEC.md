# 海豹杯 2026 获奖作品站 — 规格

站点：`scifi.ironieser.cc`。托管：Cloudflare Pages（静态）+ Pages Functions（`/api/*`）+ D1（数据库名 `haibao`，binding `DB`）。
读者主要在中国大陆：**不得引用 Google Fonts / 任何第三方 CDN**，所有资源自托管、同源。

## 目录约定
```
data/works.json            比赛、评审团、奖项、作品元数据（已存在，只读）
content/works/<id>.json    清洗后的正文（已存在，只读）
  { id, chars, statements:[作者AI声明], toc:[章节标题], body:[block], notes:[{title, body:[block]}] }
  block: {t:"p",x} 段落 | {t:"h",x} 章节标题 | {t:"c",x} 居中短行 | {t:"hr"} 分隔 | {t:"table",rows:[[cell]]}
  段落文本里可能含 **粗体** Markdown，需要渲染为 <strong>，其余一律 HTML 转义。
scripts/build.py           生成 dist/ 下的 HTML/CSS/JS（前端代理负责）
scripts/export.py          生成 dist/downloads/<id>.txt 与 <id>.epub，以及 dist/downloads/haibao2026-all.zip（下载代理负责）
scripts/fonts.py           子集化得意黑 → dist/assets/fonts/smiley-sans.woff2（下载代理负责）
functions/api/[[path]].js  Pages Functions（后端代理负责）
schema.sql, wrangler.toml  （后端代理负责）
dist/                      最终部署目录（Pages build output）
```
所有 Python 用 `python3 -I` 运行，仅用标准库（fontTools 已安装，可用于字体脚本）。
构建入口：`make` 或 `python3 -I scripts/build.py && python3 -I scripts/export.py && python3 -I scripts/fonts.py`。
build.py 不能删除 dist/downloads 和 dist/assets/fonts（其他脚本的产物），只覆盖自己的文件。

## 隐私
正文已清洗。不得展示作者真实姓名以外的个人信息；**不提供原始 docx/pdf 下载**。作者名以 works.json 为准（官方名单）。

## 设计方向：「两个评审团的套印」
孔版印刷（Risograph）双色套印。人类评委 = 荧光粉，AI评委 = 蓝；两边都获奖的作品，两色用 `mix-blend-mode: multiply` 叠印成紫。鱼竿奖 = 黄。
这是整页唯一的大胆元素，其余克制、安静。

色彩 token（CSS 变量，`:root` 定义，深色模式下重定义）：
- `--paper: #EEEFEA` 冷灰白纸（深色：`#17192B`）
- `--ink: #1E2140` 深海军蓝油墨，正文与线条（深色：`#E6E7EE`）
- `--pink: #FF48B0` 人类评委（riso Fluorescent Pink）
- `--blue: #0078BF` AI评委（riso Blue）
- `--yellow: #FFE800` 鱼竿奖（riso Yellow）
- `--muted: #6B6E85` 次要文字
深色模式下套印改用 `mix-blend-mode: screen`。

字体：
- 展示字体（站名、作品标题、作者名、奖项、数字）：`"Smiley Sans", "PingFang SC", "Microsoft YaHei", sans-serif`，`@font-face` 指向 `/assets/fonts/smiley-sans.woff2`，`font-display: swap`。
- 界面文字：`-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`
- 正文阅读：`"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif`，字号 18px 起，行高 1.9，段首缩进 2em，行长 ≤ 36em。阅读设置可切换为无衬线。

避免：全大写标签、每个标题上方的小 eyebrow 标签、"A · B · C" 中点拼接、按钮文字后加 →、千篇一律的圆角卡片+阴影、到处的淡入动画。只允许一个页面加载动画：首页大标题两色版"套准"（粉、蓝两层从错位滑到轻微错位）。尊重 prefers-reduced-motion。

## 页面
1. `/index.html` 首页
   - 顶栏：站名「海豹杯 2026」；导航：获奖名单 / 全部作品 / 我的收藏。
   - Hero：超大的「海豹杯科幻文学大赛」（套印效果），一行说明：2026 年获奖作品集，18 部作品，两个评审团，奖金合计 301,072 元（由 works.json 计算）。主按钮「阅读特别奖《回到明天》」，次按钮「查看获奖名单」。
   - 「两份名单」对照图：左列人类评委名次，右列 AI 评委名次，同一作品之间连线（只在两边都获奖时有连线，紫色叠印），只有一边获奖的作品单独列出。SVG 或 CSS 实现，手机上改为纵向列表。点击作品进入作品页。
   - 获奖名单：三个分区（人类评委奖 / AI评委奖 / 鱼竿奖），每个奖级显示奖金（"奖金各 x 元" 当 each=true），作品名《》+作者，链接到作品页。
   - 全部作品：每部一行（不是卡片网格），显示标题、作者、获奖色点（粉/蓝/黄）、字数（如 4.9 万字）、是否使用 AI 辅助、点赞数、评论数（数字由 /api/stats 异步填入，失败时隐藏）。筛选：全部 / 两个评审团都获奖 / 未使用 AI。排序：默认（按奖项）/ 最多点赞 / 字数。
   - 页脚：「2026年海豹杯科幻文学大赛获奖名单」由马督工于 2026年11月14日 20:17 发布；AI 辅助说明原文（works.json 的 contest.aiNote）；「作品版权归作者所有，本站仅供阅读与交流」。
2. `/works/<id>/index.html` 作品页（18 个，静态生成，正文直接写在 HTML 里，利于 SEO 和首屏）
   - 标题、作者、获奖标签（粉/蓝/黄印章样式，含奖级与奖金）、字数与预计阅读时长（按 500 字/分钟）。
   - 操作条：点赞（计数）、收藏、下载（TXT / EPUB）、分享（复制链接；支持 navigator.share）。
   - 作者声明（statements 非空时显示）；未使用 AI 的作品显示「作者未使用 AI 辅助」。
   - 目录（toc 非空且 ≥2 时显示，可折叠，章节锚点 id=`ch-<序号>`）。
   - 正文；阅读设置（字号 A-/A+、衬线/无衬线、浅色/深色），存 localStorage。顶部阅读进度条。记住阅读位置（localStorage），再次进入提示「继续上次阅读」。
   - notes（创作说明/AI 使用记录）以折叠区块显示在正文后。
   - 讨论区（评论列表 + 发表评论 + 回复 + 评论点赞）。
   - 上一部 / 下一部。
3. `/favorites/index.html` 我的收藏：读取 localStorage 收藏列表，展示作品（标题数据从内嵌 JSON）；空状态写「还没有收藏。在作品页点「收藏」，作品会出现在这里。」
4. `/404.html`

## 前端本地状态（localStorage，全部 try/catch 包裹）
- `hb.device`：随机 UUID（crypto.randomUUID），首次访问生成。
- `hb.liked`：作品 id 数组；`hb.faved`：作品 id 数组；`hb.clikes`：评论 id 数组。
- `hb.read.<id>`：阅读位置（0–1 的比例）。`hb.prefs`：{size, font, theme}。
- `hb.name`：上次使用的昵称。

## API（Pages Functions，JSON，同源）
所有 POST 请求体为 JSON，包含 `device`（字符串 8–64 位 [A-Za-z0-9-]）。服务器用 `SHA-256(SALT + device)` 作为 actor，IP 用 `SHA-256(SALT + CF-Connecting-IP)`。`SALT` 为环境变量（secret），本地 dev 用 `.dev.vars`。作品 id 必须在白名单（18 个 id，写死在 functions 中）内，否则 404。

- `GET /api/stats` → `{ works: { [id]: { likes, favs, comments } } }`。边缘缓存 30 秒（Cache API + `Cache-Control: public, max-age=30`）。
- `POST /api/works/:id/like` `{device, on:boolean}` → `{ on, likes }`。幂等：on=true 插入（已存在则不变），on=false 删除。
- `POST /api/works/:id/fav` `{device, on}` → `{ on, favs }`。
- `GET /api/works/:id/comments?before=<id>&limit=30` → `{ comments:[{id, parent, name, body, created, likes}], more:boolean }`，按 id 倒序，只返回顶层评论；每条顶层评论附带 `replies:[...]`（按时间正序，最多 50 条）。已删除评论不返回。缓存 5 秒。
- `POST /api/works/:id/comments` `{device, name, body, parent?}` → `{ comment }`。校验：name 1–20 字（去首尾空白，默认「匿名读者」），body 2–1000 字；parent 必须是同作品顶层评论。限流：同一 IP 15 秒内 1 条、每天 50 条；同一 device 每天 50 条。超限返回 429 `{error:"发言太快了，请 15 秒后再试"}` 之类明确的中文错误。去掉控制字符。
- `POST /api/comments/:cid/like` `{device, on}` → `{ on, likes }`。
- `DELETE /api/comments/:cid`：请求头 `Authorization: Bearer <ADMIN_TOKEN>`（环境变量）或请求体 device 与发表者一致 → 软删除，`{ok:true}`。
- 错误统一 `{error: "中文说明"}` + 合适状态码。
- `POST /api/hit` `{page, device, work?, hot?, recent?, series?}` → `{views:{total, today:{pv,uv}, pages}, stats:{works}, hot?, recent?, series?}`。**页面打开时唯一的请求**：记一次浏览（内存批量写入）并返回本页需要的公开数据；hot 仅作品页且读者未关闭「热门划线」（前端传 `hot:false`），recent 仅首页，series（近 30 天）仅 /stats/。各部分仍按各自的边缘缓存键缓存（与下列 GET 接口共用），未命中的部分合并成一个 D1 batch。白名单外的页面记为 `other`。同一 IP 每分钟 120 次（isolate 内存计数）。
- `GET /api/works/:id/hot` → `{threshold, readers, segs:[{p,s,e,n}]}`，缓存 60 秒。阈值 `max(3, ceil(0.02 × 有划线读者数))`，每部作品最多 50 个片段（n 最高者）。
- `POST /api/works/:id/hot` `{device, items:[{p, segs:[[s,e],...]}]}` → `{ok, done:[p], failed:[p]}`。某段划线集合变化时上传该段区间并集（空数组 = 撤销）；只传区间，不传笔记与原文。校验：1–30 段、p 1–5000、每段 ≤ 20 个区间、`0 ≤ s < e ≤ 5000` 整数。限流：同一设备每天 300 段次（与旧接口共用）。
- `GET /api/views/series` → `{series:[{day,pv,uv}]}`（30 天），缓存 300 秒。
- 旧接口 `POST /api/view`、`GET /api/views`、`GET /api/stats`、`GET /api/comments/recent`、`GET/POST /api/works/:id/marks` 保留（兼容已缓存的旧页面），新前端不再调用（评论列表仍按需 GET）。
- 所有 /api 响应在出口统一重设 `Cache-Control`（可缓存的为 `public, max-age=<短 TTL>`，其余 `no-store`），不沿用边缘缓存命中时带回的头；前端 GET 用 `cache:'no-cache'`。
- 写接口另有 IP 软限流：点赞 + 收藏 + 评论点赞 + 划线同步合计每 IP 每天 2000 次；评论为「设备 15 秒 1 条、每天 50 条」+「IP 15 秒 5 条、每天 300 条」。

D1 表（schema.sql）：
```sql
CREATE TABLE IF NOT EXISTS reactions (work TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (work, kind, actor));
CREATE TABLE IF NOT EXISTS counters (work TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (work, kind));
CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, work TEXT NOT NULL, parent INTEGER, name TEXT NOT NULL, body TEXT NOT NULL, actor TEXT NOT NULL, ip TEXT NOT NULL, created INTEGER NOT NULL, likes INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS comments_work ON comments (work, parent, deleted, id);
CREATE TABLE IF NOT EXISTS comment_likes (cid INTEGER NOT NULL, actor TEXT NOT NULL, PRIMARY KEY (cid, actor));
CREATE TABLE IF NOT EXISTS ratelimit (key TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL);
```
counters.kind ∈ {like, fav, comment}。
增量表（见 schema.sql，均 `CREATE ... IF NOT EXISTS`）：`view_totals`（每页累计 PV）与 `views` 中 `page='*'` 的每日全站行（已有数据用 `scripts/migrate_views.sql` 回填，可重复执行）；片段级热门划线 `mark_ranges`（每读者每段的区间并集）、`hot_cov`（每段覆盖计数游程编码 + maxn + 并发令牌 tok，部分索引 `hot_cov_top (work, maxn) WHERE maxn >= 3`）、`mark_actors` / `work_highlighters`（有划线的读者数）。
前端本地状态另有：`hb.hotq.<id>` 待同步到热门划线的段落编号；`hb.hotv.<id>` 已有划线已整体同步过一次的标记。

## 质量底线
手机宽度可用（16px 边距，无横向滚动）；键盘焦点可见；对比度合格；无 JS 时正文与名单照常可读（交互降级）；HTML `lang="zh-CN"`，每页有 `<title>`、description、Open Graph。
