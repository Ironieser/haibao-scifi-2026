#!/usr/bin/env python3
"""生成下载文件：dist/downloads/<id>.txt、<id>.epub 与 haibao2026-all.zip。

用法：python3 -I scripts/export.py
只用标准库。只写 dist/downloads/ 下自己的文件，不动 dist/ 其它内容。
"""
import io
import json
import re
import sys
import uuid
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape as _xml_escape

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "works.json"
CONTENT = ROOT / "content" / "works"
ART_NOTES = ROOT / "art" / "notes"
OUT = ROOT / "dist" / "downloads"
SITE = "https://scifi.ironieser.cc"
SOURCE_LINE = "2026年海豹杯科幻文学大赛获奖作品，版权归作者所有"
ALL_ZIP = "haibao2026-all.zip"
# 固定 zip 内时间戳，保证重复构建产物一致
ZIP_TIME = (2026, 11, 14, 20, 17, 0)
MODIFIED = "2026-11-14T12:17:00Z"  # dcterms:modified（= 名单发布时间，UTC）
NO_AI = "作者未使用 AI 辅助"
INDENT = "　　"
EOL = "\r\n"

CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f￾￿]")
BOLD_RE = re.compile(r"\*\*(.+?)\*\*")


# ---------------------------------------------------------------- 数据

def load():
    meta = json.loads(DATA.read_text(encoding="utf-8"))
    works = []
    for w in meta["works"]:
        c = json.loads((CONTENT / f"{w['id']}.json").read_text(encoding="utf-8"))
        works.append({**w, **{k: c[k] for k in ("chars", "statements", "toc", "body", "notes")}})
    return meta, works


def awards_of(meta, wid):
    """返回 [(显示名, 奖金, each)]，显示名如「人类评委奖 特别奖」「鱼竿奖」。"""
    res = []
    for j in meta["juries"]:
        for t in j["tiers"]:
            if wid in t["works"]:
                name = j["name"] if t["name"] == j["name"] else f"{j['name']} {t['name']}"
                res.append((name, t["prize"], t["each"]))
    return res


def money(n):
    return f"{n:,}"


def announce_text(meta):
    c = meta["contest"]
    dt = datetime.fromisoformat(c["announcedAt"])
    return f"名单由{c['announcedBy']}于{dt.year}年{dt.month}月{dt.day}日{dt.hour}:{dt.minute:02d}发布"


def clean(s):
    return CTRL_RE.sub("", s)


def plain(s):
    """纯文本：去掉 ** 标记。"""
    s = clean(s)
    s = BOLD_RE.sub(r"\1", s)
    return s.replace("**", "")


def inline_xhtml(s):
    """XHTML：转义后把 **x** 变成 <strong>x</strong>；落单的 ** 删除。"""
    s = _xml_escape(clean(s), {'"': "&quot;"})
    s = BOLD_RE.sub(r"<strong>\1</strong>", s)
    return s.replace("**", "")


def attr(s):
    return _xml_escape(clean(s), {'"': "&quot;"})


def work_url(wid):
    return f"{SITE}/works/{wid}/"


def zip_name(w, ext):
    name = f"《{w['title']}》-{w['author']}.{ext}"
    return re.sub(r'[\\/:*?<>|]', "_", name)  # Windows 非法字符（中文引号保留）


# ---------------------------------------------------------------- TXT

TXT_BLOCK = ("doc", "box", "code", "sys")  # 这些段落样式在 TXT 中前后空行、整体缩进、逐行原样输出


