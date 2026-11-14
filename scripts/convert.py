"""把原始稿件（docx / pdf / txt）转成统一的段落块 JSON。

用法：python3 -I scripts/convert.py <稿件根目录> <输出目录>
输出：<输出目录>/<id>.json  ->  {"body": [...blocks], "notes": [{"title":..., "body": [...]}]}
block 形如 {"t": "h"|"p"|"hr", "x": "文本"}
"""
import json
import re
import subprocess
import sys
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


RADICALS = str.maketrans("⻄⻅⻔⻛⻓⻮⻢⻥⻚⻜⻩⻬⻆⻨⻝⻘⻰⻳⻋⻉⻊⻌⻍⻎⻏⻐⻑⻒⻕⻖⻗⻘⻙⻞⻟⻠⻡⻣⻤⻦⻧⻪⻫⻭⻯⻱⻲",
                         "西见门风长齿马鱼页飞黄齐角麦食青龙龟车贝⻊辶辶辶辶⻐⻑⻒⻕⻖⻗青⻙⻞⻟⻠⻡⻣⻤⻦⻧⻪⻫⻭⻯⻱⻲")


def norm(s: str) -> str:
    s = s.translate(RADICALS)
    # PDF 中常见康熙部首/兼容汉字（⼀ ⽰ ⻅），NFKC 可还原；但 NFKC 也会把全角标点变半角，
    # 所以只对 CJK 兼容区字符做归一化。
    out = []
    for ch in s:
        cp = ord(ch)
        if 0x2E80 <= cp <= 0x2FDF or 0xF900 <= cp <= 0xFAFF or 0x2F800 <= cp <= 0x2FA1F:
            out.append(unicodedata.normalize("NFKC", ch))
        else:
            out.append(ch)
    s = "".join(out)
    s = s.replace(" ", " ").replace("　", " ").replace("﻿", "")
    return re.sub(r"[ \t]+", " ", s).strip()


# ---------------- docx ----------------

def docx_heading_styles(z: zipfile.ZipFile) -> set:
    ids = set()
    try:
        st = ET.fromstring(z.read("word/styles.xml"))
    except KeyError:
        return ids
    for s in st.iter(W + "style"):
        name = s.find(W + "name")
        n = (name.get(W + "val") if name is not None else "").lower()
        if n.startswith("heading") or n == "title" or n.startswith("标题"):
            ids.add(s.get(W + "styleId"))
    return ids


def para_text(p) -> str:
    buf = []
    for el in p.iter():
        tag = el.tag
        if tag == W + "t":
            buf.append(el.text or "")
        elif tag == W + "tab":
            buf.append(" ")
        elif tag in (W + "br", W + "cr"):
            buf.append("\n")
        elif tag == W + "noBreakHyphen":
            buf.append("-")
    return "".join(buf)


def is_all_bold(p) -> bool:
    runs = [r for r in p.iter(W + "r") if "".join(t.text or "" for t in r.iter(W + "t")).strip()]
    if not runs:
        return False
    for r in runs:
        rpr = r.find(W + "rPr")
        b = rpr.find(W + "b") if rpr is not None else None
        if b is None or b.get(W + "val") in ("0", "false"):
            return False
    return True


HEAD_RE = re.compile(
    r"^(#+\s*)?(第[一二三四五六七八九十百零〇\d]+[章节回部卷幕篇](\s|：|:|$)|[一二三四五六七八九十]{1,3}([、：:.．]|$)|\d{1,2}([.、．]|$)|"
    r"P\.\d+|尾声|序章|序幕|楔子|终章|后记|附录|片段[一二三四五六七八九十]+)"
)
RULE_RE = re.compile(r"^[*＊·•※\-—_~～=─━]+( ?[*＊·•※\-—_~～=─━]+)*$")


def looks_heading(x: str) -> bool:
    return len(x) <= 30 and bool(HEAD_RE.match(x)) and not re.search(r"[。！？]|[，、]$", x)


def docx_para_blocks(p, heads):
    ppr = p.find(W + "pPr")
    style = None
    center = False
    numbered = False
    if ppr is not None:
        ps = ppr.find(W + "pStyle")
        style = ps.get(W + "val") if ps is not None else None
        jc = ppr.find(W + "jc")
        center = jc is not None and jc.get(W + "val") == "center"
        numbered = ppr.find(W + "numPr") is not None
    out = []
    for line in para_text(p).split("\n"):
        x = norm(line)
        if not x:
            continue
        if RULE_RE.match(x):
            out.append({"t": "hr"})
            continue
        if x.startswith("#"):
            out.append({"t": "h", "x": x.lstrip("#").strip()})
            continue
        short = len(x) <= 30 and not re.search(r"[。！？，”」…]$", x)
        if style in heads and short and not x.endswith(("：", ":")) or looks_heading(x) or (numbered and len(x) <= 12 and short):
            out.append({"t": "h", "x": x})
        elif center and short:
            out.append({"t": "c", "x": x})
        else:
            out.append({"t": "p", "x": x})
    return out


