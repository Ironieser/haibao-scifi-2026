"""把原始稿件（docx / pdf / txt）转成统一的段落块 JSON。

用法：python3 -I scripts/convert.py <稿件根目录> <输出目录> [作品 id ...]
输出：<输出目录>/<id>.json  ->  {"body": [...blocks], "notes": [{"title":..., "body": [...]}]}
附录 PDF 中的截图另存到 art/notes/<id>/<n>.jpg。

block：
  {"t": "h"|"p"|"c", "x": 纯文本, "m"?: [[start, end, kind], ...], "cls"?: 段落样式}
      kind ∈ b 粗体 / i 斜体 / u 下划线 / code 行内灰框；下标按 x 的字符计，左闭右开
      cls ∈ doc / letter / alt / epi / sys / q / code / box / right
  {"t": "li", "x", "m"?, "lvl": 0|1, "mk": "•"|"1."|...}   列表项
  {"t": "hr"}                                              分场
  {"t": "table", "rows": [[...]]}
  {"t": "img", "src": "<id>/<n>.jpg", "w": px, "h": px}    附录截图
只依赖标准库与 poppler 命令行工具（pdftohtml / pdftocairo / pdftoppm）。
"""
import collections
import json
import re
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
O = "{urn:schemas-microsoft-com:office:office}"
MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"

WARN = []


def warn(msg):
    WARN.append(msg)
    print("  ! " + msg)


# CJK 部首补充区（⻅ ⻔ …）没有 NFKC 分解，按简体字形对照；康熙部首区（⼀ ⽰）用 NFKC，
# 个别 NFKC 得到繁体的（⼾ -> 戶）改为简体。PDF 字体 cmap 偶见的异体（㬵）也一并归一。
RADICALS = str.maketrans({
    "⺟": "母", "⺠": "民", "⻄": "西", "⻅": "见", "⻆": "角", "⻋": "车", "⻉": "贝", "⻓": "长",
    "⻔": "门", "⻘": "青", "⻙": "韦", "⻚": "页", "⻛": "风", "⻜": "飞", "⻝": "食", "⻢": "马",
    "⻣": "骨", "⻤": "鬼", "⻥": "鱼", "⻦": "鸟", "⻨": "麦", "⻩": "黄", "⻬": "齐", "⻮": "齿",
    "⻰": "龙", "⻳": "龟", "⼾": "户", "\u3b35": "胶",
})

TAB = "\x01"      # 段内制表符 -> 两个全角空格
MISSING = "\ufffd"  # PDF 中无 Unicode 映射的字形（由 clean.py 按上下文补字）
KINDS = ("b", "i", "u", "code")


def norm_char(ch: str) -> str:
    ch = ch.translate(RADICALS)
    cp = ord(ch)
    # PDF 中常见康熙部首/兼容汉字（⼀ ⽰ ⻅），NFKC 可还原；但 NFKC 也会把全角标点变半角，
    # 所以只对 CJK 兼容区字符做归一化。
    if 0x2E80 <= cp <= 0x2FDF or 0xF900 <= cp <= 0xFAFF or 0x2F800 <= cp <= 0x2FA1F:
        return unicodedata.normalize("NFKC", ch)
    if ch in "\u00a0\u3000\t\r\n\u2002\u2003\u2009":
        return " "
    if ch in "\ufeff\u200b\u200e\u200f":
        return ""
    return ch


def norm(s: str) -> str:
    s = "".join(norm_char(c) for c in s)
    return re.sub(r" +", " ", s).strip()


# ---------------- 富文本：逐字符记录格式 ----------------

def rich(segs, keep_space=False, md=True):
    """segs: [(text, fmtset)] -> (x, m)。做与 norm 相同的归一化并保持格式下标对齐。"""
    chars = []
    for text, fmt in segs:
        fmt = frozenset(fmt or ())
        for c in text:
            if c == TAB:
                chars.append((TAB, fmt))
                continue
            for d in norm_char(c):
                chars.append((d, fmt))
    if not keep_space:
        out = []
        for c, f in chars:
            if c == " " and (not out or out[-1][0] in (" ", TAB)):
                continue
            if c == TAB and out and out[-1][0] == " ":
                out.pop()
            if c == TAB and out and out[-1][0] == TAB:
                continue
            out.append((c, f))
        chars = out
    while chars and chars[0][0] in (" ", TAB):
        chars.pop(0)
    while chars and chars[-1][0] in (" ", TAB):
        chars.pop()
    exp = []
    for c, f in chars:
        if c == TAB:
            exp += [("\u3000", f), ("\u3000", f)]
        else:
            exp.append((c, f))
    chars = exp
    if md:
        chars = md_bold(chars)
    x = "".join(c for c, _ in chars)
    return x, spans(chars)


def md_bold(chars):
    """Markdown **粗体**：成对的 ** 去掉并标 b；不配对的 * 原样保留。"""
    s = "".join(c for c, _ in chars)
    if "**" not in s:
        return chars
    pairs = []
    for mt in re.finditer(r"\*\*(?=\S)(.+?)(?<=\S)\*\*", s):
        pairs.append((mt.start(), mt.end()))
    if not pairs:
        return chars
    out = []
    pi = 0
    i = 0
    while i < len(chars):
        if pi < len(pairs) and i == pairs[pi][0]:
            a, b = pairs[pi]
            for c, f in chars[a + 2:b - 2]:
                out.append((c, f | {"b"}))
            i = b
            pi += 1
            continue
        out.append(chars[i])
        i += 1
    return out


def spans(chars):
    m = []
    for k in KINDS:
        start = None
        for i, (c, f) in enumerate(chars + [("", frozenset())]):
            on = k in f
            if on and start is None:
                start = i
            elif not on and start is not None:
                a, b = start, i
                while a < b and chars[a][0] == " ":
                    a += 1
                while b > a and chars[b - 1][0] == " ":
                    b -= 1
                if b > a:
                    m.append([a, b, k])
                start = None
    m.sort(key=lambda r: (r[0], r[1], KINDS.index(r[2])))
    return m


def mkblock(t, x, m=None, **kw):
    b = {"t": t, "x": x}
    if m:
        b["m"] = m
    for k, v in kw.items():
        if v is not None:
            b[k] = v
    return b


EDGE_PUNCT = "“”\"‘’'「」『』（）()《》【】[]。，、！？!?：:；;…—- \u3000"


def full_kinds(b):
    """整段覆盖的格式集合（首尾标点不计）。"""
    x = b.get("x", "")
    a = len(x) - len(x.lstrip(EDGE_PUNCT))
    z = len(x.rstrip(EDGE_PUNCT))
    if z <= a:
        a, z = 0, len(x)
    return {k for s, e, k in b.get("m", []) if s <= a and e >= z}


def drop_kinds(b, kinds):
    m = [r for r in b.get("m", []) if r[2] not in kinds]
    if m:
        b["m"] = m
    else:
        b.pop("m", None)


def shift_m(m, off, n=None):
    out = []
    for s, e, k in m or []:
        s2, e2 = s + off, e + off
        if n is not None:
            s2, e2 = max(0, s2), min(n, e2)
        if e2 > s2:
            out.append([s2, e2, k])
    return out


# ---------------- 标题 / 列表 判定 ----------------