def blocks_txt(blocks):
    out = []
    prev_cls = None
    for b in blocks:
        t = b["t"]
        cls = b.get("cls")
        group = cls if cls in TXT_BLOCK else None
        if group != prev_cls:
            out.append("")
        prev_cls = group
        x = clean(b.get("x", ""))
        pad = INDENT if group else ""
        if t == "p":
            if group == "code":
                out.append(pad + x.rstrip())
            elif group or cls == "right":
                out.append(pad + x.strip())
            else:
                out.append(INDENT + x.strip())
        elif t == "li":
            lead = INDENT * (1 + (b.get("lvl") or 0))
            out.append(pad + lead + (b.get("mk") or "•") + " " + x.strip())
        elif t == "h":
            if group:
                out.append(pad + x.strip())
            else:
                out += ["", x.strip(), ""]
        elif t == "c":
            out.append(pad + x.strip())
        elif t == "hr":
            out += ["", "* * *", ""]
        elif t == "img":
            out.append(INDENT + "〔原文截图〕")
        elif t == "table":
            out.append("")
            out += [pad + "\t".join(clean(c) for c in row) for row in b["rows"]]
            out.append("")
    # 合并多余空行
    res = []
    for line in out:
        if line == "" and (not res or res[-1] == ""):
            continue
        res.append(line)
    while res and res[-1] == "":
        res.pop()
    return res


def make_txt(meta, w):
    lines = [f"《{w['title']}》", f"作者：{w['author']}"]
    aw = awards_of(meta, w["id"])
    if aw:
        lines.append("获奖：" + "、".join(a[0] for a in aw))
    lines.append("")
    lines.append("作者 AI 声明：")
    if w["statements"]:
        lines += [INDENT + plain(s).strip() for s in w["statements"]]
    elif not w["ai"]:
        lines.append(INDENT + NO_AI)
    else:
        lines.append(INDENT + "（作者使用了 AI 辅助，未附声明）")
    lines += ["", SOURCE_LINE, work_url(w["id"]), "", "=" * 24, ""]
    lines += blocks_txt(w["body"])
    for n in w["notes"]:
        lines += ["", "", "=" * 24, "", f"附录：{plain(n['title'])}", ""]
        lines += blocks_txt(n["body"])
    lines.append("")
    return "﻿" + EOL.join(lines)


# ---------------------------------------------------------------- EPUB

CSS = """@charset "utf-8";
body { margin: 0 5%; line-height: 1.8; font-family: serif; }
p { margin: 0; text-indent: 2em; line-height: 1.8; }
h1, h2 { line-height: 1.4; text-indent: 0; font-weight: bold; }
h1 { font-size: 1.6em; margin: 2em 0 0.6em; text-align: center; }
h2 { font-size: 1.25em; margin: 1.6em 0 1em; }
h3 { font-size: 1.1em; margin: 1.4em 0 0.8em; }
p.center { text-indent: 0; text-align: center; margin: 0.6em 0; }
hr { border: 0; text-align: center; margin: 1.4em 0; }
hr::after { content: "* * *"; }
table { border-collapse: collapse; margin: 1em 0; width: 100%; font-size: 0.9em; }
th, td { border: 1px solid #888; padding: 0.3em 0.5em; text-align: left; vertical-align: top; line-height: 1.5; }
.titlepage { text-align: center; }
.titlepage p { text-indent: 0; }
.author { font-size: 1.2em; margin: 0.4em 0 1.6em; }
.awards { margin: 0 0 1.6em; }
.awards p { margin: 0.2em 0; }
.statement { text-align: left; margin: 1.6em 0; }
.statement p { text-indent: 2em; }
.label { text-indent: 0; font-weight: bold; margin-bottom: 0.4em; }
.source { font-size: 0.85em; margin-top: 2em; }
nav ol { list-style: none; padding-left: 0; }
nav li { margin: 0.3em 0; }
em { font-style: normal; font-family: "Kaiti SC", STKaiti, KaiTi, serif; }
u { text-decoration: underline; text-underline-offset: 0.25em; }
code.ic { font-family: inherit; border: 1px solid #bbb; padding: 0 0.2em; }
.blk { margin: 1em 0; }
.blk p { text-indent: 0; }
.bh { font-weight: bold; text-indent: 0; margin-top: 0.6em; }
.blk-doc { font-family: FangSong, STFangsong, serif; border-left: 2px solid #999; padding-left: 1em; margin-left: 0.5em; }
.blk-letter { font-family: "Kaiti SC", STKaiti, KaiTi, serif; padding-left: 1.5em; border-left: 1px solid #999; }
.blk-letter p { text-indent: 2em; }
.blk-alt { font-family: "Kaiti SC", STKaiti, KaiTi, serif; }
.blk-alt p { text-indent: 2em; }
.blk-epi { font-size: 0.9em; opacity: 0.8; margin-left: 30%; margin-bottom: 2em; }
.blk-sys { font-family: sans-serif; font-size: 0.88em; border: 1px solid #999; border-left-width: 3px; padding: 0.4em 0.8em; }
.blk-q { border-left: 3px solid #aaa; padding-left: 1em; opacity: 0.8; }
.blk-code { font-family: monospace; font-size: 0.82em; white-space: pre-wrap; line-height: 1.5; }
.blk-box { font-family: FangSong, STFangsong, serif; border: 1px solid #888; padding: 0.8em 1em; }
.blk-right p { text-align: right; }
ul, ol { margin: 0.4em 0 0.8em; padding-left: 2em; }
li { margin: 0.1em 0; }
li.li-sub { list-style: none; }
ul.lst-1 { list-style: circle; }
figure.fig { margin: 1em 0; text-align: center; }
figure.fig img { max-width: 100%; }
"""


