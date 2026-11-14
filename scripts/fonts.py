#!/usr/bin/env python3
"""下载并子集化得意黑（Smiley Sans，SIL OFL 1.1）→ dist/assets/fonts/smiley-sans.woff2

用法：python3 -I scripts/fonts.py
- 字体包下载到项目外的缓存目录（FONT_CACHE 环境变量可覆盖），已存在则复用。
- 依赖 fontTools（含 brotli，用于 woff2）。
"""
import os
import re
import sys
import json
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
_SCRATCH = Path("/private/tmp/claude-501/-Users-ironieser-project-sci-fiction/"
                "dc773bb4-d22d-4c86-97bc-52d36de053c5/scratchpad")
if os.environ.get("FONT_CACHE"):
    CACHE = Path(os.environ["FONT_CACHE"])
elif _SCRATCH.is_dir():
    CACHE = _SCRATCH / "font"
else:  # 其它机器（如 CI）：系统临时目录，仍在项目目录之外
    CACHE = Path(tempfile.gettempdir()) / "smiley-sans-cache"
VERSION = "v2.0.1"
ZIP_URL = f"https://github.com/atelier-anchor/smiley-sans/releases/download/{VERSION}/smiley-sans-{VERSION}.zip"
LICENSE_URLS = [
    f"https://raw.githubusercontent.com/atelier-anchor/smiley-sans/{VERSION}/LICENSE",
    "https://raw.githubusercontent.com/atelier-anchor/smiley-sans/main/LICENSE",
]
OUT_DIR = ROOT / "dist" / "assets" / "fonts"
OUT = OUT_DIR / "smiley-sans.woff2"
TARGET_KB = 150

# 界面常用字（展示字体会用到的站名、导航、按钮、奖项、数字说明等）
UI_TEXT = """
海豹杯科幻文学大赛获奖作品集两份名单人类评委AI鱼竿奖特别一二三四五六七八九十零百千万亿等奖金各元字
全部我的收藏阅读下载点赞分享讨论评论回复发表加载更多上一部下一部目录作者声明未使用辅助继续上次返回首页
筛选排序默认最多字数部两个都本站仅供交流版权归所有发布于年月日时分秒
睡前消息马督工合计共计总计约预计时长分钟小时篇章节第序号正文附录创作说明写作方法记录原文
已取消复制链接成功失败请稍后再试重新刷新网络错误加载中暂无还没有来说两句展开收起查看全文
昵称匿名读者内容提交发送删除确认举报回到顶部顶端底部下一页上一页前后首末页面不存在找不到
设置字号衬线无衬线浅色深色主题大小背景进度位置提示开始结束关闭打开菜单搜索导航主要次要
都获奖只在一边获奖人工智能评审团对照图连线叠印套印粉蓝黄紫色点数量本人以下为
你还可以在作品页会出现这里欢迎感谢支持联系关于说明隐私政策免责条款
点击进入链接已点赞赞同已复制分享到微信微博朋友圈二维码扫码手机电脑打开浏览器
新最热最新最早按照时间倒序正序条楼层回复给发表于刚刚天前周月前年前
TXT EPUB ZIP 格式文件合集打包压缩包
"""

# 中文与全角标点、常用符号
PUNCT = (
    "，。、；：？！…—–·‘’“”「」『』《》〈〉（）【】〔〕［］｛｝〖〗＂＇｀"
    "～￥％＃＆＊＠＋－＝＜＞｜＼／＿＾"
    "　·•‧※★☆○●◎◇◆□■△▲▽▼→←↑↓↔×÷±°′″℃‰§¶©®™"
    "№〇〃々〆ー﹏﹑﹒﹔﹕﹖﹗﹙﹚﹛﹜﹝﹞"
)
FULLWIDTH = "".join(chr(c) for c in range(0xFF01, 0xFF5F))  # 全角 ASCII（含全角数字、字母）
ASCII = "".join(chr(c) for c in range(0x20, 0x7F))
EXTRA = "     …—–‘’“”"


def download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "font-subset-script"})
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    tmp.replace(dest)


def safe_extract(zpath, dest):
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    with zipfile.ZipFile(zpath) as z:
        for info in z.infolist():
            target = (dest / info.filename).resolve()
            if root not in target.parents and target != root:
                raise SystemExit(f"拒绝解压可疑路径：{info.filename}")
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists() or target.stat().st_size != info.file_size:
                with z.open(info) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)


def find_font(d):
    files = [p for p in d.rglob("*") if p.is_file()]
    for pattern in (r"\.ttf$", r"\.otf$", r"\.woff2$"):  # 优先 TrueType 源
        cands = sorted(p for p in files if re.search(pattern, p.name, re.I))
        if cands:
            return cands[0]
    raise SystemExit(f"在 {d} 中没有找到字体文件")


def get_license(font_path):
    lic = CACHE / "LICENSE"
    if not lic.exists():
        for url in LICENSE_URLS:
            try:
                download(url, lic)
                break
            except Exception as e:  # noqa: BLE001
                print(f"  许可证下载失败（{url}）：{e}", file=sys.stderr)
    if lic.exists():
        text = lic.read_text(encoding="utf-8")
        if "SIL OPEN FONT LICENSE" in text.upper():
            return text
    # 兜底：用字体 name 表中的版权与许可声明
    f = TTFont(font_path, lazy=True)
    name = f["name"]
    parts = [name.getDebugName(i) for i in (0, 13, 14)]
    return "\n\n".join(p for p in parts if p) + "\n"


