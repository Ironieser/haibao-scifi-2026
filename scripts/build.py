"""生成静态站点到 dist/。

用法：python3 -I scripts/build.py
只用标准库。读取 data/works.json 与 content/works/*.json，写出：
  dist/index.html, dist/works/<id>/index.html, dist/favorites/index.html, dist/404.html,
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
def render_blocks(blocks, chapter_ids=True, note_prefix=None):
    out, ch = [], 0
    for b in blocks:
        t = b.get("t")
        if t == "p":
            out.append(f"<p>{inline(b['x'])}</p>")
        elif t == "h":
            if chapter_ids:
                ch += 1
                out.append(f'<h2 class="ch" id="ch-{ch}">{inline(b["x"])}'
                           f'<a class="anc" href="#ch-{ch}" aria-label="本章链接">#</a></h2>')
            else:
                out.append(f'<h3 class="nh">{inline(b["x"])}</h3>')
        elif t == "c":
            out.append(f'<p class="cc">{inline(b["x"])}</p>')
        elif t == "hr":
            out.append('<p class="sep" role="separator" aria-label="分隔">＊＊＊</p>')
        elif t == "table":
            rows = b.get("rows") or []
            if not rows:
                continue
            head, *rest = rows
            th = "".join(f'<th scope="col">{inline(c)}</th>' for c in head)
            trs = "".join("<tr>" + "".join(
                (f'<td class="nw">{inline(c)}</td>' if len(c) <= 12 else f"<td>{inline(c)}</td>") for c in r)
                + "</tr>" for r in rest)
            out.append(f'<div class="tbl" role="region" aria-label="表格" tabindex="0"><table>'
                       f"<thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div>")
    return "\n".join(out)


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

# 首屏前执行：应用主题/字体/字号偏好，并标记 JS 可用（CSP 用哈希放行）
HEAD_JS = ("(function(){var d=document.documentElement;d.className+=' js';try{"
           "var p=JSON.parse(localStorage.getItem('hb.prefs')||'{}')||{};"
           "if(p.theme==='light'||p.theme==='dark')d.setAttribute('data-theme',p.theme);"
           "if(p.font==='sans')d.setAttribute('data-font','sans');"
           "var s=parseInt(p.size,10);if(s>=15&&s<=26)d.style.setProperty('--read-size',s+'px');"
           "}catch(e){}})();")
HEAD_JS_HASH = "sha256-" + base64.b64encode(hashlib.sha256(HEAD_JS.encode()).digest()).decode()


# ---------------------------------------------------------------- page shell
class Ctx:
    css_v = js_v = ""
    font_v = ""
    meta = None


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
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#EEEFEA" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#17192B" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
{font_preload}<link rel="stylesheet" href="/assets/site.css?v={ctx.css_v}">
<script>{HEAD_JS}</script>
<script src="/assets/site.js?v={ctx.js_v}" defer></script>
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
    fav = ' aria-current="page"' if page == "favorites" else ""
    return f"""<header class="masthead"><div class="wrap masthead-in">
<a class="brand" href="/">{SEAL_SVG}海豹杯 2026</a>
<nav class="nav" aria-label="主导航"><a href="/#awards">获奖名单</a><a href="/#works">全部作品</a><a href="/favorites/"{fav}>我的收藏</a></nav>
</div></header>"""


def footer(ctx):
    c = ctx.meta["contest"]
    t = datetime.fromisoformat(c["announcedAt"])
    when = f"{t.year}年{t.month}月{t.day}日 {t:%H:%M}"
    return f"""<footer class="foot"><div class="wrap">
<p class="foot-ann">「{esc(c['name'])}获奖名单」由{esc(c['announcedBy'])}于 {esc(when)} 发布。</p>
<blockquote><p>{esc(c['aiNote'])}</p></blockquote>
<p>作品版权归作者所有，本站仅供阅读与交流。</p>
<p>展示字体：得意黑（<a href="/assets/fonts/OFL.txt">OFL</a>）。</p>
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