HEAD_RE = re.compile(
    r"^(#+\s*)?(第[一二三四五六七八九十百零〇\d]+[章节回部卷幕篇](\s|：|:|$)|[一二三四五六七八九十]{1,3}([、：:.．]|（P\.\d+）|$)|\d{1,2}([.、．]|$)|"
    r"P\.\d+|尾声|序章|序幕|楔子|终章|后记|附录|片段[一二三四五六七八九十]+)"
)
RULE_RE = re.compile(r"^[*＊·•※\-—_~～=─━]+( ?[*＊·•※\-—_~～=─━]+)*$")
MD_HEAD_RE = re.compile(r"^#{1,6}\s+")
MD_LI_RE = re.compile(r"^(?:([-*])\s+|([•●▪◦])\s*)")
DIALOG_RE = re.compile(r"^\d+\s*[.．、]\s*(我|Claude\d*|ChatGPT|Gemini|DeepSeek|豆包|AI)\s*[：:]?$", re.I)


def looks_heading(x: str) -> bool:
    mt = HEAD_RE.match(x)
    if not mt or len(x) > 30 or DIALOG_RE.match(x) or re.search(r"[。！？]|[，、]$", x):
        return False
    # 以冒号结尾、且编号之后还有内容的是字段标签/对话标签（“1.Claude：”），不是标题；“一：”“第五章：”仍是标题
    if x.endswith(("：", ":")) and len(x[mt.end():].rstrip("：:")) > 0:
        return False
    return True


def strip_prefix(b, n):
    """从块文本开头去掉 n 个字符，m 随之平移。"""
    x = b["x"][n:]
    lead = len(x) - len(x.lstrip())
    x = x.strip()
    b["x"] = x
    if "m" in b:
        b["m"] = shift_m(b["m"], -(n + lead), len(x))
        if not b["m"]:
            del b["m"]
    return b


def md_line(b):
    """Markdown 行首记号：# 标题、- 列表。"""
    x = b["x"]
    mt = MD_HEAD_RE.match(x)
    if mt and "b" not in full_kinds(b) and len(x) <= 40:  # “**# 系统输出……**”不是标题
        strip_prefix(b, mt.end())
        b["t"] = "h"
        drop_kinds(b, {"b"})
        return b
    mt = MD_LI_RE.match(x)
    if mt and b["t"] == "p" and len(x) > mt.end() and not RULE_RE.match(x):
        strip_prefix(b, mt.end())
        b["t"] = "li"
        b["lvl"] = 0
        b["mk"] = "•"
    return b


# ---------------- docx ----------------

def on(el):
    return el is not None and el.get(W + "val") not in ("0", "false", "none", "off")


CN_DIGITS = "〇一二三四五六七八九"