def xhtml_doc(title, body, extra_ns=""):
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!DOCTYPE html>\n"
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"'
        f' lang="zh-CN" xml:lang="zh-CN"{extra_ns}>\n'
        "<head>\n"
        '<meta charset="utf-8"/>\n'
        f"<title>{attr(title)}</title>\n"
        '<link rel="stylesheet" type="text/css" href="style.css"/>\n'
        "</head>\n"
        f"<body>\n{body}\n</body>\n</html>\n"
    )


XTAGS = (("b", "strong"), ("i", "em"), ("u", "u"), ("code", "code"))
ORDERED_MK = re.compile(r"^(\d+)[.)]$")


def rich_xhtml(x, m=None):
    """纯文本 + 格式区间 -> XHTML（与网页同样按边界切片、固定嵌套顺序）。"""
    x = clean(x)
    if not m:
        return attr(x)
    cuts = sorted({0, len(x)} | {c for s, e, _ in m for c in (s, e) if 0 <= c <= len(x)})
    out = []
    for a, b in zip(cuts, cuts[1:]):
        kinds = {k for s, e, k in m if s <= a and e >= b}
        seg = attr(x[a:b])
        for k, tag in reversed(XTAGS):
            if k in kinds:
                cls = ' class="ic"' if k == "code" else ""
                seg = f"<{tag}{cls}>{seg}</{tag}>"
        out.append(seg)
    return "".join(out)


def blocks_xhtml(blocks, hlevel=2, hid=None, images=None, figs=None):
    """images: src -> EPUB 内路径（make_epub 负责打包）。
    figs: {"title", "n"}，附录截图按全书出现顺序编号写替代文字（与网页一致）。"""
    out = []
    cur_cls = None
    lists = []

    def close_lists(to=0):
        while len(lists) > to:
            tag, lvl = lists.pop()
            out.append(f"</{tag}>" + ("</li>" if lvl == 1 else ""))

    for b in blocks:
        t = b["t"]
        cls = b.get("cls")
        if t != "li":
            close_lists()
        if cls != cur_cls:
            close_lists()
            if cur_cls:
                out.append("</div>")
            if cls:
                out.append(f'<div class="blk blk-{attr(cls)}">')
            cur_cls = cls
        if t == "p":
            out.append(f"<p>{rich_xhtml(b['x'], b.get('m'))}</p>")
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
            out.append(f"<li>{rich_xhtml(b['x'], b.get('m'))}</li>")
        elif t == "h":
            if cls:
                out.append(f'<p class="bh">{rich_xhtml(b["x"], b.get("m"))}</p>')
            else:
                ida = f' id="{hid}"' if hid else ""
                hid = None
                out.append(f"<h{hlevel}{ida}>{rich_xhtml(b['x'], b.get('m'))}</h{hlevel}>")
        elif t == "c":
            out.append(f'<p class="center">{rich_xhtml(b["x"], b.get("m"))}</p>')
        elif t == "hr":
            out.append("<hr/>")
        elif t == "img":
            href = (images or {}).get(b["src"])
            if figs is not None:
                figs["n"] += 1
                alt = f"《{figs['title']}》创作说明截图 第 {figs['n']} 张"
            else:
                alt = "创作说明截图"
            if href:
                out.append(f'<figure class="fig"><img src="{attr(href)}" alt="{attr(alt)}"/></figure>')
            else:
                out.append('<p class="center">〔原文截图〕</p>')
        elif t == "table":
            rows = b["rows"]
            parts = ["<table>"]
            if len(rows) > 1:
                parts.append("<thead><tr>" + "".join(f"<th>{attr(clean(c))}</th>" for c in rows[0]) + "</tr></thead>")
                rows = rows[1:]
            parts.append("<tbody>")
            for r in rows:
                parts.append("<tr>" + "".join(f"<td>{attr(clean(c))}</td>" for c in r) + "</tr>")
            parts.append("</tbody></table>")
            out.append("\n".join(parts))
    close_lists()
    if cur_cls:
        out.append("</div>")
    return "\n".join(out)


