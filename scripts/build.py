"""生成静态站点到 dist/。

用法：python3 -I scripts/build.py
只用标准库。读取 data/works.json 与 content/works/*.json，写出：
  dist/index.html, dist/works/<id>/index.html, dist/favorites/index.html, dist/notes/index.html, dist/404.html,
  dist/assets/site.css, dist/assets/site.js, dist/_headers, dist/robots.txt,
  dist/sitemap.xml, dist/favicon.svg
不会删除 dist/downloads/ 与 dist/assets/fonts/（其他脚本的产物）。
"""
import base64
import hashlib
import html
import json
import re
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "works.json"
CONTENT = ROOT / "content" / "works"
SRC = Path(__file__).resolve().parent / "assets"
ART = ROOT / "art"
DIST = ROOT / "dist"
SITE = "https://scifi.ironieser.cc"
FONT_PATH = "/assets/fonts/smiley-sans.woff2"

JURY_SHORT = {"human": "人类评委", "ai": "AI评委", "rod": "鱼竿奖"}
JURY_MARK = {"human": "h", "ai": "a", "rod": "r"}


# ---------------------------------------------------------------- helpers
def esc(s):
    return html.escape(str(s), quote=True)


BOLD = re.compile(r"\*\*(.+?)\*\*", re.S)


def inline(s):
    """HTML 转义，**x** 转 <strong>，不成对的 ** 直接去掉。"""
    out, pos = [], 0
    for m in BOLD.finditer(s):
        out.append(esc(s[pos:m.start()].replace("**", "")))
        out.append("<strong>" + esc(m.group(1)) + "</strong>")
        pos = m.end()
    out.append(esc(s[pos:].replace("**", "")))
    return "".join(out)


def plain(s):
    return s.replace("**", "")


def money(n):
    return f"{n:,}"


def sha8(b):
    return hashlib.sha1(b).hexdigest()[:8]


def fmt_chars(n):
    if n >= 10000:
        return f"{n / 10000:.1f} 万字"
    return f"{n} 字"


def fmt_minutes(chars):
    m = max(1, round(chars / 500))
    if m >= 60:
        h, r = divmod(m, 60)
        return f"约 {h} 小时 {r} 分钟" if r else f"约 {h} 小时"
    return f"约 {m} 分钟"


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = text.encode("utf-8") if isinstance(text, str) else text
    if path.exists() and path.read_bytes() == data:
        return
    path.write_bytes(data)


# ---------------------------------------------------------------- data
def load():
    meta = json.loads(DATA.read_text("utf-8"))
    works = meta["works"]
    by_id = {w["id"]: w for w in works}
    for i, w in enumerate(works):
        w["order"] = i
        w["awards"] = []
        w["content"] = json.loads((CONTENT / f"{w['id']}.json").read_text("utf-8"))
        w["chars"] = w["content"]["chars"]
    total = 0
    for jury in meta["juries"]:
        jsum = 0
        for tier in jury["tiers"]:
            for wid in tier["works"]:
                by_id[wid]["awards"].append({
                    "jury": jury["id"], "jury_name": jury["name"],
                    "tier": tier["id"], "tier_name": tier["name"],
                    "prize": tier["prize"], "each": tier["each"],
                })
                jsum += tier["prize"]
                total += tier["prize"]
        jury["sum"] = jsum
    meta["total_prize"] = total
    for w in works:
        js = {a["jury"] for a in w["awards"]}
        w["both"] = "human" in js and "ai" in js
    return meta, works, by_id


def award_label(a):
    """短标签：粉/蓝/黄点 + 奖级。"""
    if a["jury"] == "rod":
        return "鱼竿奖"
    return a["tier_name"]


def award_full(a):
    if a["jury"] == "rod":
        return "鱼竿奖"
    return a["jury_name"].replace("奖", "") + a["tier_name"]


def award_tag(a):
    """首页获奖标签：色块里写评审团（人 / AI），后面写奖级；鱼竿奖整块黄色。读屏读作「人类评委特别奖」。"""
    if a["jury"] == "rod":
        return '<span class="tg tg-r">鱼竿奖</span>'
    j, short = ("h", "人") if a["jury"] == "human" else ("a", "AI")
    return (f'<span class="tg tg-{j}"><b aria-hidden="true">{short}</b>'
            f'<span class="sr">{esc(JURY_SHORT[a["jury"]])}</span>{esc(a["tier_name"])}</span>')


def marks_html(w, cls="mark"):
    out = []
    for a in w["awards"]:
        j = JURY_MARK[a["jury"]]
        sr = "" if a["jury"] == "rod" else f'<span class="sr">{esc(JURY_SHORT[a["jury"]])}</span>'
        out.append(f'<span class="{cls} {cls}-{j}">{sr}{esc(award_label(a))}</span>')
    return "".join(out)


# ---------------------------------------------------------------- art (covers / hero)
TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S)


def art_alt(svg_path, fallback):
    txt = svg_path.with_suffix(".txt")
    if txt.exists():
        t = " ".join(txt.read_text("utf-8").split())
        if t:
            return t
    m = TITLE_RE.search(svg_path.read_text("utf-8", errors="replace"))
    if m:
        return " ".join(html.unescape(m.group(1)).split())
    return fallback


def build_art(works):
    """复制 art/covers/<id>.svg 与 art/hero.svg 到 dist/assets/；缺失时跳过（页面用 CSS 占位块）。"""
    out_dir = DIST / "assets" / "covers"
    for w in works:
        src = ART / "covers" / f"{w['id']}.svg"
        w["cover"] = None
        if src.exists():
            data = src.read_bytes()
            write(out_dir / src.name, data)
            w["cover"] = {"src": f"/assets/covers/{src.name}?v={sha8(data)}",
                          "alt": art_alt(src, f"《{plain(w['title'])}》封面")}
    hero = ART / "hero.svg"
    if hero.exists():
        data = hero.read_bytes()
        write(DIST / "assets" / "hero.svg", data)
        return {"src": f"/assets/hero.svg?v={sha8(data)}", "alt": art_alt(hero, "")}
    return None


def ph_class(w):
    js = {a["jury"] for a in w["awards"]}
    k = "both" if w["both"] else ("h" if "human" in js else "a")
    return f"cover cover-ph ph-{k}" + (" ph-rod" if "rod" in js else "")


def cover_html(w, cls, width, height, alt=True, eager=False):
    c = w.get("cover")
    if not c:
        return f'<span class="{ph_class(w)} {cls}" aria-hidden="true"></span>'
    a = esc(c["alt"]) if alt else ""
    load = 'loading="eager" fetchpriority="high"' if eager else 'loading="lazy"'
    return (f'<img class="cover {cls}" src="{esc(c["src"])}" alt="{a}" width="{width}" height="{height}" '
            f'{load} decoding="async">')


# ---------------------------------------------------------------- body rendering
TAGS = (("b", "<strong>", "</strong>"), ("i", "<em>", "</em>"), ("u", "<u>", "</u>"),
        ("code", '<code class="ic">', "</code>"))
TAG_RE = re.compile(r"<[^>]+>")
ORDERED_MK = re.compile(r"^(\d+)[.)]$")


def rich_html(x, m=None):
    """纯文本 x + 格式区间 m -> HTML。按区间边界切片，每片包上覆盖它的全部标签（固定嵌套顺序），
    所以重叠区间也能正确嵌套；渲染结果的 textContent 严格等于 x（划线偏移依赖这一点）。"""
    if not m:
        out = esc(x)
    else:
        cuts = sorted({0, len(x)} | {c for s, e, _ in m for c in (s, e) if 0 <= c <= len(x)})
        out = []
        for a, b in zip(cuts, cuts[1:]):
            kinds = {k for s, e, k in m if s <= a and e >= b}
            seg = esc(x[a:b])
            for k, op, cl in reversed(TAGS):
                if k in kinds:
                    seg = op + seg + cl
            out.append(seg)
        out = "".join(out)
    assert html.unescape(TAG_RE.sub("", out)) == x, x[:40]
    return out