def cn_num(n):
    if n <= 0:
        return str(n)
    if n < 10:
        return CN_DIGITS[n]
    if n < 20:
        return "十" + (CN_DIGITS[n % 10] if n % 10 else "")
    if n < 100:
        return CN_DIGITS[n // 10] + "十" + (CN_DIGITS[n % 10] if n % 10 else "")
    return str(n)


def roman(n):
    vals = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
            (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]
    out = ""
    for v, s in vals:
        while n >= v:
            out += s
            n -= v
    return out


CJK_FMTS = {"chineseCounting", "chineseCountingThousand", "japaneseCounting", "ideographTraditional",
            "ideographZodiac", "chineseLegalSimplified", "ideographDigital", "taiwaneseCounting",
            "taiwaneseCountingThousand", "japaneseLegal", "koreanCounting"}


def fmt_num(n, fmt):
    if fmt in ("decimal", "decimalHalfWidth"):
        return str(n)
    if fmt == "decimalZero":
        return f"{n:02d}"
    if fmt == "lowerLetter":
        return chr(ord("a") + (n - 1) % 26)
    if fmt == "upperLetter":
        return chr(ord("A") + (n - 1) % 26)
    if fmt == "lowerRoman":
        return roman(n).lower()
    if fmt == "upperRoman":
        return roman(n)
    if fmt == "decimalEnclosedCircle" or fmt == "decimalEnclosedCircleChinese":
        return chr(0x2460 + n - 1) if 1 <= n <= 20 else str(n)
    if fmt == "ideographTraditional":
        return "甲乙丙丁戊己庚辛壬癸"[(n - 1) % 10]
    if fmt == "chineseLegalSimplified":
        return cn_num(n).translate(str.maketrans("一二三四五六七八九十", "壹贰叁肆伍陆柒捌玖拾"))
    if fmt == "ideographDigital":
        return "".join(CN_DIGITS[int(d)] for d in str(n))
    if fmt in CJK_FMTS:
        return cn_num(n)
    return str(n)


class Numbering:
    def __init__(self, z):
        self.nums = {}     # numId -> (abstractId, {ilvl: startOverride})
        self.abs = {}      # abstractId -> {ilvl: dict}
        self.count = {}    # numId -> {ilvl: n}
        try:
            root = ET.fromstring(z.read("word/numbering.xml"))
        except KeyError:
            return
        for an in root.iter(W + "abstractNum"):
            lv = {}
            for l in an.findall(W + "lvl"):
                d = {}
                for k in ("start", "numFmt", "lvlText", "suff"):
                    e = l.find(W + k)
                    d[k] = e.get(W + "val") if e is not None else None
                lv[int(l.get(W + "ilvl"))] = d
            self.abs[an.get(W + "abstractNumId")] = lv
        for n in root.iter(W + "num"):
            a = n.find(W + "abstractNumId")
            ov = {}
            for lo in n.findall(W + "lvlOverride"):
                so = lo.find(W + "startOverride")
                if so is not None:
                    ov[int(lo.get(W + "ilvl"))] = int(so.get(W + "val"))
            self.nums[n.get(W + "numId")] = (a.get(W + "val") if a is not None else None, ov)

    def next(self, numId, ilvl):
        """返回 (kind, label, suff)；kind: bullet / inline(编号是正文一部分) / list。"""
        if numId not in self.nums or numId == "0":
            return None
        aid, ov = self.nums[numId]
        lv = self.abs.get(aid, {})
        d = lv.get(ilvl)
        if d is None:
            return None
        cnt = self.count.setdefault(numId, {})
        start = ov.get(ilvl, int(d.get("start") or 1))
        cnt[ilvl] = cnt.get(ilvl, start - 1) + 1
        for deeper in [k for k in cnt if k > ilvl]:
            del cnt[deeper]
        fmt = d.get("numFmt") or "decimal"
        text = d.get("lvlText") or ""
        if fmt == "bullet" or fmt == "none":
            return ("bullet", "•" if ilvl % 2 == 0 else "◦", d.get("suff"))

        def sub(mt):
            k = int(mt.group(1)) - 1
            ld = lv.get(k, {})
            n = cnt.get(k, int(ld.get("start") or 1))
            return fmt_num(n, ld.get("numFmt") or "decimal")

        label = re.sub(r"%(\d)", sub, text)
        kind = "inline" if fmt in CJK_FMTS or re.search(r"[\u4e00-\u9fff]", text) else "list"
        return (kind, label, d.get("suff"))


class Styles:
    def __init__(self, z):
        self.st = {}
        self.default_para = None
        self.defaults = {}
        self.theme = {}
        try:
            th = ET.fromstring(z.read("word/theme/theme1.xml"))
            for kind in ("majorFont", "minorFont"):
                f = th.find(f".//{A}{kind}")
                if f is None:
                    continue
                ea = f.find(A + "ea")
                name = ea.get("typeface") if ea is not None else ""
                if not name:
                    for fe in f.findall(A + "font"):
                        if fe.get("script") == "Hans":
                            name = fe.get("typeface")
                self.theme[kind.replace("Font", "")] = name or ""
        except (KeyError, ET.ParseError):
            pass
        try:
            root = ET.fromstring(z.read("word/styles.xml"))
        except KeyError:
            return
        dd = root.find(W + "docDefaults")
        if dd is not None:
            rpr = dd.find(f"{W}rPrDefault/{W}rPr")
            if rpr is not None:
                self.defaults = self.rpr_props(rpr)
        for s in root.iter(W + "style"):
            sid = s.get(W + "styleId")
            nm = s.find(W + "name")
            based = s.find(W + "basedOn")
            self.st[sid] = {
                "name": (nm.get(W + "val") if nm is not None else "").lower(),
                "type": s.get(W + "type"),
                "based": based.get(W + "val") if based is not None else None,
                "pPr": s.find(W + "pPr"),
                "rPr": self.rpr_props(s.find(W + "rPr")),
            }
            if s.get(W + "type") == "paragraph" and s.get(W + "default") in ("1", "true"):
                self.default_para = sid

    def font_of(self, rf):
        if rf is None:
            return None
        if rf.get(W + "eastAsia"):
            return rf.get(W + "eastAsia")
        th = rf.get(W + "eastAsiaTheme")
        if th:
            return self.theme.get("major" if th.startswith("major") else "minor") or th
        return None

    def rpr_props(self, rpr):
        d = {}
        if rpr is None:
            return d
        for k in ("b", "i"):
            e = rpr.find(W + k)
            if e is not None:
                d[k] = on(e)
        u = rpr.find(W + "u")
        if u is not None:
            d["u"] = u.get(W + "val") not in ("none", "0", "false", None) or u.get(W + "val") is None
        c = rpr.find(W + "color")
        if c is not None:
            d["color"] = (c.get(W + "val") or "auto").upper()
        f = self.font_of(rpr.find(W + "rFonts"))
        if f:
            d["font"] = f
        rf = rpr.find(W + "rFonts")
        if rf is not None and rf.get(W + "ascii"):
            d["afont"] = rf.get(W + "ascii")
        sz = rpr.find(W + "sz")
        if sz is not None and sz.get(W + "val"):
            try:
                d["sz"] = float(sz.get(W + "val"))
            except ValueError:
                pass
        sh = rpr.find(W + "shd")
        if sh is not None and (sh.get(W + "fill") or "auto").upper() not in ("AUTO", "FFFFFF"):
            d["shd"] = sh.get(W + "fill")
        hl = rpr.find(W + "highlight")
        if hl is not None and hl.get(W + "val") not in ("none", None):
            d["shd"] = hl.get(W + "val")
        return d

    def chain(self, sid):
        out = []
        seen = set()
        while sid and sid in self.st and sid not in seen:
            seen.add(sid)
            out.append(self.st[sid])
            sid = self.st[sid]["based"]
        return out[::-1]

    def run_base(self, pstyle):
        d = {"font": self.theme.get("minor") or "", **self.defaults}
        for s in self.chain(pstyle or self.default_para):
            d.update(s["rPr"])
        return d

    def char_style(self, rsid):
        d = {}
        for s in self.chain(rsid):
            d.update(s["rPr"])
        return d

    def ppr_find(self, pstyle, tag):
        for s in reversed(self.chain(pstyle or self.default_para)):
            if s["pPr"] is not None:
                e = s["pPr"].find(W + tag)
                if e is not None:
                    return e
        return None

    def is_heading(self, sid):
        n = self.st.get(sid, {}).get("name", "")
        return n.startswith("heading") or n == "title" or n.startswith("标题")


def docx_runs(p, styles, pstyle):
    """段落 -> [(text, props)]；text 中 '\n' 为段内换行，TAB 为制表符。另返回是否含水平线图形。"""
    base = styles.run_base(pstyle)
    out = []
    has_hr = False

    def run(r):
        nonlocal has_hr
        rpr = r.find(W + "rPr")
        props = dict(base)
        if rpr is not None:
            rs = rpr.find(W + "rStyle")
            if rs is not None:
                props.update(styles.char_style(rs.get(W + "val")))
            props.update(styles.rpr_props(rpr))
        buf = []
        for el in r:
            tag = el.tag
            if tag == W + "t":
                buf.append(el.text or "")
            elif tag == W + "tab":
                buf.append(TAB)
            elif tag == W + "br":
                if el.get(W + "type") in (None, "textWrapping"):
                    buf.append("\n")
            elif tag == W + "cr":
                buf.append("\n")
            elif tag == W + "noBreakHyphen":
                buf.append("-")
            elif tag == W + "sym":
                ch = el.get(W + "char") or ""
                try:
                    c = chr(int(ch, 16))
                    if not (0xE000 <= ord(c) <= 0xF8FF or 0xF000 <= ord(c) <= 0xF0FF):
                        buf.append(c)
                except ValueError:
                    pass
            elif tag == W + "pict" or tag == MC + "AlternateContent" or tag == W + "drawing":
                for rect in el.iter():
                    if rect.get(O + "hr") == "t":
                        has_hr = True
        if buf:
            out.append(("".join(buf), props))

    def walk(el):
        for ch in el:
            tag = ch.tag
            if tag == W + "r":
                run(ch)
            elif tag in (W + "hyperlink", W + "ins", W + "smartTag", W + "sdt", W + "sdtContent",
                         W + "customXml", W + "fldSimple", W + "moveTo", W + "bdo", W + "dir"):
                walk(ch)
            # w:del / w:moveFrom / w:pPr 跳过
    walk(p)
    return out, has_hr


def run_fmt(props):
    f = set()
    if props.get("b"):
        f.add("b")
    if props.get("i"):
        f.add("i")
    if props.get("u"):
        f.add("u")
    return f


def is_cjk(c):
    """汉字（含扩展 A、康熙部首/部首补充、兼容汉字：PDF 文本常用这些码位）。"""
    return ("\u4e00" <= c <= "\u9fff" or "\u3400" <= c <= "\u4dbf" or "\u2e80" <= c <= "\u2fdf"
            or "\uf900" <= c <= "\ufaff")


class DocxPara:
    """一个 Word 段落的分析结果。"""

    def __init__(self):
        self.lines = []   # [[(text, props)]]，按段内换行拆开
        self.style = None
        self.jc = None
        self.num = None
        self.ilvl = 0
        self.bdr_top = self.bdr_bottom = None
        self.has_hr = False
        self.empty = True


def docx_paragraph(p, styles):
    d = DocxPara()
    ppr = p.find(W + "pPr")
    if ppr is not None:
        ps = ppr.find(W + "pStyle")
        d.style = ps.get(W + "val") if ps is not None else None
    jc = (ppr.find(W + "jc") if ppr is not None else None)
    if jc is None:
        jc = styles.ppr_find(d.style, "jc")
    d.jc = jc.get(W + "val") if jc is not None else None
    numpr = ppr.find(W + "numPr") if ppr is not None else None
    if numpr is None:
        numpr = styles.ppr_find(d.style, "numPr")
    if numpr is not None:
        ni = numpr.find(W + "numId")
        il = numpr.find(W + "ilvl")
        d.num = ni.get(W + "val") if ni is not None else None
        d.ilvl = int(il.get(W + "val")) if il is not None else 0
    bdr = ppr.find(W + "pBdr") if ppr is not None else None
    if bdr is None:
        bdr = styles.ppr_find(d.style, "pBdr")
    if bdr is not None:
        for side in ("top", "bottom"):
            e = bdr.find(W + side)
            if e is not None and e.get(W + "val") not in ("none", "nil", None):
                setattr(d, "bdr_" + side, ET.tostring(bdr))
    runs, d.has_hr = docx_runs(p, styles, d.style)
    cur = []
    for text, props in runs:
        parts = text.split("\n")
        for k, part in enumerate(parts):
            if k:
                d.lines.append(cur)
                cur = []
            if part:
                cur.append((part, props))
    d.lines.append(cur)
    d.empty = not any(norm(t.replace(TAB, " ")) for ln in d.lines for t, _ in ln)
    return d


def line_stats(line):
    """一行的字体/颜色/格式统计（只计非空白字符）。"""
    st = collections.Counter()
    fonts = collections.Counter()
    colors = collections.Counter()
    n = 0
    for text, props in line:
        k = sum(1 for c in text if not c.isspace() and c != TAB)
        if not k:
            continue
        n += k
        kc = sum(1 for c in text if is_cjk(c))
        if kc:
            fonts[props.get("font") or ""] += kc
        colors[(props.get("color") or "AUTO")] += k
        for f in ("b", "i", "u"):
            if props.get(f):
                st[f] += k
        if props.get("shd"):
            st["shd"] += k
    return n, st, fonts, colors


GRAYISH = re.compile(r"^([0-9A-F]{2})\1\1$")


def color_kind(c):
    c = (c or "AUTO").upper()
    if c in ("AUTO", "000000", "111111", "191919", "1A1A1A", "212121", "222222", "242424", "262626", "333333", "0F1115", "1F1F1F"):
        return "black"
    mt = GRAYISH.match(c)
    if mt:
        return "gray" if int(mt.group(1), 16) >= 0x40 else "black"
    return "color"


def convert_docx(path: Path, ctx):
    z = zipfile.ZipFile(path)
    styles = Styles(z)
    numbering = Numbering(z)
    doc = ET.fromstring(z.read("word/document.xml"))
    body = doc.find(W + "body")
    items = []   # DocxPara 或 ("table", rows)

    def walk(el):
        for ch in el:
            if ch.tag == W + "p":
                items.append(docx_paragraph(ch, styles))
            elif ch.tag == W + "tbl":
                rows = []
                for tr in ch.iter(W + "tr"):
                    cells = []
                    for tc in tr.findall(W + "tc"):
                        txt = []
                        for pp in tc.iter(W + "p"):
                            rr, _ = docx_runs(pp, styles, None)
                            txt.append("".join(t for t, _ in rr))
                        cells.append(norm(" ".join(txt).replace(TAB, " ")))
                    if any(cells):
                        rows.append(cells)
                if rows:
                    items.append(("table", rows))
            elif ch.tag in (W + "sdt", W + "sdtContent", W + "customXml", W + "smartTag"):
                walk(ch)

    walk(body)

    # 全文主字体（按汉字数众数）
    fonts = collections.Counter()
    for it in items:
        if isinstance(it, DocxPara):
            for ln in it.lines:
                fonts.update(line_stats(ln)[2])
    main_font = fonts.most_common(1)[0][0] if fonts else ""

    # 空段基线
    paras = [it for it in items if isinstance(it, DocxPara)]
    counts = collections.Counter()
    run = 0
    seen = False
    for it in items:
        if isinstance(it, DocxPara) and it.empty and not it.has_hr:
            run += 1
            continue
        if seen:
            counts[run] += 1
        seen = True
        run = 0
    baseline = counts.most_common(1)[0][0] if counts else 0
    n_empty = sum(1 for p in paras if p.empty)
    empty_ratio = n_empty / max(1, len(paras))
    if baseline == 0 and empty_ratio >= 0.05:
        gap_th = None          # 空段只是随手的段距，不判分场
    else:
        gap_th = baseline + 1  # 空段数 >= gap_th 即分场
    ctx["main_font"] = main_font

    out = []          # (block, meta)
    pending_empty = 0
    prev_bdr = None
    for idx, it in enumerate(items):
        if isinstance(it, tuple):
            out.append(({"t": "table", "rows": it[1]}, {"empties": pending_empty}))
            pending_empty = 0
            continue
        if it.empty:
            if it.has_hr:
                out.append(({"t": "hr"}, {"empties": pending_empty, "src": "pict"}))
                pending_empty = 0
            else:
                pending_empty += 1
            # 带边框的空段（转人工一处 top+bottom 的段在正文里）
            if it.bdr_bottom or it.bdr_top:
                out.append(({"t": "hr"}, {"empties": 0, "src": "bdr"}))
            continue
        nxt = items[idx + 1] if idx + 1 < len(items) else None
        blocks = docx_para_blocks(it, styles, numbering, main_font)
        if not blocks:
            continue
        if it.bdr_top and it.bdr_top != prev_bdr:
            out.append(({"t": "hr"}, {"empties": 0, "src": "bdr"}))
        first = True
        for b in blocks:
            out.append((b, {"empties": pending_empty if first else 0}))
            first = False
        pending_empty = 0
        if it.bdr_bottom:
            same_next = isinstance(nxt, DocxPara) and nxt.bdr_bottom == it.bdr_bottom and not nxt.empty
            if not same_next:
                out.append(({"t": "hr"}, {"empties": 0, "src": "bdr"}))
        prev_bdr = it.bdr_bottom or it.bdr_top

    # 空段分场
    res = []
    for i, (b, meta) in enumerate(out):
        e = meta["empties"]
        if gap_th is not None and e >= gap_th and res and b["t"] not in ("h", "hr") and res[-1]["t"] not in ("h", "hr"):
            res.append({"t": "hr", "_src": "empty"})
        res.append(b)
    # 去掉相邻重复 hr
    final = []
    for b in res:
        if b["t"] == "hr" and final and final[-1]["t"] == "hr":
            continue
        final.append(b)
    while final and final[-1]["t"] == "hr" and final[-1].get("_src") == "empty":
        final.pop()
    return classify_docx(final, ctx)


def docx_para_blocks(d, styles, numbering, main_font):
    numinfo = numbering.next(d.num, d.ilvl) if d.num else None
    heading_style = styles.is_heading(d.style)
    out = []
    for li, line in enumerate(d.lines):
        segs = [(t, run_fmt(p)) for t, p in line]
        x, m = rich(segs)
        if not x:
            continue
        n, st, fonts, colors = line_stats(line)
        meta = {
            "font": fonts.most_common(1)[0][0] if fonts else None,
            "color": colors.most_common(1)[0][0] if colors else "AUTO",
            "shd": st["shd"] >= n * 0.9 if n else False,
            "n": n,
            "jc": d.jc,
        }
        if RULE_RE.match(x):
            out.append({"t": "hr"})
            continue
        b = mkblock("p", x, m)
        b["_meta"] = meta
        if li == 0 and numinfo:
            kind, label, suff = numinfo
            if kind == "inline":
                sep = "" if (suff == "nothing" or re.search(r"[，、：:,.．]$", label)) else " "
                b["x"] = label + sep + x
                b["m"] = shift_m(m, len(label + sep))
                if not b["m"]:
                    del b["m"]
            else:
                b["t"] = "li"
                b["lvl"] = min(d.ilvl, 1)
                b["mk"] = label
        x = b["x"]
        if b["t"] == "p":
            md_line(b)
            if b["t"] == "h":
                out.append(b)
                continue
        if b["t"] == "li":
            out.append(b)
            continue
        x = b["x"]
        short = len(x) <= 30 and not re.search(r"[。！？，”」…]$", x)
        if (heading_style and short and not x.endswith(("：", ":"))) or looks_heading(x):
            b["t"] = "h"
            drop_kinds(b, {"b"})
        elif d.jc == "center" and short:
            b["t"] = "c"
        elif d.jc in ("right", "end") and len(x) <= 40:
            b["cls"] = "right"
        out.append(b)
    return out


FANGSONG = re.compile(r"仿宋|FangSong|STFangsong", re.I)


def classify_docx(blocks, ctx):
    """整段格式 -> cls：letter / doc / box / epi / alt。"""
    main_font = ctx.get("main_font") or ""
    n = len(blocks)
    for b in blocks:
        meta = b.get("_meta")
        if not meta or b["t"] not in ("p", "c", "li", "h"):
            continue
        full = full_kinds(b)
        ck = color_kind(meta["color"])
        font = meta["font"]
        meta["alt"] = bool(font) and font != main_font and meta["n"] >= 2
        meta["gray"] = ck == "gray"
        if b["t"] == "h":
            continue
        if "i" in full and ck == "color":
            b["cls"] = "letter"          # 彩色整段斜体：书信
            drop_kinds(b, {"i"})
        elif "u" in full and "i" not in full and len(b["x"]) >= 2:
            b["cls"] = "doc"             # 整段下划线：公文/病例引文
            drop_kinds(b, {"u"})
    # 异体字体区：同一非主字体的连续段落（中间可隔 hr / 表格 / 同字体标题）
    i = 0
    while i < n:
        meta = blocks[i].get("_meta")
        if not meta or not meta.get("alt") or blocks[i].get("cls"):
            i += 1
            continue
        font = meta["font"]
        members = [i]
        j = i + 1
        while j < n:
            bj = blocks[j]
            mj = bj.get("_meta")
            if mj is None and bj["t"] in ("hr", "table"):
                j += 1
                continue
            if mj and mj.get("alt") and mj["font"] == font and not bj.get("cls"):
                members.append(j)
                j += 1
                continue
            break
        last = members[-1]
        text_members = [k for k in members if blocks[k]["t"] != "h"]
        if FANGSONG.search(font or "") and len(text_members) >= 3:
            cls = "box"
            first = i
            # 区块标题（如“[内部文档 · …]”）常用另一种字体，紧邻时一并纳入
            k = i - 1
            while k >= 0 and i - k <= 3:
                mk_ = blocks[k].get("_meta")
                if blocks[k]["t"] == "hr":
                    k -= 1
                    continue
                if mk_ and mk_.get("alt") and len(blocks[k].get("x", "")) <= 40:
                    first = k
                    k -= 1
                    continue
                break
            span = range(first, last + 1)
        elif all(blocks[k]["_meta"].get("gray") for k in members) and i < 15:
            cls = "epi"
            span = text_members
        else:
            cls = "alt"
            span = text_members
        for k in span:
            if cls == "box" or blocks[k]["t"] != "h":
                blocks[k]["cls"] = cls
        i = last + 1
    # 题记：卷首连续灰字段
    for b in blocks[:15]:
        meta = b.get("_meta")
        if meta and meta.get("gray") and b["t"] in ("p", "c") and not b.get("cls"):
            b["cls"] = "epi"
    # 区块内部的空段只是段距，不是分场
    out = []
    for k, b in enumerate(blocks):
        if b["t"] == "hr" and b.get("_src") == "empty" and b.get("cls") == "box":
            continue
        out.append(b)
    for b in out:
        b.pop("_meta", None)
        b.pop("_src", None)
    return out


# ---------------- pdf ----------------

def run_cmd(args):
    return subprocess.run(args, capture_output=True, check=True).stdout


class Frag:
    __slots__ = ("pg", "x0", "x1", "top", "bot", "size", "family", "color", "text", "b", "i", "code")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))

    @property
    def cy(self):
        return (self.top + self.bot) / 2