def duel_svg(meta, by_id):
    human, ai, h_tiers, a_tiers, h_set, a_set = duel_layout(meta, by_id)
    W_, ROW, GAP, TOP = 760, 34, 16, 86
    XL_T, XL_D, XR_D, XR_T = 280, 292, 468, 480

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
    H_ = max(hy, ay) + 4

    parts = [f'<svg class="duel-svg" viewBox="0 0 {W_} {H_}" role="group" '
             f'aria-labelledby="duel-h" aria-describedby="duel-desc">']
    # 列标题
    parts.append(f'<text class="d-col" x="{XL_T}" y="30" text-anchor="end">人类评委</text>')
    parts.append(f'<text class="d-col-sub" x="{XL_T}" y="52" text-anchor="end">{len(h_set)} 部作品，奖金 {money(human["sum"])} 元</text>')
    parts.append(f'<text class="d-col" x="{XR_T}" y="30">AI评委</text>')
    parts.append(f'<text class="d-col-sub" x="{XR_T}" y="52">{len(a_set)} 部作品，奖金 {money(ai["sum"])} 元</text>')
    parts.append(f'<line class="d-rule" x1="0" x2="{W_}" y1="64" y2="64"/>')

    def tier_label(t, y0, y1, side):
        prize = ("各 " if t["each"] else "") + money(t["prize"]) + " 元"
        if side == "L":
            x, anchor, bx = 0, "start", 100
        else:
            x, anchor, bx = W_, "end", W_ - 100
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
        if wid in hp:
            y = hp[wid]
            g.append(f'<rect class="d-hit" x="104" y="{y - 15}" width="{XL_D - 98}" height="30"/>')
            g.append(f'<text class="d-t" x="{XL_T}" y="{y}" dy=".36em" text-anchor="end">{esc(w["title"])}</text>')
            g.append(f'<circle class="d-h" cx="{XL_D}" cy="{y}" r="5.5"/>')
        if wid in ap:
            y = ap[wid]
            g.append(f'<rect class="d-hit" x="{XR_D - 8}" y="{y - 15}" width="{W_ - 104 - XR_D + 8}" height="30"/>')
            g.append(f'<text class="d-t" x="{XR_T}" y="{y}" dy=".36em">{esc(w["title"])}</text>')
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
        ms = "".join(
            f'<span class="mark mark-{JURY_MARK[a["jury"]]}">{esc(JURY_SHORT[a["jury"]])}{esc(a["tier_name"])}</span>'
            for a in w["awards"] if a["jury"] in ("human", "ai"))
        return (f'<li><a href="/works/{wid}/"><span class="t">{esc(w["title"])}</span>'
                f'<span class="r">{ms}</span></a></li>')

    def group(title, dot, ws):
        return (f'<li class="duel-group"><h3>{dot}{esc(title)}<span class="mark">{len(ws)} 部</span></h3>'
                f'<ol>{"".join(row(w) for w in ws)}</ol></li>')

    return ('<ol class="duel-list">'
            + group("两边都获奖", '<span class="ovp-dots" aria-hidden="true"><i></i><i></i></span>', both)
            + group("只获人类评委奖", '<span class="sw sw-h" aria-hidden="true"></span>', only_h)
            + group("只获 AI 评委奖", '<span class="sw sw-a" aria-hidden="true"></span>', only_a)
            + "</ol>"), len(both), len(only_h), len(only_a)