def split_chapters(w):
    """按 h 拆章。h 之前的内容单独成「开篇」章（若非空）。返回 [(标题, blocks)]。"""
    chapters = []
    cur_title, cur = None, []
    for b in w["body"]:
        if b["t"] == "h" and not b.get("cls"):  # 区块内的小标题不拆章（与网站目录一致）
            if cur or cur_title is not None:
                chapters.append((cur_title, cur))
            cur_title, cur = plain(b["x"]).strip(), [b]
        else:
            cur.append(b)
    if cur or cur_title is not None:
        chapters.append((cur_title, cur))
    if len(chapters) == 1 and chapters[0][0] is None:
        return [("正文", chapters[0][1])]
    return [(t if t is not None else "开篇", bl) for t, bl in chapters]


def titlepage_xhtml(meta, w):
    parts = ['<section class="titlepage" epub:type="titlepage">',
             f"<h1>{inline_xhtml(w['title'])}</h1>",
             f'<p class="author">{inline_xhtml(w["author"])} 著</p>']
    aw = awards_of(meta, w["id"])
    if aw:
        parts.append('<div class="awards">')
        for name, prize, each in aw:
            parts.append(f"<p>{attr(name)}</p>")
        parts.append("</div>")
    parts.append('<div class="statement">')
    parts.append('<p class="label">作者 AI 声明</p>')
    if w["statements"]:
        parts += [f"<p>{inline_xhtml(s)}</p>" for s in w["statements"]]
    elif not w["ai"]:
        parts.append(f"<p>{NO_AI}</p>")
    else:
        parts.append("<p>（作者使用了 AI 辅助，未附声明）</p>")
    parts.append("</div>")
    url = work_url(w["id"])
    parts.append(f'<p class="source">{attr(SOURCE_LINE)}<br/><a href="{attr(url)}">{attr(url)}</a></p>')
    parts.append("</section>")
    return xhtml_doc(w["title"], "\n".join(parts))