ZOOM = 2


def pdf_parse(path: Path, tmp: Path):
    run_cmd(["pdftohtml", "-xml", "-fontfullname", "-zoom", str(ZOOM), "-q", str(path), str(tmp / "doc")])
    xml = (tmp / "doc.xml").read_text("utf-8", "replace")
    xml = re.sub(r"<!DOCTYPE[^>]*>", "", xml)
    root = ET.fromstring(xml)
    fonts = {}
    pages = []
    frags = []
    images = []
    for page in root.iter("page"):
        pg = int(page.get("number")) - 1
        pages.append((float(page.get("width")) / ZOOM, float(page.get("height")) / ZOOM))
        for el in page:
            if el.tag == "fontspec":
                fonts[el.get("id")] = (float(el.get("size")) / ZOOM, el.get("family"), (el.get("color") or "#000000").lower())
            elif el.tag == "text":
                f = fonts[el.get("font")]
                txt = "".join(el.itertext())
                if not txt:
                    continue
                inner = ET.tostring(el, encoding="unicode")
                fam = f[1]
                bold = "<b>" in inner or bool(re.search(r"Bold|Semibold|SemiBold|Heavy|Black", fam))
                ital = "<i>" in inner or bool(re.search(r"Italic|Oblique", fam))
                x0 = float(el.get("left")) / ZOOM
                top = float(el.get("top")) / ZOOM
                frags.append(Frag(pg=pg, x0=x0, x1=x0 + float(el.get("width")) / ZOOM, top=top,
                                  bot=top + float(el.get("height")) / ZOOM, size=f[0], family=fam,
                                  color=f[2], text=txt, b=bold, i=ital,
                                  code=bool(re.search(r"Consolas|Courier|Menlo|Mono|NSimSun", fam))))
            elif el.tag == "image":
                x0 = float(el.get("left")) / ZOOM
                top = float(el.get("top")) / ZOOM
                w = float(el.get("width")) / ZOOM
                h = float(el.get("height")) / ZOOM
                images.append((pg, x0, top, w, h))
    return pages, frags, images