# ---------------------------------------------------------------- home
def build_home(ctx, meta, works, by_id, hero_art=None):
    c = meta["contest"]
    total = meta["total_prize"]
    first = by_id["huidao-mingtian"]
    svg = duel_svg(meta, by_id)
    hero_img = ""
    if hero_art:
        hero_img = (f'<img class="hero-art" src="{esc(hero_art["src"])}" alt="{esc(hero_art["alt"])}" '
                    f'width="1200" height="800" decoding="async" fetchpriority="high">')
    mlist, n_both, n_h, n_a = duel_list(meta, by_id)

    # 获奖名单
    jury_html = []
    for j in meta["juries"]:
        tiers = []
        for t in j["tiers"]:
            prize = ("奖金各 " if t["each"] else "奖金 ") + money(t["prize"]) + " 元"
            items = "".join(
                f'<li><a href="/works/{wid}/"><span class="wt">《{esc(by_id[wid]["title"])}》</span>'
                f'<span class="wa">{esc(by_id[wid]["author"])}</span></a></li>' for wid in t["works"])
            name = t["name"] if t["name"] != j["name"] else f'{len(t["works"])} 部作品'
            tiers.append(f'<div class="tier"><div class="tier-h"><h4>{esc(name)}</h4><span>{esc(prize)}</span></div>'
                         f"<ul>{items}</ul></div>")
        jury_html.append(f'<section class="jury jury-{j["id"]}" aria-labelledby="jury-{j["id"]}">'
                         f'<h3 id="jury-{j["id"]}">{esc(j["name"])}</h3>'
                         f'<p class="jury-sum">奖金合计 {money(j["sum"])} 元</p>{"".join(tiers)}</section>')

    # 全部作品
    rows = []
    for w in works:
        ai_txt = "AI 辅助" if w["ai"] else "未用 AI"
        rows.append(
            f'<li class="wrow" data-id="{w["id"]}" data-order="{w["order"]}" data-chars="{w["chars"]}" '
            f'data-both="{1 if w["both"] else 0}" data-ai="{1 if w["ai"] else 0}">'
            f'<a href="/works/{w["id"]}/">{cover_html(w, "w-cv", 72, 96, alt=False)}<span class="w-body">'
            f'<span class="w-tt"><span class="w-t">{esc(w["title"])}</span><span class="w-a">{esc(w["author"])}</span></span>'
            f'<span class="w-aw">{marks_html(w)}</span>'
            f'<span class="w-ch">{fmt_chars(w["chars"])}</span>'
            f'<span class="w-ai{"" if w["ai"] else " no"}">{ai_txt}</span>'
            f'<span class="w-st n" data-stat="likes" hidden><span class="n">0</span><span class="u"> 赞</span></span>'
            f'<span class="w-st n" data-stat="comments" hidden><span class="n">0</span><span class="u"> 评论</span></span>'
            f"</span></a></li>")

    body = f"""<main id="main">
<section class="hero wrap{' has-art' if hero_art else ''}" aria-labelledby="hero-h">
{hero_img}<div class="hero-text"><div id="hero-h">{ovp(["海豹杯", "科幻文学大赛"])}</div>
<p class="hero-lede">{c['year']} 年获奖作品集，<b>{len(works)}</b> 部作品，两个评审团，奖金合计 <b>{money(total)}</b> 元。</p>
<div class="hero-actions">
<a class="btn btn-primary" href="/works/{first['id']}/">阅读特别奖《{esc(first['title'])}》</a>
<a class="btn" href="#awards">查看获奖名单</a>
</div></div>
</section>

<section class="sec wrap" id="duel" aria-labelledby="duel-h">
<h2 class="sec-h" id="duel-h">两份名单</h2>
<p class="sec-intro" id="duel-desc">左边是<span class="k-h">人类评委</span>的名次，右边是 <span class="k-a">AI 评委</span>的名次。两边都选中的 {n_both} 部作品连成一线，粉与蓝叠印成紫；只被一边选中的作品单独列出（人类评委 {n_h} 部，AI 评委 {n_a} 部）。同一奖级内不分先后。</p>
<figure class="duel">
{svg}
<figcaption class="duel-cap"><span><i class="sw sw-both" aria-hidden="true"></i>两边都获奖</span><span><i class="sw sw-h" aria-hidden="true"></i>人类评委</span><span><i class="sw sw-a" aria-hidden="true"></i>AI 评委</span><span>点击作品名进入阅读</span></figcaption>
{mlist}
</figure>
</section>

<section class="sec wrap" id="awards" aria-labelledby="awards-h">
<h2 class="sec-h" id="awards-h">获奖名单</h2>
<div class="juries">
{"".join(jury_html)}
</div>
</section>

<section class="sec wrap" id="works" aria-labelledby="works-h">
<h2 class="sec-h" id="works-h">全部作品</h2>
<div class="works-bar">
<div class="works-tools js-only">
<div class="seg" role="group" aria-label="筛选">
<button type="button" data-filter="all" aria-pressed="true">全部</button><button type="button" data-filter="both" aria-pressed="false">两个评审团都获奖</button><button type="button" data-filter="noai" aria-pressed="false">未使用 AI</button>
</div>
<label class="sorter">排序 <select id="sort"><option value="award">默认（按奖项）</option><option value="likes">最多点赞</option><option value="chars">字数</option></select></label>
</div>
<a class="dl-all act" href="/downloads/haibao2026-all.zip" download>{ICON['down']}打包下载全部作品（ZIP）</a>
</div>
<div class="wl-head" aria-hidden="true"><span></span><span>作品</span><span>获奖</span><span>字数</span><span>AI</span><span class="n" data-stat hidden>点赞</span><span class="n" data-stat hidden>评论</span></div>
<ol class="wl" id="wl">
{chr(10).join(rows)}
</ol>
<p class="wl-empty" id="wl-empty" hidden>没有符合条件的作品。</p>
<p class="sec-intro js-only" id="wl-count" aria-live="polite"></p>
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
<p class="work-meta"><span>{fmt_chars(w['chars'])}</span><span>{fmt_minutes(w['chars'])}读完</span><span>{ai_meta}</span></p>
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
<div class="dock js-only" aria-label="阅读工具">
{'<button type="button" data-panel="panel-toc" aria-expanded="false" aria-controls="panel-toc">目录</button>' if toc else ''}
<button type="button" data-panel="panel-set" aria-expanded="false" aria-controls="panel-set" aria-label="阅读设置">Aa</button>
</div>
{panel_toc}
<div class="panel" id="panel-set" role="dialog" aria-label="阅读设置" hidden>
<h2>阅读设置</h2>
<div class="prow"><span>字号</span><span class="opts"><button type="button" data-size="-1" aria-label="缩小字号">A-</button><output id="size-out">18px</output><button type="button" data-size="1" aria-label="放大字号">A+</button></span></div>
<div class="prow"><span>字体</span><span class="opts"><button type="button" data-pref="font" data-val="serif">宋体</button><button type="button" data-pref="font" data-val="sans">黑体</button></span></div>
<div class="prow"><span>外观</span><span class="opts"><button type="button" data-pref="theme" data-val="auto">自动</button><button type="button" data-pref="theme" data-val="light">浅色</button><button type="button" data-pref="theme" data-val="dark">深色</button></span></div>
</div>"""
    awards_txt = "、".join(award_full(a) for a in w["awards"])
    desc = f"《{plain(w['title'])}》，{w['author']}著，{awards_txt}。{excerpt(ct)}"
    title = f"《{plain(w['title'])}》{w['author']}｜海豹杯 2026"
    write(DIST / "works" / wid / "index.html",
          shell(ctx, title=title, desc=desc, path=f"/works/{wid}/", page="work", body=body,
                body_attrs=f' data-work="{wid}"', og_type="article"))


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
    csp = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
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
    write(DIST / "assets" / "site.css", css)
    write(DIST / "assets" / "site.js", js)


def main():
    meta, works, by_id = load()
    ctx = Ctx()
    ctx.meta = meta
    DIST.mkdir(exist_ok=True)
    build_assets(ctx)
    hero_art = build_art(works)
    build_home(ctx, meta, works, by_id, hero_art)
    for w in works:
        build_work(ctx, meta, works, by_id, w)
    build_favorites(ctx, meta, works)
    build_404(ctx)
    build_static(works)
    print(f"built {len(works)} works -> {DIST.relative_to(ROOT)}/ (css {ctx.css_v}, js {ctx.js_v}, font {ctx.font_v or 'missing'})")


if __name__ == "__main__":
    main()