def figure_html(b):
    src = ART / "notes" / b["src"]
    v = f"?v={sha8(src.read_bytes())}" if src.exists() else ""
    return (f'<figure class="fig"><img src="/assets/notes/{esc(b["src"])}{v}" width="{int(b.get("w") or 0)}" '
            f'height="{int(b.get("h") or 0)}" loading="lazy" decoding="async" alt="原文截图"></figure>')


def render_blocks(blocks, chapter_ids=True, note_prefix=None):
    """正文块 -> HTML。
    · 连续同 cls 的块包进 <div class="blk blk-<cls>">；连续 li 包进 <ul>/<ol>，lvl 1 嵌在 <li class="li-sub"> 里；
    · 正文（chapter_ids=True）里每个可划线的文本块（p、li，含带 cls 的）按顺序编 id="p-N"，c 与 h 不编号；
    · 带 cls 的标题（区块内的小标题）不编 ch-N，与 clean.py 的目录一致。"""
    out, ch, pi = [], 0, 0
    cur_cls = None
    lists = []  # 打开的列表栈：[(tag, lvl)]

    def close_lists(to=0):
        while len(lists) > to:
            tag, lvl = lists.pop()
            out.append(f"</{tag}>" + ("</li>" if lvl == 1 else ""))

    def pid():
        nonlocal pi
        if not chapter_ids:
            return ""
        pi += 1
        return f' id="p-{pi}"'

    for b in blocks:
        t = b.get("t")
        cls = b.get("cls")
        if t != "li":
            close_lists()
        if cls != cur_cls:
            close_lists()
            if cur_cls:
                out.append("</div>")
            if cls:
                out.append(f'<div class="blk blk-{esc(cls)}">')
            cur_cls = cls
        if t == "p":
            out.append(f'<p{pid()}>{rich_html(b["x"], b.get("m"))}</p>')
        elif t == "li":
            lvl = 1 if b.get("lvl") == 1 else 0
            om = ORDERED_MK.match(b.get("mk") or "")
            tag = "ol" if om else "ul"
            if lvl == 1 and not lists:
                lists.append(("ul", 0))
                out.append('<ul class="lst">')
            if lists and lists[-1][1] > lvl:
                close_lists(1)
            if lists and lists[-1][1] == lvl and lists[-1][0] != tag:
                close_lists(len(lists) - 1)
            if not lists or lists[-1][1] < lvl:
                start = f' start="{om.group(1)}"' if om and om.group(1) != "1" else ""
                sub = '<li class="li-sub">' if lvl == 1 else ""
                out.append(f'{sub}<{tag} class="lst lst-{lvl}"{start}>')
                lists.append((tag, lvl))
            out.append(f'<li{pid()}>{rich_html(b["x"], b.get("m"))}</li>')
        elif t == "h":
            if cls:
                out.append(f'<h3 class="bh">{rich_html(b["x"], b.get("m"))}</h3>')
            elif chapter_ids:
                ch += 1
                out.append(f'<h2 class="ch" id="ch-{ch}">{rich_html(b["x"], b.get("m"))}'
                           f'<a class="anc" href="#ch-{ch}" aria-label="本章链接">#</a></h2>')
            else:
                out.append(f'<h3 class="nh">{rich_html(b["x"], b.get("m"))}</h3>')
        elif t == "c":
            out.append(f'<p class="cc">{rich_html(b["x"], b.get("m"))}</p>')
        elif t == "hr":
            out.append('<p class="sep" role="separator" aria-label="分隔">＊＊＊</p>')
        elif t == "img":
            out.append(figure_html(b))
        elif t == "table":
            rows = b.get("rows") or []
            if not rows:
                continue
            head, *rest = rows
            th = "".join(f'<th scope="col">{esc(c)}</th>' for c in head)
            trs = "".join("<tr>" + "".join(
                (f'<td class="nw">{esc(c)}</td>' if len(c) <= 12 else f"<td>{esc(c)}</td>") for c in r)
                + "</tr>" for r in rest)
            out.append(f'<div class="tbl" role="region" aria-label="表格" tabindex="0"><table>'
                       f"<thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div>")
    close_lists()
    if cur_cls:
        out.append("</div>")
    return "\n".join(out)


def copy_note_images():
    """附录截图 art/notes/<id>/<n>.jpg -> dist/assets/notes/（与 convert.py 的输出同步，多余的旧图删掉）。"""
    src_root, dst_root = ART / "notes", DIST / "assets" / "notes"
    keep = set()
    if src_root.exists():
        for f in sorted(src_root.rglob("*.jpg")):
            rel = f.relative_to(src_root)
            keep.add(rel)
            dst = dst_root / rel
            data = f.read_bytes()
            if not dst.exists() or dst.read_bytes() != data:
                write(dst, data)
    if dst_root.exists():
        for f in dst_root.rglob("*.jpg"):
            if f.relative_to(dst_root) not in keep:
                f.unlink()


TOC_MAJOR = re.compile(r"^[一二三四五六七八九十百]+、")


def toc_entries(toc):
    """返回 [(序号, 标题)]；目录过长且混有报告字段时只保留「一、二、」式大节。"""
    items = list(enumerate(toc, 1))
    if len(items) > 20:
        major = [(i, t) for i, t in items if TOC_MAJOR.match(t)]
        if len(major) >= 2:
            items = major
    return items


def excerpt(content, n=88):
    buf = ""
    for b in content["body"]:
        if b.get("t") != "p":
            continue
        x = plain(b["x"]).strip()
        if not x or (x.startswith("（") and x.endswith("）")):
            continue
        buf += x
        if len(buf) >= n:
            break
    buf = re.sub(r"\s+", "", buf)
    return buf[:n] + ("…" if len(buf) > n else "")


# ---------------------------------------------------------------- icons
SEAL_SVG = (
    '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">'
    '<rect x="2" y="4" width="20" height="20" rx="3" transform="rotate(-6 12 14)" fill="#FF48B0"/>'
    '<g style="mix-blend-mode:multiply" opacity=".85">'
    '<ellipse cx="19.5" cy="19" rx="10" ry="9" fill="#0078BF"/></g>'
    '<circle cx="16" cy="17" r="1.5" fill="#EEEFEA"/><circle cx="22.5" cy="17" r="1.5" fill="#EEEFEA"/>'
    '<ellipse cx="19.3" cy="20.6" rx="1.6" ry="1.1" fill="#1E2140"/>'
    '<path d="M13 21.5l-3.5-.6M13 23l-3.4.7M25.6 21.5l3.5-.6M25.6 23l3.4.7" stroke="#1E2140" '
    'stroke-width=".9" stroke-linecap="round"/>'
    "</svg>"
)