def convert_docx(path: Path):
    z = zipfile.ZipFile(path)
    heads = docx_heading_styles(z)
    doc = ET.fromstring(z.read("word/document.xml"))
    body = doc.find(W + "body")
    blocks = []

    def walk(el):
        for ch in el:
            if ch.tag == W + "p":
                blocks.extend(docx_para_blocks(ch, heads))
            elif ch.tag == W + "tbl":
                rows = []
                for tr in ch.iter(W + "tr"):
                    cells = []
                    for tc in tr.findall(W + "tc"):
                        cells.append(norm(" ".join(para_text(pp) for pp in tc.iter(W + "p"))))
                    if any(cells):
                        rows.append(cells)
                if rows:
                    blocks.append({"t": "table", "rows": rows})
            elif ch.tag in (W + "sdt", W + "sdtContent", W + "customXml", W + "smartTag"):
                walk(ch)

    walk(body)
    return blocks


# ---------------- pdf ----------------

def convert_pdf(path: Path):
    xml = subprocess.run(
        ["pdftotext", "-bbox-layout", str(path), "-"], capture_output=True, check=True
    ).stdout.decode("utf-8", "replace")
    xml = re.sub(r"<!DOCTYPE[^>]*>", "", xml)
    xml = re.sub(r'xmlns="[^"]+"', "", xml)
    tree = ET.fromstring(xml)
    lines = []  # (page, xmin, xmax, height, text)
    for pi, page in enumerate(tree.iter("page")):
        for line in page.iter("line"):
            words = [w.text or "" for w in line.iter("word")]
            text = ""
            for w in words:
                if text and re.search(r"[A-Za-z0-9,.:;!?)]$", text) and re.match(r"[A-Za-z0-9(]", w):
                    text += " "
                text += w
            text = norm(text)
            if not text:
                continue
            x0, x1 = float(line.get("xMin")), float(line.get("xMax"))
            y0, y1 = float(line.get("yMin")), float(line.get("yMax"))
            prev = lines[-1] if lines else None
            # pdftotext 偶尔把同一视觉行拆成两段，按基线合并
            if prev and prev[0] == pi and abs(prev[5] - y1) < 2.5 and x0 > prev[2] - 1:
                lines[-1] = (pi, prev[1], x1, prev[3], prev[4] + text, prev[5])
                continue
            lines.append((pi, x0, x1, y1 - y0, text, y1))
    # 去掉页码
    lines = [l for l in lines if not re.fullmatch(r"[-— ]*\d{1,3}[-— ]*", l[4])]
    if not lines:
        return []
    heights = sorted(l[3] for l in lines)
    body_h = heights[len(heights) // 2]
    xmaxs = sorted(l[2] for l in lines)
    right = xmaxs[int(len(xmaxs) * 0.9)]
    xmins = sorted(l[1] for l in lines)
    left = xmins[int(len(xmins) * 0.1)]
    full = [l for l in lines if l[2] > right - 2 and len(l[4]) > 10]
    cws = sorted((l[2] - l[1]) / len(l[4]) for l in full) or [body_h * 0.95]
    char_w = cws[len(cws) // 2]
    blocks = []
    cur = ""
    prev_ended = True
    prev_x0 = left
    for (pg, x0, x1, h, text, _y) in lines:
        big = h > body_h * 1.25
        indented = abs(x0 - prev_x0) > char_w * 0.8
        prev_x0 = x0
        if big:
            if cur:
                blocks.append({"t": "p", "x": cur})
                cur = ""
            if blocks and blocks[-1]["t"] == "h" and blocks[-1].get("_pg") == pg:
                blocks[-1]["x"] += text
            else:
                blocks.append({"t": "h", "x": text, "_pg": pg})
            prev_ended = True
            continue
        if RULE_RE.match(text):
            if cur:
                blocks.append({"t": "p", "x": cur})
                cur = ""
            blocks.append({"t": "hr"})
            prev_ended = True
            continue
        if not cur and looks_heading(text) and prev_ended and x1 < right - char_w * 3:
            blocks.append({"t": "h", "x": text})
            continue
        if cur and (prev_ended or indented):
            blocks.append({"t": "p", "x": cur})
            cur = ""
        if cur and re.search(r"[A-Za-z0-9,.]$", cur) and re.match(r"[A-Za-z0-9]", text):
            cur += " "
        cur += text
        short = x1 < right - char_w * 1.2
        prev_ended = short and (bool(re.search(r"[。！？!?…”」』）)\]：:—~～.*\"'】》]$", text)) or x1 - x0 < (right - left) * 0.5)
    if cur:
        blocks.append({"t": "p", "x": cur})
    for b in blocks:
        b.pop("_pg", None)
    return blocks


def convert_txt(path: Path):
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "gb18030", "utf-16"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    return [{"t": "p", "x": norm(l)} for l in text.splitlines() if norm(l)]


def convert(path: Path):
    ext = path.suffix.lower()
    if ext == ".docx":
        return convert_docx(path)
    if ext == ".pdf":
        return convert_pdf(path)
    if ext == ".txt":
        return convert_txt(path)
    raise ValueError(f"unsupported: {path}")


def main():
    src_root = Path(sys.argv[1])
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    meta = json.loads((ROOT / "data" / "works.json").read_text("utf-8"))
    for w in meta["works"]:
        body = []
        for s in w["src"]:
            body.extend(convert(src_root / s))
        notes = [{"title": t, "body": convert(src_root / p)} for t, p in w.get("notes", [])]
        (out / f"{w['id']}.json").write_text(
            json.dumps({"body": body, "notes": notes}, ensure_ascii=False, indent=1), "utf-8"
        )
        chars = sum(len(b.get("x", "")) for b in body)
        print(f"{w['id']:24s} blocks={len(body):5d} chars={chars:6d} notes={len(notes)}")


if __name__ == "__main__":
    main()
