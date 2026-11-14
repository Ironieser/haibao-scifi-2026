"""清洗 convert.py 的输出：去掉署名/真实姓名/个人简介等前后附信息，提取作者 AI 声明。

用法：python3 -I scripts/clean.py <rawjson 目录>
输出：content/works/<id>.json
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AI_RE = re.compile(r"AI|ai|Ai|deepseek|DeepSeek|豆包|大模型|Gemini|Claude|VibeNoving|人工智能")
META_RE = re.compile(
    r"^[（(【\[]?(作者|投稿人|笔名|真实姓名|作者真实姓名|本人真实姓名|创作者|个人简介|Written by|Author)[：:\s]|"
    r"^[（(]?真实姓名|^本人真实姓名|^个人简介"
)


def plain(s):
    return re.sub(r"[《》“”\"「」\s。.]", "", s or "")


def is_meta(b, w):
    x = b.get("x", "")
    if b["t"] in ("hr",):
        return False
    if META_RE.search(x):
        return True
    p = plain(x)
    if p in (plain(w["title"]), plain(w["author"]), plain(w["author"]) + "。"):
        return True
    if p.startswith(plain(w["title"])) and len(p) <= len(plain(w["title"])) + 30 and b["t"] in ("h", "c") and "（" in x:
        return True  # 《数字示播列》（The Digital Shibboleth）
    return False


def is_statement(b):
    x = b.get("x", "")
    return b["t"] != "table" and len(x) < 240 and bool(AI_RE.search(x)) and not x.startswith("“")


def strip_edges(body, w, statements, head=6, tail=6):
    # 头部
    i = 0
    while i < len(body) and i < head:
        b = body[i]
        if b["t"] == "hr":
            i += 1
        elif is_meta(b, w):
            i += 1
        elif is_statement(b):
            statements.append(b["x"])
            i += 1
        else:
            break
    body = body[i:]
    # 尾部
    j = len(body)
    while j > 0 and len(body) - j < tail:
        b = body[j - 1]
        if b["t"] == "hr":
            j -= 1
        elif is_meta(b, w):
            j -= 1
        elif is_statement(b):
            statements.insert(0 if not statements else len(statements), b["x"])
            j -= 1
        else:
            break
    return body[:j]


def fix(wid, body, notes):
    if wid == "shuzi-shibolie":
        a = next(i for i, b in enumerate(body) if b.get("x", "").startswith("附录：创作解析"))
        c = next(i for i, b in enumerate(body) if b.get("x", "").startswith("创作解析：《数字示播列》"))
        appendix = body[c:]
        appendix[0] = {"t": "h", "x": "一、故事的经纬：圣经明线与赛博朋克的壳"}
        out = []
        for b in appendix:
            x = b.get("x", "")
            if x.startswith("七、") and "工具与模型" in x:
                out += [{"t": "h", "x": x.replace("工具与模型", "")}, {"t": "h", "x": "工具与模型"}]
            else:
                out.append(b)
        body = body[:a]
        notes = [{"title": "创作解析与鱼竿奖说明", "body": out}] + notes
    if wid == "qidian":
        ren = {"开端": "第一章 开端", "枪手": "第二章 枪手"}
        body = [dict(b, x=ren[b["x"]], t="h") if b.get("x") in ren else b for b in body]
    if wid == "mr-man":
        body = [b for b in body if b.get("x") != "王 良"]
        if body and re.fullmatch(r"\d{4}年\d+月\d+日", body[-1].get("x", "")):
            body[-1]["t"] = "c"
    if wid == "zhuxingzhe-jiuguan":
        body = [dict(b, t="h") if b["t"] == "c" and re.match(r"\d{4}年", b["x"]) else b for b in body]
    if wid == "ta-de-shou":
        body = [b for b in body[:3] if b.get("x") != "苏晚"] + body[3:]
    return body, notes


def clean_note(n, w):
    body = [b for b in n["body"] if not is_meta(b, w)]
    t = plain(n["title"])
    while body and (plain(body[0].get("x", "")).endswith(t) or plain(body[0].get("x", "")) == plain(w["title"]) + t
                    or plain(body[0].get("x", "")).startswith(plain("《" + w["title"] + "》"))) and len(body[0].get("x", "")) < 40:
        body = body[1:]
    return {"title": n["title"], "body": body}


def count_chars(body):
    n = 0
    for b in body:
        texts = [b.get("x", "")] if b["t"] != "table" else [c for r in b["rows"] for c in r]
        for x in texts:
            n += len(re.findall(r"[一-鿿]", x)) + len(re.findall(r"[A-Za-z0-9]+", x))
    return n


PII_RE = re.compile(r"1[3-9]\d{9}|[\w.+-]+@[\w-]+\.\w+|\d{17}[\dXx]|真实姓名|个人简介|出生于")


def main():
    raw = Path(sys.argv[1])
    meta = json.loads((ROOT / "data" / "works.json").read_text("utf-8"))
    out = ROOT / "content" / "works"
    out.mkdir(parents=True, exist_ok=True)
    for w in meta["works"]:
        d = json.loads((raw / f"{w['id']}.json").read_text("utf-8"))
        statements = []
        body, notes = fix(w["id"], d["body"], d["notes"])
        body = strip_edges(body, w, statements)
        notes = [clean_note(n, w) for n in notes]
        # 章节目录
        toc = [b["x"] for b in body if b["t"] == "h"]
        res = {
            "id": w["id"],
            "chars": count_chars(body),
            "statements": statements,
            "toc": toc,
            "body": body,
            "notes": notes,
        }
        s = json.dumps(res, ensure_ascii=False, indent=1)
        for m in PII_RE.finditer(s):
            print(f"  !! {w['id']}: possible PII {m.group(0)!r} ... {s[max(0, m.start()-30):m.end()+30]!r}")
        (out / f"{w['id']}.json").write_text(s, "utf-8")
        print(f"{w['id']:22s} {res['chars']:6d}字 toc={len(toc):2d} stmt={statements!r:.90}")


if __name__ == "__main__":
    main()