def make_epub(meta, w):
    """返回 (epub bytes, {path: xhtml/opf/ncx 文本})，后者供校验。"""
    bid = f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, work_url(w['id']))}"
    files = {}  # 路径（OEBPS 内） -> (内容, media-type, manifest id, 是否在 spine)
    order = []

    def add(path, content, mtype, mid, spine=True, props=None):
        files[path] = (content, mtype, mid, props)
        if spine:
            order.append(mid)

    add("style.css", CSS, "text/css", "css", spine=False)
    # 附录截图：art/notes/<id>/<n>.jpg -> OEBPS/images/<n>.jpg
    images = {}
    for b in w["body"] + [x for n in w["notes"] for x in n["body"]]:
        if b["t"] == "img" and b["src"] not in images:
            f = ART_NOTES / b["src"]
            if f.exists():
                href = "images/" + b["src"].split("/")[-1]
                images[b["src"]] = href
                add(href, f.read_bytes(), "image/jpeg", "img" + str(len(images)), spine=False)
    add("title.xhtml", titlepage_xhtml(meta, w), "application/xhtml+xml", "titlepage")

    nav_items = [("title.xhtml", "标题页")]
    figs = {"title": plain(w["title"]), "n": 0}
    chapters = split_chapters(w)
    hno = 0  # 章节锚点与网站一致：ch-<toc 序号>，从 1 起
    for i, (title, blocks) in enumerate(chapters, 1):
        path = f"chapter-{i:03d}.xhtml"
        if blocks and blocks[0]["t"] == "h" and not blocks[0].get("cls"):
            hno += 1
            body = blocks_xhtml(blocks, hid=f"ch-{hno}", images=images, figs=figs)
        else:
            body = blocks_xhtml(blocks, images=images, figs=figs)
        sec = f'<section epub:type="chapter">\n{body}\n</section>'
        add(path, xhtml_doc(f"《{w['title']}》{title}" if len(chapters) > 1 else w["title"], sec),
            "application/xhtml+xml", f"ch{i:03d}")
        nav_items.append((path, title))
    for i, n in enumerate(w["notes"], 1):
        path = f"appendix-{i}.xhtml"
        ntitle = plain(n["title"]).strip()
        body = f"<h2>附录：{attr(ntitle)}</h2>\n" + blocks_xhtml(n["body"], hlevel=3, images=images, figs=figs)
        sec = f'<section epub:type="appendix">\n{body}\n</section>'
        add(path, xhtml_doc(f"附录：{ntitle}", sec), "application/xhtml+xml", f"app{i}")
        nav_items.append((path, f"附录：{ntitle}"))

    # nav.xhtml
    lis = "\n".join(f'<li><a href="{attr(p)}">{attr(t)}</a></li>' for p, t in nav_items)
    nav = (f'<nav epub:type="toc" id="toc">\n<h2>目录</h2>\n<ol>\n{lis}\n</ol>\n</nav>\n'
           f'<nav epub:type="landmarks" hidden="hidden">\n<ol>\n'
           f'<li><a epub:type="titlepage" href="title.xhtml">标题页</a></li>\n'
           f'<li><a epub:type="bodymatter" href="chapter-001.xhtml">正文</a></li>\n'
           f"</ol>\n</nav>")
    files["nav.xhtml"] = (xhtml_doc("目录", nav), "application/xhtml+xml", "nav", "nav")
    order.insert(1, "nav")

    # toc.ncx（兼容只认 EPUB 2 的阅读器）
    points = "\n".join(
        f'<navPoint id="np{k}" playOrder="{k}"><navLabel><text>{attr(t)}</text></navLabel>'
        f'<content src="{attr(p)}"/></navPoint>'
        for k, (p, t) in enumerate(nav_items, 1))
    ncx = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="zh-CN">\n'
           f'<head><meta name="dtb:uid" content="{bid}"/><meta name="dtb:depth" content="1"/>'
           '<meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n'
           f"<docTitle><text>{attr(w['title'])}</text></docTitle>\n"
           f"<docAuthor><text>{attr(w['author'])}</text></docAuthor>\n"
           f"<navMap>\n{points}\n</navMap>\n</ncx>\n")
    files["toc.ncx"] = (ncx, "application/x-dtbncx+xml", "ncx", None)

    # content.opf
    manifest = "\n".join(
        f'    <item id="{mid}" href="{attr(p)}" media-type="{mt}"' + (f' properties="{pr}"' if pr else "") + "/>"
        for p, (_, mt, mid, pr) in files.items())
    spine = "\n".join(f'    <itemref idref="{mid}"/>' for mid in order)
    aw = awards_of(meta, w["id"])
    desc = f"{SOURCE_LINE}。" + ("获奖：" + "、".join(a[0] for a in aw) + "。" if aw else "")
    opf = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">\n'
           '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
           f'    <dc:identifier id="bookid">{bid}</dc:identifier>\n'
           f"    <dc:title>{attr(w['title'])}</dc:title>\n"
           f'    <dc:creator id="creator">{attr(w["author"])}</dc:creator>\n'
           '    <meta refines="#creator" property="role" scheme="marc:relators">aut</meta>\n'
           "    <dc:language>zh-CN</dc:language>\n"
           f"    <dc:publisher>{attr(meta['contest']['name'])}</dc:publisher>\n"
           f"    <dc:description>{attr(desc)}</dc:description>\n"
           "    <dc:rights>版权归作者所有</dc:rights>\n"
           f"    <dc:source>{attr(work_url(w['id']))}</dc:source>\n"
           f'    <meta property="dcterms:modified">{MODIFIED}</meta>\n'
           "  </metadata>\n"
           f"  <manifest>\n{manifest}\n  </manifest>\n"
           f'  <spine toc="ncx">\n{spine}\n  </spine>\n'
           "</package>\n")

    container = ('<?xml version="1.0" encoding="utf-8"?>\n'
                 '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
                 '  <rootfiles>\n'
                 '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
                 "  </rootfiles>\n</container>\n")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        zi = zipfile.ZipInfo("mimetype", ZIP_TIME)
        zi.compress_type = zipfile.ZIP_STORED
        z.writestr(zi, "application/epub+zip")
        entries = [("META-INF/container.xml", container), ("OEBPS/content.opf", opf)]
        entries += [(f"OEBPS/{p}", v[0]) for p, v in files.items()]
        for name, text in entries:
            zi = zipfile.ZipInfo(name, ZIP_TIME)
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, text if isinstance(text, bytes) else text.encode("utf-8"))
    return buf.getvalue()