SVG_NUM = re.compile(r"-?\d+(?:\.\d+)?(?:e-?\d+)?")


def pdf_shapes(path: Path, npages: int, tmp: Path):
    """用 pdftocairo -svg 取页面上的填充矩形：返回 {页: [(x0, y0, x1, y1, 灰度, 不透明度)]}。"""
    shapes = {}
    for pg in range(npages):
        out = tmp / f"p{pg}.svg"
        try:
            run_cmd(["pdftocairo", "-svg", "-f", str(pg + 1), "-l", str(pg + 1), str(path), str(out)])
        except subprocess.CalledProcessError:
            continue
        s = out.read_text("utf-8", "replace")
        k = s.find("</defs>")
        s = s[k:] if k >= 0 else s
        lst = []
        for mt in re.finditer(r"<path ([^>]*?)/?>", s):
            a = mt.group(1)
            fm = re.search(r'\bfill="rgb\(([\d.]+)%, ?([\d.]+)%, ?([\d.]+)%\)"', a)
            if not fm or "transform=" in a:
                continue
            dm = re.search(r'\sd="([^"]*)"', a)
            if not dm:
                continue
            nums = [float(v) for v in SVG_NUM.findall(dm.group(1))]
            if len(nums) < 4:
                continue
            xs, ys = nums[0::2], nums[1::2]
            r, g, b = (float(v) for v in fm.groups())
            op = re.search(r'fill-opacity="([\d.]+)"', a)
            op = float(op.group(1)) if op else 1.0
            lum = (r + g + b) / 3
            lst.append((min(xs), min(ys), max(xs), max(ys), lum, op))
        shapes[pg] = lst
    return shapes


def is_cjkp(c):
    return is_cjk(c) or "\u3000" <= c <= "\u303f" or "\uff00" <= c <= "\uffef" or c in "“”‘’…—"