FAVICON = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect x="2" y="4" width="20" height="20" rx="3" transform="rotate(-6 12 14)" fill="#FF48B0"/>
<g style="mix-blend-mode:multiply" opacity=".85"><ellipse cx="19.5" cy="19" rx="10" ry="9" fill="#0078BF"/></g>
<circle cx="16" cy="17" r="1.6" fill="#EEEFEA"/>
<circle cx="22.5" cy="17" r="1.6" fill="#EEEFEA"/>
<ellipse cx="19.3" cy="20.6" rx="1.7" ry="1.2" fill="#1E2140"/>
<path d="M13 21.5l-3.5-.6M13 23l-3.4.7M25.6 21.5l3.5-.6M25.6 23l3.4.7" stroke="#1E2140" stroke-width="1" stroke-linecap="round"/>
</svg>
"""

ICON = {
    "heart": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
    "star": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16l-5-3.6L7 20z"/></svg>',
    "down": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>',
    "share": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4M6 12v8h12v-8"/></svg>',
}

# 首屏前执行：应用阅读偏好（主题/背景/字体/字号/行距/页宽/对齐），并标记 JS 可用。
# 取值与 site.js 的 prefs() 一致。CSP 用 HEAD_JS_HASH 放行：改动这里后哈希自动重算并写入 dist/_headers。
HEAD_JS = ("(function(){var d=document.documentElement;d.className+=' js';try{"
           "var p=JSON.parse(localStorage.getItem('hb.prefs')||'{}')||{};"
           "if(p.theme==='light'||p.theme==='dark')d.setAttribute('data-theme',p.theme);"
           "if(p.font==='sans'||p.font==='kai')d.setAttribute('data-font',p.font);"
           "var s=parseInt(p.size,10);if(s>=14&&s<=26)d.style.setProperty('--read-size',s+'px');"
           "if(p.lh==='tight'||p.lh==='loose')d.setAttribute('data-lh',p.lh);"
           "if(p.width==='narrow'||p.width==='wide')d.setAttribute('data-width',p.width);"
           "if(p.bg==='green'||p.bg==='sepia')d.setAttribute('data-bg',p.bg);"
           "if(p.justify===false)d.setAttribute('data-justify','off');"
           "}catch(e){}})();")
HEAD_JS_HASH = "sha256-" + base64.b64encode(hashlib.sha256(HEAD_JS.encode()).digest()).decode()


# ---------------------------------------------------------------- page shell
class Ctx:
    css_v = js_v = ""
    font_v = ""
    meta = None


def og_image_tags(path):
    """分享预览图：作品页用 /assets/og/<id>.jpg，其余页面用首页图（文件由 scripts/og.py 生成）。"""
    m = re.match(r"^/works/([a-z0-9-]+)/", path)
    name = m.group(1) if m else "home"
    f = DIST / "assets" / "og" / f"{name}.jpg"
    if not f.exists():
        return '<meta name="twitter:card" content="summary">'
    src = f"{SITE}/assets/og/{name}.jpg?v={sha8(f.read_bytes())}"
    return (f'<meta property="og:image" content="{src}">\n'
            '<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n'
            f'<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="{src}">')


EXTRA_ASSETS = ("prose.css", "reader.css", "reader.js", "share.css", "share.js", "vendor/qrcode.js")


def extra_asset_tags(names=EXTRA_ASSETS):
    """作品页额外资源：阅读增强（reader.*）与分享（share.*、vendor/qrcode.js）。源文件在 scripts/assets/，缺失则跳过。
    「我的笔记」页只用 reader.*。"""
    tags = []
    for name in names:
        src = ROOT / "scripts" / "assets" / name
        if not src.exists():
            continue
        data = src.read_bytes()
        write(DIST / "assets" / name, data)
        url = f"/assets/{name}?v={sha8(data)}"
        tags.append(f'<link rel="stylesheet" href="{url}">' if name.endswith(".css")
                    else f'<script src="{url}" defer></script>')
    return "\n".join(tags)


def shell(ctx, *, title, desc, path, page, body, body_attrs="", og_type="website", extra_head=""):
    url = SITE + path
    font_preload = ""
    if ctx.font_v:
        font_preload = (f'<link rel="preload" href="{FONT_PATH}?v={ctx.font_v}" as="font" '
                        f'type="font/woff2" crossorigin>\n')
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{esc(url)}">
<meta property="og:type" content="{og_type}">
<meta property="og:site_name" content="海豹杯 2026 获奖作品集">
<meta property="og:locale" content="zh_CN">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:url" content="{esc(url)}">
{og_image_tags(path)}
<meta name="theme-color" content="#EEEFEA" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#17192B" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
{font_preload}<link rel="stylesheet" href="/assets/site.css?v={ctx.css_v}">
<script>{HEAD_JS}</script>
<script src="/assets/site.js?v={ctx.js_v}" defer></script>
<script src="/assets/views.js?v={getattr(ctx, 'views_v', '')}" defer></script>
{extra_head}</head>
<body data-page="{page}"{body_attrs}>
<a class="skip" href="#main">跳到正文</a>
{masthead(page)}
{body}
{footer(ctx)}
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
</body>
</html>
"""


def masthead(page):
    cur = lambda p: ' aria-current="page"' if page == p else ""
    # 窄屏只显示后两个字（「名单 / 作品 / 收藏 / 笔记」），前缀对读屏软件仍可见
    ch = '<p class="mh-ch" id="mh-ch" aria-hidden="true"></p>\n' if page == "work" else ""
    return f"""<header class="masthead" id="masthead"><div class="wrap masthead-in">
<a class="brand" href="/">{SEAL_SVG}<span class="brand-t">海豹杯 2026</span></a>
{ch}<nav class="nav" aria-label="主导航"><a href="/#awards"><span class="nx">获奖</span>名单</a><a href="/#works"><span class="nx">全部</span>作品</a><a href="/favorites/"{cur("favorites")}><span class="nx">我的</span>收藏</a><a href="/notes/"{cur("notes")}><span class="nx">我的</span>笔记</a></nav>
</div></header>"""


def footer(ctx):
    c = ctx.meta["contest"]
    t = datetime.fromisoformat(c["announcedAt"])
    when = f"{t.year}年{t.month}月{t.day}日 {t:%H:%M}"
    return f"""<footer class="foot"><div class="wrap">
<p class="foot-ann">「{esc(c['name'])}获奖名单」由{esc(c['announcedBy'])}于 {esc(when)} 发布。</p>
<blockquote><p>{esc(c['aiNote'])}</p></blockquote>
<p class="foot-views" data-views-box hidden>全站累计浏览 <b data-views="total"></b> 次，今日 <b data-views="today-uv"></b> 位读者。<a href="/stats/">访问统计</a></p>
<p>作品版权归作者所有，本站仅供阅读与交流。</p>
<p class="foot-font">展示字体：得意黑（<a href="/assets/fonts/OFL.txt">OFL</a>）。</p>
<div class="theme-sw js-only" role="group" aria-label="外观"><span>外观</span>
<button type="button" data-pref="theme" data-val="auto">跟随系统</button><button type="button" data-pref="theme" data-val="light">浅色</button><button type="button" data-pref="theme" data-val="dark">深色</button></div>
</div></footer>"""


def ovp(text_lines, tag="h1", cls="ovp", label=None):
    inner = "".join(f'<span class="ovp-l">{esc(x)}</span>' for x in text_lines)
    return (f'<{tag} class="{cls}"><span class="ovp-pink">{inner}</span>'
            f'<span class="ovp-blue" aria-hidden="true">{inner}</span></{tag}>')