# ---------------------------------------------------------------- EPUB 校验

def check_epub(data, label):
    errs = []
    z = zipfile.ZipFile(io.BytesIO(data))
    infos = z.infolist()
    if not infos or infos[0].filename != "mimetype":
        errs.append("mimetype 不是第一个文件")
    else:
        if infos[0].compress_type != zipfile.ZIP_STORED:
            errs.append("mimetype 被压缩")
        if infos[0].extra:
            errs.append("mimetype 带 extra 字段")
        if z.read("mimetype") != b"application/epub+zip":
            errs.append("mimetype 内容错误")
        # 本地文件头里 mimetype 必须从偏移 38 开始（OCF 要求）
        if data[30:38] != b"mimetype" or data[38:58] != b"application/epub+zip":
            errs.append("mimetype 未位于偏移 38")
    names = set(z.namelist())
    if z.testzip() is not None:
        errs.append("zip CRC 错误")
    try:
        c = ET.fromstring(z.read("META-INF/container.xml"))
        ns = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
        opf_path = c.find(".//c:rootfile", ns).get("full-path")
    except Exception as e:  # noqa: BLE001
        return errs + [f"container.xml 错误：{e}"]
    if opf_path not in names:
        return errs + [f"缺少 {opf_path}"]
    base = opf_path.rsplit("/", 1)[0] + "/" if "/" in opf_path else ""
    opf = ET.fromstring(z.read(opf_path))
    O = "{http://www.idpf.org/2007/opf}"
    DC = "{http://purl.org/dc/elements/1.1/}"
    md = opf.find(f"{O}metadata")
    uid = opf.get("unique-identifier")
    ident = [e for e in md.findall(f"{DC}identifier") if e.get("id") == uid]
    if not ident or not ident[0].text.startswith("urn:uuid:"):
        errs.append("缺少 urn:uuid 标识")
    for tag in ("title", "creator", "language"):
        if md.find(f"{DC}{tag}") is None or not (md.find(f"{DC}{tag}").text or "").strip():
            errs.append(f"缺少 dc:{tag}")
    if (md.find(f"{DC}language").text or "") != "zh-CN":
        errs.append("dc:language 不是 zh-CN")
    if not any(m.get("property") == "dcterms:modified" for m in md.findall(f"{O}meta")):
        errs.append("缺少 dcterms:modified")
    items = {}
    has_nav = False
    for it in opf.find(f"{O}manifest").findall(f"{O}item"):
        href = base + it.get("href")
        items[it.get("id")] = href
        if href not in names:
            errs.append(f"manifest 文件缺失：{href}")
        if "nav" in (it.get("properties") or "").split():
            has_nav = True
    if not has_nav:
        errs.append("manifest 没有 nav 项")
    listed = set(items.values()) | {"mimetype", "META-INF/container.xml", opf_path}
    for n in names - listed:
        errs.append(f"文件未列入 manifest：{n}")
    for ref in opf.find(f"{O}spine").findall(f"{O}itemref"):
        if ref.get("idref") not in items:
            errs.append(f"spine 引用不存在：{ref.get('idref')}")
    X = "{http://www.w3.org/1999/xhtml}"
    for n in sorted(names):
        if n.endswith((".xhtml", ".ncx", ".opf", ".xml")):
            try:
                root = ET.fromstring(z.read(n))
            except ET.ParseError as e:
                errs.append(f"{n} 不是合法 XML：{e}")
                continue
            if n.endswith(".xhtml"):
                if root.tag != f"{X}html":
                    errs.append(f"{n} 根元素不是 XHTML html")
                # 内部链接目标存在
                for a in root.iter(f"{X}a"):
                    href = a.get("href", "")
                    if href and "://" not in href and not href.startswith("#"):
                        if base + href.split("#")[0] not in names:
                            errs.append(f"{n} 链接失效：{href}")
    return [f"{label}: {e}" for e in errs]