class Line:
    def __init__(self, frags):
        self.frags = sorted(frags, key=lambda f: f.x0)
        self.pg = frags[0].pg
        self.x0 = min(f.x0 for f in frags)
        self.x1 = max(f.x1 for f in frags)
        body = [f for f in frags if f.text.strip()] or frags
        sizes = collections.Counter()
        for f in body:
            sizes[f.size] += len(f.text.strip()) or 1
        self.size = max(f.size for f in body)
        self.msize = sizes.most_common(1)[0][0]
        self.top = min(f.top for f in body)
        self.bot = max(f.bot for f in body)
        hb = [f.bot for f in body if any(is_cjk(c) for c in f.text)] or [f.bot for f in body]
        self.base = sorted(hb)[len(hb) // 2]
        cols = collections.Counter()
        for f in body:
            cols[f.color] += len(f.text.strip())
        self.color = cols.most_common(1)[0][0]
        self.code = all(f.code for f in body if f.text.strip())
        self.cls = None
        self.segs = None
        self.text = None

    def build(self, code_rects=()):
        """拼接行文本 -> [(text, fmt)]；标出行内灰框（code），检测无映射字形留下的空隙。"""
        segs = []
        prev = None
        for f in self.frags:
            fmt = set()
            if f.b:
                fmt.add("b")
            if f.i:
                fmt.add("i")
            rects = [r for r in code_rects if r[0] - 1 < f.x1 and r[2] + 1 > f.x0
                     and r[1] - 2 <= (f.top + f.bot) / 2 <= r[3] + 2]
            if prev is not None and segs:
                gap = f.x0 - prev.x1
                pt = segs[-1][0]
                t = f.text
                if pt and t:
                    a, b = pt[-1], t[0]
                    near_rect = any(abs(f.x0 - r[0]) < f.size or abs(prev.x1 - r[2]) < f.size for r in code_rects)
                    if gap > 0.5 * f.size and is_cjkp(a) and is_cjkp(b) and not near_rect and not self.code:
                        segs.append((MISSING, set()))
                    elif gap > 0.15 * f.size and re.match(r"[A-Za-z0-9,.:;!?)%]", a) and re.match(r"[A-Za-z0-9(]", b):
                        segs.append((" ", set()))
            # 逐字估算横坐标：汉字/全角 1em，其余 0.5em，按片段宽度缩放
            t = f.text
            ws = [1.0 if (is_cjkp(c) and c not in "“”‘’") else 0.5 for c in t]
            tot = sum(ws) or 1
            scale = (f.x1 - f.x0) / tot
            pos = f.x0
            for k, c in enumerate(t):
                cx = pos + ws[k] * scale / 2
                pos += ws[k] * scale
                cf = set(fmt)
                in_rect = any(r[0] - 1 <= cx <= r[2] + 1 for r in rects)
                if in_rect:
                    cf.add("code")
                if c == " " and not self.code and 0 < k < len(t) - 1 and is_cjkp(t[k - 1]) and is_cjkp(t[k + 1]):
                    edge = any(abs(cx - r[0]) < 1.2 * f.size or abs(cx - r[2]) < 1.2 * f.size for r in rects)
                    if edge:
                        continue  # 灰框内边距
                    if t[k - 1] not in "“”‘’" and t[k + 1] not in "“”‘’":
                        c = MISSING
                elif c == " " and not self.code and rects and (k == 0 or k == len(t) - 1):
                    continue
                elif c == " " and not self.code and k == 0 and len(t) > 1 and is_cjkp(t[1]) \
                        and segs and is_cjkp(segs[-1][0][-1:] or " ") and f.x0 - (prev.x1 if prev else f.x0) < 0.5 * f.size:
                    continue  # 片段开头多出的空格（两侧都是汉字、实际并无空隙）
                segs.append((c, cf))
            prev = f
        # 行内灰框边缘的空格（框的内边距）：两侧是汉字时去掉
        out = []
        for k, (c, f) in enumerate(segs):
            if c == " " and 0 < k < len(segs) - 1 and not self.code:
                a, b = segs[k - 1], segs[k + 1]
                if ("code" in a[1]) != ("code" in b[1]) and is_cjkp(a[0][-1:] or " ") and is_cjkp(b[0][:1] or " "):
                    continue
                if is_cjkp(a[0][-1:] or " ") and b[0][:1] in "、，。；：！？）》」』":
                    continue
                if a[0][-1:] in "，。、；：！？" and is_cjk(b[0][:1] or " "):
                    continue  # 全角标点后的空格
            out.append((c, f))
        segs = out
        self.segs = segs
        self.text = "".join(t for t, _ in segs)
        return segs


def pdf_lines(frags):
    """按 (页, 基线) 聚成视觉行，行内按 x 排序。"""
    by_pg = collections.defaultdict(list)
    for f in frags:
        by_pg[f.pg].append(f)
    lines = []
    for pg in sorted(by_pg):
        fs = sorted(by_pg[pg], key=lambda f: (f.cy, f.x0))
        cur = []
        cy = None
        for f in fs:
            h = f.bot - f.top
            if cur and abs(f.cy - cy) < 0.4 * max(h, cur_h):
                # 同一视觉行：但若与已有片段横向重叠（两栏/上下行贴得很近），另起一行
                cur.append(f)
                continue
            if cur:
                lines.append(cur)
            cur = [f]
            cy = f.cy
            cur_h = h
        if cur:
            lines.append(cur)
    return [Line(l) for l in lines]


CODE_LINE_SPACE = re.compile(r" {2,}")


def convert_pdf(path: Path, ctx):
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        pages, frags, images = pdf_parse(path, tmp)
        shapes = pdf_shapes(path, len(pages), tmp)
        blocks = pdf_blocks(path, pages, frags, images, shapes, ctx, tmp)
    return blocks


def pdf_blocks(path, pages, frags, images, shapes, ctx, tmp):
    frags = [f for f in frags if f.text.strip() or f.text == " "]
    lines = pdf_lines([f for f in frags if f.text.strip()] + [f for f in frags if not f.text.strip()])
    # 只有空白的行丢弃
    lines = [l for l in lines if any(f.text.strip() for f in l.frags)]
    # 去掉页码
    def is_pageno(l):
        t = "".join(f.text for f in l.frags).strip()
        return bool(re.fullmatch(r"[-— ]*\d{1,3}[-— ]*", t)) and (l.top > pages[l.pg][1] * 0.88 or l.bot < pages[l.pg][1] * 0.1)
    lines = [l for l in lines if not is_pageno(l)]
    if not lines:
        return []
    # 页面形状：横线 / 竖条 / 底色矩形
    hlines, vbars, boxes = collections.defaultdict(list), collections.defaultdict(list), collections.defaultdict(list)
    dots = collections.defaultdict(list)
    for pg, lst in shapes.items():
        pw = pages[pg][0]
        for (x0, y0, x1, y1, lum, op) in lst:
            w, h = x1 - x0, y1 - y0
            if lum > 99 and op > 0.9:
                continue  # 白底
            if w > pw * 0.9 and h > pages[pg][1] * 0.5:
                continue
            if h <= 3 and w > 40:
                hlines[pg].append((x0, y0, x1, y1))
            elif w <= 5 and h > 8:
                vbars[pg].append((x0, y0, x1, y1))
            elif 2 <= w <= 6 and 2 <= h <= 6 and lum < 60:
                dots[pg].append((x0, y0, x1, y1))   # 画出来的项目符号
            elif h > 6 and (op < 0.3 or lum > 85):
                boxes[pg].append((x0, y0, x1, y1))
    # 版心统计
    sizes = collections.Counter()
    for l in lines:
        sizes[round(l.msize, 1)] += len("".join(f.text for f in l.frags))
    body_size = sizes.most_common(1)[0][0]
    body_lines = [l for l in lines if abs(l.msize - body_size) < 0.6 and not l.code]
    xmins = sorted(l.x0 for l in body_lines)
    left = collections.Counter(round(x) for x in xmins).most_common(1)[0][0]
    xmaxs = sorted(l.x1 for l in body_lines)
    right = xmaxs[int(len(xmaxs) * 0.9)]
    pitches = collections.Counter()
    bl = set(map(id, body_lines))
    for a, b in zip(lines, lines[1:]):
        # 只统计“写满的行 -> 下一行”的基线距：这是段内行距
        if a.pg == b.pg and id(a) in bl and id(b) in bl and a.x1 > right - 2 * body_size:
            d = b.base - a.base
            if d > 0:
                pitches[round(d * 2) / 2] += 1
    # 行距众数
    lh = pitches.most_common(1)[0][0] if pitches else body_size * 1.5
    char_w = body_size
    print(f"  · {path.name}: 正文 {body_size}pt 行距 {lh}pt 版心 {left:.0f}–{right:.0f}")

    infer_italic(lines)
    # 逐行：形状归类、拼文本
    for l in lines:
        ly0, ly1 = l.top, l.bot
        l.bar = None
        code_rects = []
        for (x0, y0, x1, y1) in boxes.get(l.pg, []):
            if y0 - 2 <= ly0 and y1 + 2 >= ly1 or (min(y1, ly1) - max(y0, ly0)) > 0.6 * (ly1 - ly0):
                if x0 <= l.x0 + 3 and x1 >= l.x1 - 3:
                    l.cls = "sys"
                else:
                    code_rects.append((x0, y0, x1, y1))
        for (x0, y0, x1, y1) in vbars.get(l.pg, []):
            if x1 <= l.x0 + 1 and l.x0 - x1 < 20 and (min(y1, ly1) - max(y0, ly0)) > 0:
                l.cls = l.cls or "q"
                l.bar = (l.pg, x0, y0, x1, y1)
        if l.code:
            l.cls = "code"   # 等宽字体的日志行（可能位于引文框内）
        l.li = any(4 < l.x0 - x1 < 25 and ly0 - 2 <= (y0 + y1) / 2 <= ly1 + 2 for (x0, y0, x1, y1) in dots.get(l.pg, []))
        l.build(code_rects)
        if MISSING in l.text:
            k = l.text.index(MISSING)
            warn(f"{path.name} p{l.pg + 1}: 疑似漏字 …{l.text[max(0, k - 8):k]}[?]{l.text[k + 1:k + 9]}…")

    # 引文：无竖条时，以灰色且比正文多缩进的连续行判定
    for l in lines:
        if l.cls is None and l.color not in ("#000000", "#333333", "#252525", "#232323", "#222222") \
                and l.x0 > left + 0.6 * char_w and abs(l.msize - body_size) < 0.6 and re.match(r"#([0-9a-f]{2})\1\1", l.color):
            l.cls = "q"
    # 左竖线框：首行整行粗体的多行框是“区块”（如一切如常“代理期间社交互动概况”），其余是引文
    groups = collections.defaultdict(list)
    for l in lines:
        if l.cls == "q" and l.bar:
            groups[l.bar].append(l)
    for bar, ls in groups.items():
        first = ls[0]
        if len(ls) >= 3 and all(f.b for f in first.frags if f.text.strip()):
            for l in ls:
                l.cls = "box"

    # 插图（附录截图）
    imgs = []
    for (pg, x0, top, w, h) in images:
        if w < 40 or h < 25:
            continue
        imgs.append((pg, x0, top, w, h))

    # 分段
    events = [("line", l.pg, l.top, l) for l in lines] + [("img", im[0], im[2], im) for im in imgs]
    events.sort(key=lambda e: (e[1], e[2]))
    blocks = []
    cur = None      # 当前段：{"segs":[], "cls":, "lines":[]}
    prev = None     # 上一行
    prev_ended = True

    def flush():
        nonlocal cur
        if cur:
            keep = cur["cls"] == "code"
            x, m = rich(fill_italic(cur["segs"]), keep_space=keep)
            if x:
                b = mkblock("p", x, m)
                if cur.get("li"):
                    b.update(t="li", lvl=0, mk="•")
                if cur["cls"]:
                    b["cls"] = cur["cls"]
                blocks.append(b)
        cur = None

    def rule_between(pg, ya, yb):
        for (x0, y0, x1, y1) in hlines.get(pg, []):
            if ya < y0 < yb and (x1 - x0) > (right - left) * 0.6:
                return True
        return False

    for ev in events:
        if ev[0] == "img":
            flush()
            src = extract_image(path, ev[3], pages, ctx, tmp)
            if src:
                blocks.append(src)
            prev = None
            prev_ended = True
            continue
        l = ev[3]
        text = l.text
        big = l.size > body_size * 1.25 and len(text.strip()) <= 60
        gap = None
        if prev is not None and prev.pg == l.pg:
            gap = l.base - prev.base
        # 分隔线
        if prev is not None and prev.pg == l.pg and rule_between(l.pg, prev.bot, l.top) and not (blocks and blocks[-1]["t"] == "h" and cur is None):
            flush()
            blocks.append({"t": "hr"})
            prev_ended = True
        elif gap is not None and gap > 2.6 * lh and not big and not (cur is None and blocks and blocks[-1]["t"] == "h"):
            flush()
            if blocks and blocks[-1]["t"] not in ("hr", "h", "img"):
                blocks.append({"t": "hr"})
            prev_ended = True
        if big:
            flush()
            x, m = rich(l.segs)
            if blocks and blocks[-1]["t"] == "h" and blocks[-1].get("_pg") == l.pg and prev is not None and prev.size > body_size * 1.25:
                blocks[-1]["x"] += x
            else:
                blocks.append({"t": "h", "x": x, "_pg": l.pg})
            prev = l
            prev_ended = True
            continue
        if RULE_RE.match(norm(text)):
            flush()
            blocks.append({"t": "hr"})
            prev = l
            prev_ended = True
            continue
        if l.cls == "code":
            flush()
            cur = {"segs": list(l.segs), "cls": "code"}
            flush()
            prev = l
            prev_ended = True
            continue
        indented = prev is not None and abs(l.x0 - prev.x0) > char_w * 0.8
        # 段距：同页相邻行基线距超过段内行距 1.18 倍即分段（静音区段距只有行距的 1.28 倍）
        newpara = (cur is None or prev_ended or indented or l.li or (cur and cur["cls"] != l.cls)
                   or (gap is not None and gap > 1.18 * lh))
        if cur is not None and newpara:
            flush()
        if cur is None:
            nt = norm(text)
            if looks_heading(nt) and prev_ended and l.x1 < right - char_w * 3 and l.cls is None:
                x, m = rich(l.segs)
                blocks.append({"t": "h", "x": x})
                prev = l
                prev_ended = True
                continue
            cur = {"segs": [], "cls": l.cls, "li": l.li}
        else:
            # 行间拼接：去掉行尾/行首空白，英文单词间补一个空格
            while cur["segs"] and not cur["segs"][-1][0].strip():
                cur["segs"].pop()
            pt = "".join(t for t, _ in cur["segs"])
            if re.search(r"[A-Za-z0-9,.]$", pt) and re.match(r"[A-Za-z0-9]", text.lstrip()):
                cur["segs"].append((" ", set()))
        segs = list(l.segs)
        while segs and not segs[0][0].strip():
            segs.pop(0)
        cur["segs"].extend(segs)
        short = l.x1 < right - char_w * 1.2
        prev_ended = short and (bool(re.search(r"[。！？!?…”」』）)\]：:—~～.*\"'】》]$", text.rstrip()))
                                or l.x1 - l.x0 < (right - left) * 0.5)
        prev = l
    flush()
    for b in blocks:
        b.pop("_pg", None)
    blocks = [md_line(b) if b["t"] == "p" else b for b in blocks]
    # 紧挨标题的分隔线（Markdown 导出的 PDF 常在每节标题前画一条 ---）由标题本身承担
    out = []
    for i, b in enumerate(blocks):
        if b["t"] == "hr" and ((out and out[-1]["t"] in ("h", "hr")) or (i + 1 < len(blocks) and blocks[i + 1]["t"] == "h")):
            continue
        out.append(b)
    blocks = out
    return blocks


def infer_italic(lines):
    """Chromium 导出的 PDF 中，斜体汉字用单独的字体子集（名字与正文相同，如 EAAAAA+Noto-Sans-SC-Thin），
    只能从它旁边的西文字形是不是 Italic 来判断。"""
    ital = collections.Counter()
    reg = collections.Counter()
    for l in lines:
        fs = [f for f in l.frags if f.text.strip()]
        for a, b in zip(fs, fs[1:]):
            if b.x0 - a.x1 > 3:
                continue
            for x, y in ((a, b), (b, a)):
                if any(is_cjk(c) for c in x.text) and not any(is_cjk(c) for c in y.text):
                    if y.i:
                        ital[x.family] += 1
                    else:
                        reg[x.family] += 1
    fams = {f for f in ital if ital[f] >= 2 and ital[f] > 2 * reg[f]}
    for l in lines:
        for f in l.frags:
            if f.family in fams:
                f.i = True


def fill_italic(segs):
    """PDF 中汉字没有斜体字形（合成倾斜），只有引号/西文是 Italic 字体：
    把夹在两个斜体片段之间（或段首即斜体时，斜体片段到段尾之间）的纯中文片段也标为斜体。"""
    chars = [(c, f) for t, f in segs for c in t] if any(len(t) != 1 for t, _ in segs) else list(segs)
    idx = [i for i, (c, f) in enumerate(chars) if c.strip()]
    if not idx or not any("i" in chars[i][1] for i in idx):
        return segs
    out = [(c, set(f)) for c, f in chars]
    k = 0
    n = len(idx)
    while k < n:
        if "i" in out[idx[k]][1]:
            k += 1
            continue
        j = k
        while j < n and "i" not in out[idx[j]][1]:
            j += 1
        run = [idx[t] for t in range(k, j)]
        left_ok = k > 0 and "i" in out[idx[k - 1]][1]
        right_ok = (j < n and "i" in out[idx[j]][1]) or (j == n and "i" in out[idx[0]][1])
        pure = all(not re.match(r"[A-Za-z0-9]", out[t][0]) and "b" not in out[t][1] for t in run)
        if left_ok and right_ok and pure:
            for t in range(run[0], run[-1] + 1):
                out[t][1].add("i")
        k = j
    return out


def extract_image(path, im, pages, ctx, tmp):
    """把 PDF 中的截图区域渲染为 jpg：宽 ≤ 900px、≤ 120KB。"""
    wid = ctx.get("id")
    if not wid or not ctx.get("img_dir"):
        return {"t": "p", "x": "〔原文此处有截图〕", "cls": "sys"}
    pg, x0, top, w, h = im
    outdir = Path(ctx["img_dir"]) / wid
    outdir.mkdir(parents=True, exist_ok=True)
    ctx["img_n"] = ctx.get("img_n", 0) + 1
    n = ctx["img_n"]
    dest = outdir / f"{n}.jpg"
    res = min(900 / w * 72, 200)
    quality = 82
    for _ in range(12):
        scale = res / 72
        args = ["pdftoppm", "-f", str(pg + 1), "-l", str(pg + 1), "-r", f"{res:.2f}",
                "-x", str(int(x0 * scale)), "-y", str(int(top * scale)),
                "-W", str(max(1, int(w * scale))), "-H", str(max(1, int(h * scale))),
                "-jpeg", "-jpegopt", f"quality={quality},optimize=y", "-singlefile", str(path), str(tmp / "img")]
        run_cmd(args)
        data = (tmp / "img.jpg").read_bytes()
        if len(data) <= 120 * 1024:
            break
        if quality > 60:
            quality -= 8
        else:
            res *= 0.85
    dest.write_bytes(data)
    pw, ph = jpeg_size(data)
    return {"t": "img", "src": f"{wid}/{n}.jpg", "w": pw, "h": ph}


def jpeg_size(data):
    i = 2
    while i < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        mk = data[i + 1]
        if mk in (0xC0, 0xC1, 0xC2):
            h = int.from_bytes(data[i + 5:i + 7], "big")
            w = int.from_bytes(data[i + 7:i + 9], "big")
            return w, h
        ln = int.from_bytes(data[i + 2:i + 4], "big")
        i += 2 + ln
    return 0, 0


# ---------------- txt ----------------

def convert_txt(path: Path, ctx):
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "gb18030", "utf-16"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    out = []
    for l in text.splitlines():
        x, m = rich([(l, ())])
        if x:
            out.append(md_line(mkblock("p", x, m)))
    return out


def resolve_src(root: Path, s: str) -> Path:
    """works.json 的 src 支持 "glob:<模式>"，用于原稿文件名含个人信息、不宜写进仓库的情况。"""
    if s.startswith("glob:"):
        hits = sorted(root.glob(s[5:]))
        if len(hits) != 1:
            raise FileNotFoundError(f"{s} 匹配到 {len(hits)} 个文件")
        return hits[0]
    return root / s


def convert(path: Path, ctx):
    ext = path.suffix.lower()
    if ext == ".docx":
        blocks = convert_docx(path, ctx)
    elif ext == ".pdf":
        blocks = convert_pdf(path, ctx)
    elif ext == ".txt":
        blocks = convert_txt(path, ctx)
    else:
        raise ValueError(f"unsupported: {path}")
    if ctx.get("note"):
        blocks = note_rules(blocks)
    return blocks


NOTE_HEAD_RE = re.compile(r"^[A-Z][.．]\S")


def note_rules(blocks):
    """附录：整段粗体短行 / 'A.选题' 式短行为小标题；对话标签不是标题。"""
    for b in blocks:
        if b["t"] not in ("p", "h", "c"):
            continue
        x = b["x"]
        if b["t"] == "h" and (x.endswith(("：", ":")) or DIALOG_RE.match(x)):
            b["t"] = "p"
            b["m"] = [[0, len(x), "b"]]
            continue
        if b["t"] in ("p", "c") and not b.get("cls"):
            full = full_kinds(b)
            if DIALOG_RE.match(x):
                b["t"] = "p"
                b["m"] = [[0, len(x), "b"]]
                continue
            if x.endswith(("：", ":")):
                continue
            if ("b" in full and len(x) <= 30 and not re.search(r"[。！？]$", x)) or (NOTE_HEAD_RE.match(x) and len(x) <= 30 and not re.search(r"[。，]", x)):
                b["t"] = "h"
                drop_kinds(b, {"b"})
    return blocks


def main():
    src_root = Path(sys.argv[1])
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    meta = json.loads((ROOT / "data" / "works.json").read_text("utf-8"))
    only = set(sys.argv[3:])
    img_root = ROOT / "art" / "notes"
    for w in meta["works"]:
        if only and w["id"] not in only:
            continue
        ctx = {"id": w["id"], "img_dir": img_root}
        old = img_root / w["id"]
        if old.exists():
            for f in old.glob("*.jpg"):
                f.unlink()
        body = []
        for s in w["src"]:
            body.extend(convert(resolve_src(src_root, s), ctx))
        notes = []
        for t, p in w.get("notes", []):
            ctx["note"] = True
            notes.append({"title": t, "body": convert(src_root / p, ctx)})
            ctx["note"] = False
        (out / f"{w['id']}.json").write_text(
            json.dumps({"body": body, "notes": notes}, ensure_ascii=False, indent=1), "utf-8"
        )
        chars = sum(len(b.get("x", "")) for b in body)
        print(f"{w['id']:24s} blocks={len(body):5d} chars={chars:6d} notes={len(notes)}")
    if WARN:
        print(f"共 {len(WARN)} 条告警")


if __name__ == "__main__":
    main()