def collect_chars():
    chars = set()

    def walk(v, key=None):
        if isinstance(v, str):
            if key != "src":  # 原始文件名不用于展示
                chars.update(v)
        elif isinstance(v, list):
            if key == "notes":  # works.json 中 notes 为 [标题, 源文件]，只取标题
                for item in v:
                    if isinstance(item, list) and item:
                        walk(item[0])
            elif key != "src":
                for x in v:
                    walk(x)
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, k)
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            chars.update(f"{v:,}")

    meta = json.loads((ROOT / "data" / "works.json").read_text(encoding="utf-8"))
    walk(meta)
    for p in sorted((ROOT / "content" / "works").glob("*.json")):
        c = json.loads(p.read_text(encoding="utf-8"))
        for t in c.get("toc", []):
            chars.update(t.replace("**", ""))
        for n in c.get("notes", []):
            chars.update(n.get("title", ""))
    chars.update(UI_TEXT)
    # 非正文页面的全部可见文字（首页、统计、收藏、笔记、404）都可能用展示字体，一并收入子集
    import html as _html, re as _re
    for rel in ("index.html", "stats/index.html", "favorites/index.html", "notes/index.html", "404.html"):
        f = ROOT / "dist" / rel
        if f.exists():
            t = f.read_text(encoding="utf-8")
            t = _re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", t, flags=_re.S)
            chars.update(_html.unescape(_re.sub(r"<[^>]+>", " ", t)))
    # 作品页头部（标题、作者、获奖标签、元信息）由 works.json 覆盖；目录与附录标题已在上面收集
    chars.update(PUNCT)
    chars.update(FULLWIDTH)
    chars.update(ASCII)
    chars.update(EXTRA)
    return {c for c in chars if not c.isspace() or c in " 　 "}


def rename(font):
    """OFL：修改版（子集）不得使用保留字体名「Smiley」「得意黑」，改写 name 表内部名称。"""
    new_family = "HB Display"
    name = font["name"]
    keep = {0, 2, 5, 7, 8, 9, 10, 11, 12, 13, 14, 17}
    for rec in list(name.names):
        if rec.nameID in keep:
            continue
        if rec.nameID in (1, 4, 16):
            name.setName(new_family, rec.nameID, rec.platformID, rec.platEncID, rec.langID)
        elif rec.nameID in (3, 6):
            name.setName(f"HBDisplay-{VERSION}-subset", rec.nameID, rec.platformID, rec.platEncID, rec.langID)
        else:
            name.removeNames(nameID=rec.nameID, platformID=rec.platformID,
                             platEncID=rec.platEncID, langID=rec.langID)
    desc = ("Subset of Smiley Sans (得意黑) by atelierAnchor, modified for scifi.ironieser.cc. "
            "Licensed under the SIL Open Font License 1.1.")
    name.setName(desc, 10, 3, 1, 0x409)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    zpath = CACHE / ZIP_URL.rsplit("/", 1)[1]
    if zpath.exists() and zipfile.is_zipfile(zpath):
        print(f"复用已下载的字体包：{zpath}")
    else:
        print(f"下载 {ZIP_URL}")
        download(ZIP_URL, zpath)
    extract_dir = CACHE / f"smiley-sans-{VERSION}"
    safe_extract(zpath, extract_dir)
    src = find_font(extract_dir)
    print(f"源字体：{src.name}（{src.stat().st_size / 1024:.0f} KB）")

    wanted = collect_chars()
    font = TTFont(src)
    cmap = font.getBestCmap()
    covered = {c for c in wanted if ord(c) in cmap}
    missing = sorted(c for c in wanted - covered if not c.isspace())

    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.hinting = False
    opts.desubroutinize = True
    sub = subset.Subsetter(options=opts)
    sub.populate(unicodes=sorted(ord(c) for c in covered))
    sub.subset(font)
    rename(font)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".woff2.tmp")
    font.flavor = "woff2"
    font.save(tmp)
    tmp.replace(OUT)
    (OUT_DIR / "OFL.txt").write_text(get_license(src), encoding="utf-8")

    cjk = sum(1 for c in covered if "一" <= c <= "鿿")
    size_kb = OUT.stat().st_size / 1024
    print(f"请求字符 {len(wanted)} 个，字体覆盖 {len(covered)} 个（其中汉字 {cjk} 个）")
    if missing:
        print(f"字体中缺失 {len(missing)} 个（将回退到系统字体）：{''.join(missing)}")
    print(f"输出 {OUT.relative_to(ROOT)}：{size_kb:.1f} KB（目标 < {TARGET_KB} KB）")
    print(f"许可证 {(OUT_DIR / 'OFL.txt').relative_to(ROOT)}")
    if size_kb >= TARGET_KB:
        print("警告：字体子集超过目标大小", file=sys.stderr)


if __name__ == "__main__":
    main()