# ---------------------------------------------------------------- home: duel chart
def duel_layout(meta, by_id):
    """左：人类评委名次；右：AI评委名次。同一奖级内重排以减少连线交叉（奖级内不分先后）。"""
    human = next(j for j in meta["juries"] if j["id"] == "human")
    ai = next(j for j in meta["juries"] if j["id"] == "ai")
    h_set = {w for t in human["tiers"] for w in t["works"]}
    a_set = {w for t in ai["tiers"] for w in t["works"]}
    # 先按官方顺序得到初始位置
    def flat(j):
        return [w for t in j["tiers"] for w in t["works"]]
    hpos = {w: i for i, w in enumerate(flat(human))}
    apos = {w: i for i, w in enumerate(flat(ai))}
    # 右侧：每个奖级里，双获奖作品按左侧位置排在前面
    a_tiers = []
    for t in ai["tiers"]:
        ws = sorted(t["works"], key=lambda w: (0, hpos[w]) if w in h_set else (1, apos[w]))
        a_tiers.append((t, ws))
    apos = {w: i for i, w in enumerate(w for _, ws in a_tiers for w in ws)}
    h_tiers = []
    for t in human["tiers"]:
        ws = sorted(t["works"], key=lambda w: (0, apos[w]) if w in a_set else (1, hpos[w]))
        h_tiers.append((t, ws))
    return human, ai, h_tiers, a_tiers, h_set, a_set


def rod_ids(meta):
    rod = next((j for j in meta["juries"] if j["id"] == "rod"), None)
    return [w for t in rod["tiers"] for w in t["works"]] if rod else []


def duel_svg(meta, by_id):
    human, ai, h_tiers, a_tiers, h_set, a_set = duel_layout(meta, by_id)
    rods = set(rod_ids(meta))
    # 宽度 960：桌面上约 1:1.1 显示，与网格左对齐；中间留出连线区
    W_, ROW, GAP, TOP = 960, 36, 18, 92
    XL_T, XL_D, XR_D, XR_T = 384, 396, 564, 576

    def positions(tiers):
        pos, tier_spans, y = {}, [], TOP
        for t, ws in tiers:
            y0 = y
            for w in ws:
                pos[w] = y
                y += ROW
            tier_spans.append((t, y0, y - ROW))
            y += GAP
        return pos, tier_spans, y

    hp, hspans, hy = positions(h_tiers)
    ap, aspans, ay = positions(a_tiers)
    H_ = max(hy, ay) - GAP - ROW + 26

    parts = [f'<svg class="duel-svg" viewBox="0 0 {W_} {H_}" role="group" '
             f'aria-labelledby="duel-h" aria-describedby="duel-desc">',
             # 鱼竿奖：作品名下压一道黄色（滤镜按文字实际宽度铺色，与字体无关）
             '<defs><filter id="d-rod-hl" x="-.06" y="-.1" width="1.12" height="1.3" primitiveUnits="objectBoundingBox">'
             '<feFlood x="-.03" y=".8" width="1.06" height=".26" flood-color="#FFE800" result="f"/>'
             '<feMerge><feMergeNode in="f"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>']
    # 列标题
    parts.append(f'<text class="d-col" x="{XL_T}" y="30" text-anchor="end">人类评委</text>')
    parts.append(f'<text class="d-col-sub" x="{XL_T}" y="54" text-anchor="end">{len(h_set)} 部作品，奖金 {money(human["sum"])} 元</text>')
    parts.append(f'<text class="d-col" x="{XR_T}" y="30">AI评委</text>')
    parts.append(f'<text class="d-col-sub" x="{XR_T}" y="54">{len(a_set)} 部作品，奖金 {money(ai["sum"])} 元</text>')
    parts.append(f'<line class="d-rule" x1="0" x2="{W_}" y1="68" y2="68"/>')

    def tier_label(t, y0, y1, side):
        prize = ("各 " if t["each"] else "") + money(t["prize"]) + " 元"
        if side == "L":
            x, anchor, bx = 0, "start", 104
        else:
            x, anchor, bx = W_, "end", W_ - 104
        out = [f'<text class="d-tier" x="{x}" y="{y0 + 2}" text-anchor="{anchor}">{esc(t["name"])}</text>',
               f'<text class="d-prize" x="{x}" y="{y0 + 19}" text-anchor="{anchor}">{esc(prize)}</text>']
        if y1 > y0:
            out.append(f'<line class="d-br" x1="{bx}" x2="{bx}" y1="{y0 - 10}" y2="{y1 + 10}"/>')
        else:
            out.append(f'<line class="d-br" x1="{bx}" x2="{bx}" y1="{y0 - 10}" y2="{y0 + 10}"/>')
        return "".join(out)

    for t, y0, y1 in hspans:
        parts.append(tier_label(t, y0, y1, "L"))
    for t, y0, y1 in aspans:
        parts.append(tier_label(t, y0, y1, "R"))

    # 作品：每部一个 <a>，包含左右标签与连线
    ids = sorted(set(hp) | set(ap), key=lambda w: by_id[w]["order"])
    links = []
    for wid in ids:
        w = by_id[wid]
        g = [f'<a href="/works/{wid}/" aria-label="{esc(w["title"])}，{esc(w["author"])}，'
             f'{esc("、".join(award_full(a) for a in w["awards"]))}">']
        if wid in hp and wid in ap:
            y1, y2 = hp[wid], ap[wid]
            x1, x2 = XL_D + 6, XR_D - 6
            mx = (x1 + x2) / 2
            d = f"M{x1} {y1} C{mx} {y1} {mx} {y2} {x2} {y2}"
            # 套印的轻微错位：蓝版相对粉版偏 2.2px
            d2 = f"M{x1} {y1 + 2.2} C{mx} {y1 + 2.2} {mx} {y2 + 2.2} {x2} {y2 + 2.2}"
            g.append(f'<path class="d-ln d-ln-h" d="{d}"/><path class="d-ln d-ln-a" d="{d2}"/>')
        rod = ' filter="url(#d-rod-hl)"' if wid in rods else ""
        if wid in hp:
            y = hp[wid]
            g.append(f'<rect class="d-hit" x="112" y="{y - 16}" width="{XL_D + 6 - 112}" height="32"/>')
            g.append(f'<text class="d-t" x="{XL_T}" y="{y}" dy=".36em" text-anchor="end"{rod}>{esc(w["title"])}</text>')
            g.append(f'<circle class="d-h" cx="{XL_D}" cy="{y}" r="5.5"/>')
        if wid in ap:
            y = ap[wid]
            g.append(f'<rect class="d-hit" x="{XR_D - 6}" y="{y - 16}" width="{W_ - 112 - XR_D + 6}" height="32"/>')
            g.append(f'<text class="d-t" x="{XR_T}" y="{y}" dy=".36em"{rod}>{esc(w["title"])}</text>')
            g.append(f'<circle class="d-a" cx="{XR_D}" cy="{y}" r="5.5"/>')
        g.append("</a>")
        links.append("".join(g))
    parts.extend(links)
    parts.append("</svg>")
    return "\n".join(parts)


def duel_list(meta, by_id):
    human, ai, h_tiers, a_tiers, h_set, a_set = duel_layout(meta, by_id)
    order_h = [w for _, ws in h_tiers for w in ws]
    order_a = [w for _, ws in a_tiers for w in ws]
    both = [w for w in order_h if w in a_set]
    only_h = [w for w in order_h if w not in a_set]
    only_a = [w for w in order_a if w not in h_set]

    def row(wid):
        w = by_id[wid]
        # 奖级与奖金都写成文字，颜色只是辅助（WCAG 1.4.1）
        ms = "".join(f'<li>{award_tag(a)}<span class="dl-p">{money(a["prize"])} 元</span></li>' for a in w["awards"])
        return (f'<li><a href="/works/{wid}/"><span class="t">{esc(w["title"])}</span>'
                f'<ul class="r">{ms}</ul></a></li>')

    def group(title, dot, ws):
        return (f'<li class="duel-group"><h3>{dot}{esc(title)}<span class="n">{len(ws)} 部</span></h3>'
                f'<ol>{"".join(row(w) for w in ws)}</ol></li>')

    return ('<ol class="duel-list">'
            + group("两边都获奖", '<span class="ovp-dots" aria-hidden="true"><i></i><i></i></span>', both)
            + group("只获人类评委奖", '<span class="sw sw-h" aria-hidden="true"></span>', only_h)
            + group("只获 AI 评委奖", '<span class="sw sw-a" aria-hidden="true"></span>', only_a)
            + "</ol>"), len(both), len(only_h), len(only_a)


