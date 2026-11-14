"""清洗 convert.py 的输出：去掉署名/真实姓名/个人简介等前后附信息，提取作者 AI 声明，补 PDF 漏字。

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
MISSING = "�"

# PDF 中个别字形没有 Unicode 映射，pdftotext/pdftohtml 取不到字（convert.py 用 U+FFFD 占位并告警）。
# 以下按上下文精确补字，每处都已对照页面渲染图确认。
FILL = {
    "shuzi-shibolie": [
        ("扭曲、�叠", "扭曲、重叠"),          # p1
        ("流�话术", "流量话术"),              # p2
        ("陆离�新坐下", "陆离重新坐下"),        # p2
        ("仔细的称�。", "仔细的称量。"),        # p5
        ("会�新组织", "会重新组织"),            # p6
        ("短暂失�", "短暂失重"),              # p6
        ("田埂上的�草", "田埂上的野草"),        # p7
        ("他的视�中央", "他的视野中央"),        # p8
        ("过滤权�", "过滤权重"),              # p9（页面上是“权重”）
        ("比上一版严�", "比上一版严重"),        # p10
        ("停顿、�组", "停顿、重组"),            # p12
    ],
}


def plain(s):
    return re.sub(r"[《》“”\"「」\s。.]", "", s or "")


def is_meta(b, w, edge=True):
    x = b.get("x", "")
    if b["t"] in ("hr", "img", "table"):
        return False
    if META_RE.search(x):
        return True
    p = plain(x)
    if p in (plain(w["title"]), plain(w["author"]), plain(w["author"]) + "。"):
        return True
    if edge and p.startswith(plain(w["title"])) and len(p) <= len(plain(w["title"])) + 30 and b["t"] in ("h", "c") and "（" in x:
        return True  # 《数字示播列》（The Digital Shibboleth）
    return False


def is_statement(b):
    x = b.get("x", "")
    return b["t"] in ("p", "c", "h", "li") and len(x) < 240 and bool(AI_RE.search(x)) and not x.startswith("“")


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
    # 尾部：附信息之前的分隔线一并去掉；紧跟正文的结尾线（转人工）保留
    j = len(body)
    stripped = False
    while j > 0 and len(body) - j < tail:
        b = body[j - 1]
        if b["t"] == "hr":
            if not stripped:
                break
            j -= 1
        elif is_meta(b, w):
            j -= 1
            stripped = True
        elif is_statement(b):
            statements.insert(0 if not statements else len(statements), b["x"])
            j -= 1
            stripped = True
        else:
            break
    return body[:j]


def tidy_hr(body):
    """去掉开头的和连续重复的分隔线。"""
    out = []
    for b in body:
        if b["t"] == "hr" and (not out or out[-1]["t"] == "hr"):
            continue
        out.append(b)
    return out


def fill_missing(wid, body, notes):
    rules = FILL.get(wid, [])
    used = [0] * len(rules)
    for sec in [body] + [n["body"] for n in notes]:
        for b in sec:
            x = b.get("x")
            if not x or MISSING not in x:
                continue
            for k, (a, r) in enumerate(rules):
                if a in x:
                    assert len(a) == len(r)
                    x = x.replace(a, r)
                    used[k] += 1
            b["x"] = x
            if MISSING in x:
                i = x.index(MISSING)
                print(f"  !! {wid}: 未补的漏字 …{x[max(0, i - 10):i]}[?]{x[i + 1:i + 10]}…")
    for k, n in enumerate(used):
        if n != 1:
            print(f"  !! {wid}: 补字规则 {rules[k][0]!r} 命中 {n} 次")


def fix(wid, body, notes):
    if wid == "shuzi-shibolie":
        a = next(i for i, b in enumerate(body) if b.get("x", "").startswith("附录：创作解析"))
        c = next(i for i, b in enumerate(body) if b.get("x", "").startswith("创作解析：《数字示播列》"))
        appendix = body[c:]
        appendix[0] = {"t": "h", "x": "一、故事的经纬：圣经明线与赛博朋克的壳"}
        out = []
        for b in appendix:
            x = b.get("x", "")
            if b["t"] == "h" and x.startswith("七、") and "工具与模型" in x:
                out += [{"t": "h", "x": x.replace("工具与模型", "")}, {"t": "h", "x": "工具与模型"}]
            else:
                out.append(b)
        body = body[:a]
        notes = [{"title": "创作解析与鱼竿奖说明", "body": out}] + notes
    if wid == "mr-man":
        body = [b for b in body if b.get("x") != "王 良"]
    if wid == "zhuxingzhe-jiuguan":
        # 居中的“2045年·探索时代”是章节标题；它前面由空段得来的分隔线不再需要
        body = [dict(b, t="h") if b["t"] == "c" and re.match(r"\d{4}年", b["x"]) else b for b in body]
        body = [b for i, b in enumerate(body) if not (b["t"] == "hr" and i + 1 < len(body) and body[i + 1]["t"] == "h")]
    if wid == "ta-de-shou":
        body = [b for b in body[:3] if b.get("x") != "苏晚"] + body[3:]
    return body, notes


def strip_auto_toc(body):
    """去掉 PDF 开头残留的自动目录：若干短行，其文字（去掉编号）与后文标题一一对应。"""
    def key(x):
        return re.sub(r"^[\d一二三四五六七八九十]*\s*[.、．]?\s*", "", x or "").strip()
    heads = {key(b["x"]) for b in body if b["t"] == "h"}
    k = 0
    while k < min(len(body), 20) and body[k]["t"] in ("p", "li", "h") and len(body[k].get("x", "")) <= 40:
        k += 1
    run = [i for i in range(k) if key(body[i].get("x")) in heads and body[i]["t"] != "h"]
    if len(run) >= 3:
        drop = set(range(run[0], run[-1] + 1))
        return [b for i, b in enumerate(body) if i not in drop]
    return body


def clean_note(n, w):
    body = [b for i, b in enumerate(n["body"]) if not is_meta(b, w, edge=i < 3)]
    body = strip_auto_toc(body)
    t = plain(n["title"])
    while body and (plain(body[0].get("x", "")).endswith(t) or plain(body[0].get("x", "")) == plain(w["title"]) + t
                    or plain(body[0].get("x", "")).startswith(plain("《" + w["title"] + "》"))) and len(body[0].get("x", "")) < 40:
        body = body[1:]
    body = tidy_hr(body)
    while body and body[-1]["t"] == "hr":
        body.pop()
    return {"title": n["title"], "body": body}


def count_chars(body):
    n = 0
    for b in body:
        if b["t"] == "table":
            texts = [c for r in b["rows"] for c in r]
        else:
            texts = [b.get("x", "")]
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
        fill_missing(w["id"], d["body"], d["notes"])
        body, notes = fix(w["id"], d["body"], d["notes"])
        body = strip_edges(body, w, statements)
        body = tidy_hr(body)
        notes = [clean_note(n, w) for n in notes]
        # 章节目录：带段落样式的标题（区块内的小标题）不进目录
        toc = [b["x"] for b in body if b["t"] == "h" and not b.get("cls")]
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