# ---------------------------------------------------------------- 获奖名单

def make_list(meta, works):
    by_id = {w["id"]: w for w in works}
    c = meta["contest"]
    lines = [f"{c['name']}获奖名单", ""]
    total = 0
    for j in meta["juries"]:
        lines += [f"【{j['name']}】", ""]
        for t in j["tiers"]:
            n = len(t["works"])
            subtotal = t["prize"] * (n if t["each"] else 1)
            total += subtotal
            prize = f"奖金各 {money(t['prize'])} 元" if t["each"] else f"奖金 {money(t['prize'])} 元"
            head = t["name"] if t["name"] != j["name"] else j["name"]
            lines.append(f"{head}（{n} 部，{prize}）")
            for wid in t["works"]:
                w = by_id[wid]
                lines.append(f"{INDENT}《{w['title']}》　{w['author']}")
            lines.append("")
    lines += [f"奖金合计 {money(total)} 元", "",
              "AI 辅助说明：", c["aiNote"], "",
              announce_text(meta), "",
              "作品版权归作者所有。", f"在线阅读：{SITE}/", ""]
    return "﻿" + EOL.join(lines), total


# ---------------------------------------------------------------- main

def main():
    meta, works = load()
    OUT.mkdir(parents=True, exist_ok=True)
    errors = []
    produced = []
    bundle = []  # (zip 内名, bytes)
    for w in works:
        txt = make_txt(meta, w).encode("utf-8")
        epub = make_epub(meta, w)
        errors += check_epub(epub, f"{w['id']}.epub")
        (OUT / f"{w['id']}.txt").write_bytes(txt)
        (OUT / f"{w['id']}.epub").write_bytes(epub)
        produced += [(f"{w['id']}.txt", len(txt)), (f"{w['id']}.epub", len(epub))]
        bundle += [(zip_name(w, "txt"), txt), (zip_name(w, "epub"), epub)]

    lst, total = make_list(meta, works)
    bundle.append(("获奖名单.txt", lst.encode("utf-8")))
    names = [n for n, _ in bundle]
    if len(set(names)) != len(names):
        errors.append("合集 zip 内文件名重复")

    tmp = OUT / (ALL_ZIP + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, data in [bundle[-1]] + bundle[:-1]:
            zi = zipfile.ZipInfo(name, ZIP_TIME)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.flag_bits |= 0x800  # UTF-8 文件名
            z.writestr(zi, data)
    tmp.replace(OUT / ALL_ZIP)
    with zipfile.ZipFile(OUT / ALL_ZIP) as z:
        if z.testzip() is not None or len(z.namelist()) != len(bundle):
            errors.append("合集 zip 校验失败")
    produced.append((ALL_ZIP, (OUT / ALL_ZIP).stat().st_size))

    for name, size in produced:
        print(f"  {name:36s} {size / 1024:8.1f} KB")
    print(f"共 {len(works)} 部作品，奖金合计 {money(total)} 元，输出目录 {OUT.relative_to(ROOT)}/")
    if errors:
        print("校验失败：", file=sys.stderr)
        for e in errors:
            print("  " + e, file=sys.stderr)
        sys.exit(1)
    print("EPUB 结构校验通过（mimetype、container、opf 元数据、manifest、XHTML 解析、内部链接）")


if __name__ == "__main__":
    main()