# ---------------------------------------------------------------- home
BILI_RULES = "https://www.bilibili.com/video/BV1c2Ngz8Emd/"


def zip_size_label():
    """打包文件的实际大小（export.py 的产物；首次构建时可能还不存在）。"""
    z = DIST / "downloads" / "haibao2026-all.zip"
    if not z.exists():
        return ""
    return f"，约 {z.stat().st_size / 1_000_000:.1f} MB"


def pow2(n):
    e = n.bit_length() - 1
    return e if n == 1 << e else None


def home_facts(meta, works, by_id, n_both, n_h, n_a):
    """紧跟首屏的四格：每格一幅小图 + 一句话。图本身就是数据，不做装饰。"""
    ai = next(j for j in meta["juries"] if j["id"] == "ai")
    rods = rod_ids(meta)
    rod_tier = next(j for j in meta["juries"] if j["id"] == "rod")["tiers"][0]
    noai = [w for w in works if not w["ai"]]
    n_ai = len(works) - len(noai)

    # 1. 两份名单的重合：真正叠印出来的维恩图
    venn = (f'<svg class="f-venn" viewBox="0 0 200 92" role="img" '
            f'aria-label="只获人类评委奖 {n_h} 部，两边都获奖 {n_both} 部，只获 AI 评委奖 {n_a} 部">'
            '<text class="f-lb" x="56" y="11" text-anchor="middle">人类评委</text>'
            '<text class="f-lb" x="144" y="11" text-anchor="middle">AI 评委</text>'
            '<circle class="f-h" cx="78" cy="56" r="35"/><circle class="f-a" cx="122" cy="56" r="35"/>'
            f'<text class="f-n" x="58" y="56" dy=".35em" text-anchor="middle">{n_h}</text>'
            f'<text class="f-n" x="100" y="56" dy=".35em" text-anchor="middle">{n_both}</text>'
            f'<text class="f-n" x="142" y="56" dy=".35em" text-anchor="middle">{n_a}</text></svg>')

    # 2. AI 评委奖金：逐级减半的条
    top = max(t["prize"] for t in ai["tiers"])
    bars = []
    for t in ai["tiers"]:
        e = pow2(t["prize"])
        expo = f' = 2<sup>{e}</sup>' if e is not None else ""
        bars.append(f'<li><span class="b-k">{esc(t["name"])}</span>'
                    f'<i style="--w:{t["prize"] / top * 100:.2f}%" aria-hidden="true"></i>'
                    f'<span class="b-v">{t["prize"]}{expo}</span></li>')
    bars_html = f'<ol class="f-bars">{"".join(bars)}</ol>'

    # 3. 鱼竿奖作品：与对照图同样的黄线
    rod_html = ('<ul class="f-rod">' + "".join(
        f'<li><a href="/works/{wid}/">{esc(by_id[wid]["title"])}</a></li>' for wid in rods) + "</ul>")

    # 4. 18 格：实心 = 使用或声称使用 AI，空心 = 未使用
    cells = "".join('<i class="on"></i>' for _ in range(n_ai)) + "".join("<i></i>" for _ in noai)
    dots = (f'<p class="f-dots" role="img" aria-label="{len(works)} 部中 {n_ai} 部使用或声称使用 AI，'
            f'{len(noai)} 部未使用">{cells}</p>')
    noai_txt = "".join(f'<a href="/works/{w["id"]}/">《{esc(w["title"])}》</a>' for w in noai)

    def cell(cls, fig, h, p):
        return (f'<li class="fact {cls}"><div class="f-fig">{fig}</div>'
                f'<h3>{h}</h3><p>{p}</p></li>')

    return ('<section class="facts wrap" aria-label="这次评奖的几个特别之处"><ul class="facts-in">'
            + cell("fact-both", venn, f"两份名单只重合 {n_both} 部",
                   "同一批稿子，人类评委与 AI 评委的选择差别很大。")
            + cell("fact-pow", bars_html, "AI 评委的奖金是 2 的幂",
                   "从特别奖到三等奖，每降一级正好减半。")
            + cell("fact-rod", rod_html, "鱼竿奖：授人以渔",
                   f"奖励能教会后来者的 AI 写作方法，获奖作品附创作说明。{len(rods)} 部，"
                   f"各 {money(rod_tier['prize'])} 元。")
            + cell("fact-ai", dots, f"{len(works)} 部中 {n_ai} 部用了 AI",
                   f"未使用 AI 的 {len(noai)} 部：{noai_txt}")
            + "</ul></section>")


def book_html(w):
    tags = "".join(award_tag(a) for a in w["awards"])
    if not w["ai"]:
        tags += '<span class="tg tg-n">未用 AI</span>'
    js = {a["jury"] for a in w["awards"]}
    return (f'<li class="book" data-id="{w["id"]}" data-order="{w["order"]}" data-chars="{w["chars"]}" '
            f'data-both="{1 if w["both"] else 0}" data-ai="{1 if w["ai"] else 0}" data-rod="{1 if "rod" in js else 0}">'
            f'<a href="/works/{w["id"]}/">{cover_html(w, "b-cv", 240, 320, alt=False)}'
            f'<span class="b-t">{esc(w["title"])}</span><span class="b-a">{esc(w["author"])}</span>'
            f'<span class="b-tags">{tags}</span>'
            f'<span class="b-meta"><span>{fmt_chars(w["chars"])}</span>'
            f'<span data-views-box hidden>阅读 <b data-views-page="{w["id"]}"></b></span>'
            f'<span data-stat="likes" hidden>赞 <b class="n"></b></span>'
            f'<span data-stat="comments" hidden>评论 <b class="n"></b></span></span>'
            f"</a></li>")


def build_home(ctx, meta, works, by_id, hero_art=None):
    c = meta["contest"]
    total = meta["total_prize"]
    first = by_id["huidao-mingtian"]
    svg = duel_svg(meta, by_id)
    mlist, n_both, n_h, n_a = duel_list(meta, by_id)
    rods = rod_ids(meta)
    rod_tier = next(j for j in meta["juries"] if j["id"] == "rod")["tiers"][0]
    t = datetime.fromisoformat(c["announcedAt"])
    when = f"{t.year} 年 {t.month} 月 {t.day} 日 {t:%H:%M}"

    hero_fig = ""
    if hero_art:
        hero_fig = (f'<div class="hero-fig"><img class="hero-art" src="{esc(hero_art["src"])}" alt="{esc(hero_art["alt"])}" '
                    f'width="1200" height="800" decoding="async" fetchpriority="high"></div>')

    rod_line = "".join(f'《<a href="/works/{wid}/">{esc(by_id[wid]["title"])}</a>》' for wid in rods)
    shelf = "\n".join(book_html(w) for w in works)
    bili = f'href="{BILI_RULES}" target="_blank" rel="noopener"'

    body = f"""<main id="main">
<section class="hero wrap{' has-art' if hero_art else ''}" aria-labelledby="hero-h">
<div class="hero-text">
<p class="hero-from"><span>《睡前消息》马督工发起的海豹奖科幻小说征文赛，第 0 届。</span><span><a {bili}>规则<span class="sr">（B 站视频，在新窗口打开）</span></a>发布于节目第 1026 期。</span></p>
<div id="hero-h">{ovp(["海豹杯", "科幻文学大赛"])}</div>
<p class="hero-lede">同一批小说，人类和 AI 各评一次。<span class="l2"><b>{len(works)}</b> 部获奖，奖金合计 <b>{money(total)}</b> 元。</span></p>
<div class="hero-actions">
<a class="btn btn-primary" href="/works/{first['id']}/">阅读特别奖《{esc(first['title'])}》</a>
<a class="btn" href="/downloads/haibao2026-all.zip" download>{ICON['down']}打包下载全部作品（TXT + EPUB{zip_size_label()}）</a>
</div>
<p class="hero-views" data-views-box hidden>累计浏览 <b data-views="total"></b> 次，今日 <b data-views="today-uv"></b> 位读者。<a href="/stats/">访问统计</a></p>
</div>
{hero_fig}
</section>

{home_facts(meta, works, by_id, n_both, n_h, n_a)}

<section class="sec wrap" id="awards" aria-labelledby="duel-h">
<h2 class="sec-h" id="duel-h">两份名单</h2>
<p class="sec-intro" id="duel-desc">左边是<span class="k-h">人类评委</span>的名次，右边是 <span class="k-a">AI 评委</span>的名次，同一奖级内不分先后。两边都选中的 {n_both} 部连成一线，粉与蓝叠印成紫；只被一边选中的：人类评委 {n_h} 部，AI 评委 {n_a} 部。作品名下的黄线表示另获鱼竿奖。</p>
<figure class="duel">
{svg}
{mlist}
<figcaption class="duel-cap"><span class="duel-key"><span><i class="sw sw-both" aria-hidden="true"></i>两边都获奖</span><span><i class="sw sw-h" aria-hidden="true"></i>人类评委</span><span><i class="sw sw-a" aria-hidden="true"></i>AI 评委</span><span><i class="sw sw-r" aria-hidden="true"></i>鱼竿奖</span></span>
<span class="duel-rod">鱼竿奖（各 {money(rod_tier['prize'])} 元）：{rod_line}</span></figcaption>
</figure>
</section>

<section class="sec wrap" id="works" aria-labelledby="works-h">
<h2 class="sec-h" id="works-h">全部作品</h2>
<div class="works-bar js-only">
<div class="seg" role="group" aria-label="筛选">
<button type="button" data-filter="all" aria-pressed="true">全部</button><button type="button" data-filter="both" aria-pressed="false">两边都获奖</button><button type="button" data-filter="rod" aria-pressed="false">鱼竿奖</button><button type="button" data-filter="noai" aria-pressed="false">未用 AI</button>
</div>
<label class="sorter">排序<select id="sort"><option value="award">按奖项</option><option value="views">最多阅读</option><option value="likes">最多点赞</option><option value="short">篇幅最短</option><option value="long">篇幅最长</option></select></label>
<p class="shelf-count" id="shelf-count" aria-live="polite"></p>
</div>
<ol class="shelf" id="shelf">
{shelf}
</ol>
<p class="shelf-empty" id="shelf-empty" hidden>没有符合条件的作品。</p>
</section>

<section class="sec wrap" id="recent" aria-labelledby="recent-h" hidden>
<h2 class="sec-h" id="recent-h">最新讨论</h2>
<ol class="recent" id="recent-list"></ol>
</section>

<section class="sec wrap about" id="about" aria-labelledby="about-h">
<h2 class="sec-h" id="about-h">关于这次征文</h2>
<div class="about-in">
<div class="about-text">
<p>海豹奖科幻小说征文赛（第 0 届）由《{esc(c['host'])}》主持人{esc(c['announcedBy'])}发起，规则发布于节目第 1026 期（2026 年 3 月 8 日，<a {bili}>B 站视频<span class="sr">，在新窗口打开</span></a>）。征文鼓励用 AI 辅助写作，评出人类评委奖与 AI 评委奖两份名单；鱼竿奖奖励对后来者有指导作用的 AI 创作方法，获奖作品附创作说明。</p>
<p>获奖名单由{esc(c['announcedBy'])}于 {esc(when)} 发布，原题「{esc(c['name'])}获奖名单」，本站沿用「海豹杯」这个名字。</p>
</div>
<figure class="about-note"><blockquote><p>{esc(c['aiNote'])}</p></blockquote><figcaption>名单中关于 AI 辅助的说明</figcaption></figure>
</div>
</section>
</main>"""
    desc = (f"{c['name']}获奖作品集：{len(works)} 部作品，人类评委与 AI 评委两份名单，奖金合计 {money(total)} 元。在线阅读、下载与讨论。")
    write(DIST / "index.html", shell(ctx, title=f"{c['name']}获奖作品集", desc=desc, path="/", page="home", body=body))


# ---------------------------------------------------------------- work page
def stamp(a):
    j = a["jury"]
    if j == "rod":
        return (f'<li class="stamp stamp-rod"><span class="sj">海豹杯</span><span class="sn">鱼竿奖</span>'
                f'<span class="sp">奖金 {money(a["prize"])} 元</span></li>')
    return (f'<li class="stamp stamp-{j}"><span class="sj">{esc(a["jury_name"])}</span>'
            f'<span class="sn">{esc(a["tier_name"])}</span><span class="sp">奖金 {money(a["prize"])} 元</span></li>')


def build_work(ctx, meta, works, by_id, w):
    ct = w["content"]
    wid = w["id"]
    idx = w["order"]
    prev_w = works[idx - 1] if idx > 0 else None
    next_w = works[idx + 1] if idx + 1 < len(works) else None

    stamps = "".join(stamp(a) for a in w["awards"])
    if ct["statements"]:
        stmt = '<aside class="statement" aria-label="作者声明">' + "".join(
            f"<p>{inline(s)}</p>" for s in ct["statements"]) + "</aside>"
    else:
        stmt = ""
    if w["ai"]:
        ai_meta = "使用 AI 辅助"
    else:
        ai_meta = '<span class="noai">作者未使用 AI 辅助</span>'

    toc = toc_entries(ct["toc"]) if len(ct["toc"]) >= 2 else []
    toc_html = panel_toc = ""
    if toc:
        compact = all(len(t) <= 3 for _, t in toc)
        lis = "".join(f'<li><a href="#ch-{i}">{inline(t)}</a></li>' for i, t in toc)
        label = f"目录（{len(toc)} {'节' if len(toc) != len(ct['toc']) else '章'}）"
        toc_html = (f'<details class="toc{" toc-compact" if compact else ""}" id="toc"><summary>{esc(label)}</summary>'
                    f'<nav aria-label="目录"><ol>{lis}</ol></nav></details>')
        panel_toc = (f'<div class="panel" id="panel-toc" role="dialog" aria-label="目录" hidden>'
                     f'<h2>目录</h2><ol>{lis}</ol></div>')

    notes_html = ""
    if ct.get("notes"):
        items = []
        for n in ct["notes"]:
            nchars = sum(len(plain(b.get("x", ""))) for b in n["body"])
            items.append(f'<details class="note"><summary>{esc(n["title"])}<span>{nchars} 字</span></summary>'
                         f'<div class="prose">{render_blocks(n["body"], chapter_ids=False)}</div></details>')
        notes_html = f'<section class="notes" aria-label="创作说明">{"".join(items)}</section>'

    pn = '<nav class="pn" aria-label="上一部与下一部">'
    if prev_w:
        pn += (f'<a class="prev" href="/works/{prev_w["id"]}/" rel="prev"><span class="lbl">上一部</span>'
               f'<span class="t">{esc(prev_w["title"])}</span></a>')
    if next_w:
        pn += (f'<a class="next" href="/works/{next_w["id"]}/" rel="next"><span class="lbl">下一部</span>'
               f'<span class="t">{esc(next_w["title"])}</span></a>')
    pn += "</nav>"

    title_disp = w["title"]
    dl_name = re.sub(r'[\\/:*?"<>|“”]', "", w["title"]) or wid

    body = f"""<div class="progress" id="progress" aria-hidden="true"><i class="pp"></i><i class="pb"></i></div>
<main id="main">
<article aria-labelledby="work-title">
<header class="work-head">
<div class="work-cover">{cover_html(w, "wc", 280, 373, eager=True)}</div>
<div class="work-info">
<ul class="stamps" aria-label="获奖">{stamps}</ul>
<h1 class="work-title" id="work-title">{esc(title_disp)}</h1>
<p class="work-author"><span class="sr">作者：</span>{esc(w['author'])}</p>
<p class="work-meta"><span>{fmt_chars(w['chars'])}</span><span>{fmt_minutes(w['chars'])}读完</span><span>{ai_meta}</span><span data-views-box hidden>阅读 <b data-views-page="{w['id']}"></b> 次</span></p>
<div class="actions">
<button type="button" class="act act-like js-only" id="act-like" aria-pressed="false">{ICON['heart']}<span class="l">点赞</span><span class="c"></span></button>
<button type="button" class="act act-fav js-only" id="act-fav" aria-pressed="false">{ICON['star']}<span class="l">收藏</span><span class="c"></span></button>
<span class="act-sep"></span>
<a class="act" href="/downloads/{wid}.txt" download="{esc(dl_name)}.txt">{ICON['down']}TXT</a>
<a class="act" href="/downloads/{wid}.epub" download="{esc(dl_name)}.epub">{ICON['down']}EPUB</a>
<button type="button" class="act js-only" id="act-share">{ICON['share']}分享</button>
</div>
</div>
</header>
<div class="col">
<div class="resume" id="resume" hidden><p>上次读到 <b class="pct"></b>。</p><button type="button" class="btn btn-primary go">继续上次阅读</button><button type="button" class="x">从头读</button></div>
{stmt}
{toc_html}
<div class="prose" id="text">
{render_blocks(ct['body'])}
</div>
<div class="the-end" role="separator" aria-label="正文完"><span class="ovp-dots" aria-hidden="true"><i></i><i></i></span></div>
{notes_html}
<section class="talk" id="talk" aria-labelledby="talk-h">
<h2 id="talk-h">讨论<span class="c" id="talk-count"></span></h2>
<noscript><p class="talk-status">讨论区需要启用 JavaScript。</p></noscript>
<div class="js-only" id="talk-app">
<form class="cform" id="cform" novalidate>
<label for="c-name">昵称<input id="c-name" name="name" maxlength="20" autocomplete="nickname" placeholder="匿名读者"></label>
<label for="c-body">评论<textarea id="c-body" name="body" maxlength="1000" required placeholder="说说你读完的感受"></textarea></label>
<div class="cform-foot"><span class="hint">2–1000 字</span><span class="bts"><button type="submit" class="btn btn-primary">发表评论</button></span></div>
<p class="ferr" role="alert" hidden></p>
</form>
<p class="talk-status" role="status"></p>
<ol class="clist"></ol>
<button type="button" class="btn cmore" hidden>加载更多评论</button>
</div>
</section>
{pn}
</div>
</article>
</main>
<div class="dock js-only" role="group" aria-label="阅读工具">
<p class="dock-pct" id="dock-pct" hidden><b class="n"></b><span class="t"></span></p>
{'<button type="button" data-panel="panel-toc" aria-expanded="false" aria-controls="panel-toc">目录</button>' if toc else ''}
<button type="button" data-panel="panel-set" aria-expanded="false" aria-controls="panel-set" aria-label="阅读设置">Aa</button>
</div>
{panel_toc}
{settings_panel()}"""
    awards_txt = "、".join(award_full(a) for a in w["awards"])
    desc = f"《{plain(w['title'])}》，{w['author']}著，{awards_txt}。{excerpt(ct)}"
    title = f"《{plain(w['title'])}》{w['author']}｜海豹杯 2026"
    write(DIST / "works" / wid / "index.html",
          shell(ctx, title=title, desc=desc, path=f"/works/{wid}/", page="work", body=body,
                body_attrs=f' data-work="{wid}"', og_type="article",
                extra_head=work_meta_json(w) + extra_asset_tags() + "\n"))


def settings_panel():
    """阅读设置面板。按钮的 data-pref/data-val 与 site.js 的 prefs() 字段一一对应，所有设置存 hb.prefs。"""
    def opts(key, label, items):
        bts = "".join(f'<button type="button" data-pref="{key}" data-val="{v}" aria-pressed="false">{esc(t)}</button>'
                      for v, t in items)
        return (f'<div class="prow" role="group" aria-labelledby="pl-{key}"><span id="pl-{key}">{esc(label)}</span>'
                f'<span class="opts">{bts}</span></div>')

    def switch(key, label, hint):
        return (f'<div class="prow"><span id="pl-{key}">{esc(label)}</span>'
                f'<button type="button" class="sw-btn" role="switch" aria-checked="true" data-toggle="{key}" '
                f'aria-labelledby="pl-{key}" aria-describedby="ph-{key}"><span class="sw-k" aria-hidden="true"></span></button>'
                f'<span class="sr" id="ph-{key}">{esc(hint)}</span></div>')

    return ('<div class="panel panel-set" id="panel-set" role="dialog" aria-label="阅读设置" hidden>\n<h2>阅读设置</h2>\n'
            '<div class="prow"><label for="set-size">字号</label><span class="rng">'
            '<input type="range" id="set-size" min="14" max="26" step="1" value="18">'
            '<output id="size-out" for="set-size">18px</output></span></div>\n'
            + opts("lh", "行距", [("tight", "紧"), ("normal", "适中"), ("loose", "宽松")]) + "\n"
            + opts("width", "页宽", [("narrow", "窄"), ("mid", "中"), ("wide", "宽")]) + "\n"
            + opts("font", "字体", [("serif", "宋体"), ("sans", "黑体"), ("kai", "楷体")]) + "\n"
            + opts("bg", "背景", [("paper", "纸色"), ("green", "护眼绿"), ("sepia", "羊皮"), ("night", "夜间")]) + "\n"
            + switch("justify", "两端对齐", "关闭后正文左对齐") + "\n"
            + switch("hot", "热门划线", "在多人划过的段落旁显示人数") + "\n"
            + '<p class="pnote">快捷键：← → 或空格翻屏，J / K 下一章、上一章。</p>\n</div>')


def work_meta_json(w):
    """供 reader.js / share.js 使用的作品元数据（type=application/json 不会执行，CSP 安全）。"""
    data = {
        "id": w["id"], "title": plain(w["title"]), "author": w["author"],
        "url": f"{SITE}/works/{w['id']}/",
        "cover": (w.get("cover") or {}).get("src"),
        "juries": sorted({a["jury"] for a in w["awards"]}),
        "awards": [award_full(a) for a in w["awards"]],
        "chars": w["chars"],
        "txt": f"/downloads/{w['id']}.txt", "epub": f"/downloads/{w['id']}.epub",
    }
    js = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    return f'<script type="application/json" id="work-meta">{js}</script>\n'


# ---------------------------------------------------------------- favorites / 404
def build_favorites(ctx, meta, works):
    data = [{
        "id": w["id"], "title": w["title"], "author": w["author"], "chars": fmt_chars(w["chars"]),
        "cover": (w.get("cover") or {}).get("src"), "ph": ph_class(w),
        "awards": [{"c": JURY_MARK[a["jury"]], "label": award_label(a)} for a in w["awards"]],
    } for w in works]
    js = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    body = f"""<main id="main" class="wrap">
<header class="page-head"><h1>我的收藏</h1><p id="fav-count">收藏保存在这台设备的浏览器里。</p></header>
<noscript><p class="fav-empty">「我的收藏」需要启用 JavaScript。也可以直接浏览<a href="/#works">全部作品</a>。</p></noscript>
<ol class="wl js-only" id="fav-list" hidden></ol>
<p class="fav-empty js-only" id="fav-empty">还没有收藏。在作品页点「收藏」，作品会出现在这里。<br><a class="btn fav-go" href="/#works">浏览全部作品</a></p>
<script type="application/json" id="works-data">{js}</script>
</main>"""
    write(DIST / "favorites" / "index.html",
          shell(ctx, title="我的收藏｜海豹杯 2026", desc="你在本设备上收藏的海豹杯 2026 获奖作品。",
                path="/favorites/", page="favorites", body=body,
                extra_head='<meta name="robots" content="noindex">\n'))


def build_notes(ctx, works):
    data = [{"id": w["id"], "title": plain(w["title"]), "author": w["author"], "order": w["order"]} for w in works]
    js = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    body = f"""<main id="main" class="wrap">
<header class="page-head"><h1>我的笔记</h1><p id="notes-count">划线和笔记保存在这台设备的浏览器里，不会上传。</p></header>
<noscript><p class="fav-empty">「我的笔记」需要启用 JavaScript。</p></noscript>
<div class="notes-bar js-only" id="notes-bar" hidden>
<button type="button" class="btn" id="notes-export">导出 Markdown</button>
<button type="button" class="btn btn-quiet" id="notes-copy">复制全部</button>
</div>
<div class="notes-list js-only" id="notes-list" hidden></div>
<div class="fav-empty notes-empty js-only" id="notes-empty">
<p>还没有划线或笔记。</p>
<ol>
<li>打开任意一部作品，在正文里长按（电脑上用鼠标拖选）选中一段文字；</li>
<li>选区下方会出现工具条：点「划线」标出这段话，点「笔记」写下你的想法；</li>
<li>回到这里，就能按作品看到全部划线和笔记，也可以导出为 Markdown。</li>
</ol>
<p class="muted">划线和笔记只保存在这台设备的浏览器里；换手机、换浏览器或清除浏览数据后不会保留，记得定期导出。</p>
<a class="btn fav-go" href="/#works">去读一部作品</a>
</div>
<script type="application/json" id="works-data">{js}</script>
</main>"""
    write(DIST / "notes" / "index.html",
          shell(ctx, title="我的笔记｜海豹杯 2026", desc="你在本设备上的划线与笔记。",
                path="/notes/", page="notes", body=body,
                extra_head='<meta name="robots" content="noindex">\n'
                + extra_asset_tags(("reader.css", "reader.js")) + "\n"))


def build_404(ctx):
    body = f"""<main id="main" class="wrap nf">
{ovp(["404"], tag="div")}
<h1 class="sec-h">这一页没有找到</h1>
<p>链接可能写错了，或者页面已经移动。</p>
<div class="hero-actions"><a class="btn btn-primary" href="/">回到首页</a><a class="btn" href="/#works">浏览全部作品</a></div>
</main>"""
    write(DIST / "404.html", shell(ctx, title="页面没有找到｜海豹杯 2026", desc="页面没有找到。",
                                   path="/404.html", page="404", body=body,
                                   extra_head='<meta name="robots" content="noindex">\n'))


# ---------------------------------------------------------------- static files
def build_static(works):
    csp = ("default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
           f"script-src 'self' '{HEAD_JS_HASH}'; connect-src 'self'; font-src 'self'; "
           "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
    headers = f"""/*
  Cache-Control: public, max-age=300
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: {csp}

/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable

/downloads/*
  ! Cache-Control
  Cache-Control: public, max-age=86400

/favicon.svg
  ! Cache-Control
  Cache-Control: public, max-age=86400
"""
    write(DIST / "_headers", headers)
    write(DIST / "robots.txt", f"User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: {SITE}/sitemap.xml\n")
    urls = ["/"] + [f"/works/{w['id']}/" for w in works]
    sm = ['<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    sm += [f"  <url><loc>{SITE}{u}</loc></url>" for u in urls]
    sm.append("</urlset>\n")
    write(DIST / "sitemap.xml", "\n".join(sm))
    write(DIST / "favicon.svg", FAVICON)


def build_assets(ctx):
    font = DIST / "assets" / "fonts" / "smiley-sans.woff2"
    if font.exists():
        ctx.font_v = sha8(font.read_bytes())
        font_url = f"{FONT_PATH}?v={ctx.font_v}"
    else:
        font_url = FONT_PATH
    css = (SRC / "site.css").read_text("utf-8").replace("__FONT_URL__", font_url)
    js = (SRC / "site.js").read_text("utf-8")
    ctx.css_v = sha8(css.encode())
    ctx.js_v = sha8(js.encode())
    vjs = (SRC / "views.js").read_bytes()
    ctx.views_v = sha8(vjs)
    write(DIST / "assets" / "views.js", vjs)
    write(DIST / "assets" / "site.css", css)
    write(DIST / "assets" / "site.js", js)


def build_stats(ctx, meta, works):
    """/stats/ 公开访问统计页：总浏览、今日浏览与访客、近 30 天走势、作品阅读排行（数据由 views.js 从 /api/views 填入）。"""
    data = json.dumps([{"id": w["id"], "title": plain(w["title"]), "author": w["author"]} for w in works],
                      ensure_ascii=False).replace("</", "<\\/")
    body = f"""<main id="main" class="wrap stats-page">
<h1 class="pg-h">访问统计</h1>
<p class="sec-intro">本站自己统计的浏览量，所有人可见。每打开一次页面算一次浏览；同一设备一天内只算一位读者。数字约每分钟更新。</p>
<div class="v-nums" data-views-box hidden>
<div><b data-views="total"></b><span>累计浏览</span></div>
<div><b data-views="today-pv"></b><span>今日浏览</span></div>
<div><b data-views="today-uv"></b><span>今日读者</span></div>
</div>
<noscript><p>访问统计需要启用 JavaScript。</p></noscript>
<section aria-labelledby="v-trend-h"><h2 id="v-trend-h" class="v-h">近 30 天</h2>
<p class="v-legend"><span class="k-pv">浏览</span><span class="k-uv">读者</span></p>
<div id="views-chart" class="v-chart"></div></section>
<section aria-labelledby="v-rank-h"><h2 id="v-rank-h" class="v-h">作品阅读排行</h2>
<ol id="views-rank" class="v-rank"></ol></section>
</main>
<script type="application/json" id="works-data">{data}</script>"""
    write(DIST / "stats" / "index.html",
          shell(ctx, title="访问统计｜海豹杯 2026", desc="海豹杯 2026 获奖作品站的公开访问统计：累计浏览、每日读者与作品阅读排行。",
                path="/stats/", page="stats", body=body))


def main():
    meta, works, by_id = load()
    ctx = Ctx()
    ctx.meta = meta
    DIST.mkdir(exist_ok=True)
    build_assets(ctx)
    hero_art = build_art(works)
    build_home(ctx, meta, works, by_id, hero_art)
    build_stats(ctx, meta, works)
    copy_note_images()
    for w in works:
        build_work(ctx, meta, works, by_id, w)
    build_favorites(ctx, meta, works)
    build_notes(ctx, works)
    build_404(ctx)
    build_static(works)
    print(f"built {len(works)} works -> {DIST.relative_to(ROOT)}/ (css {ctx.css_v}, js {ctx.js_v}, font {ctx.font_v or 'missing'})")


if __name__ == "__main__":
    main()
