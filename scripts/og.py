"""生成社交分享预览图（og:image，1200×630 PNG）：dist/assets/og/<id>.png 与 home.png。

依赖 macOS 的 qlmanage（把 SVG 渲染成 PNG）和 ImageMagick（magick）。
用法：python3 -I scripts/og.py [展示字体 .ttf/.otf 路径]
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "assets" / "og"
PAPER, INK, MUTED = "#EEEFEA", "#1E2140", "#6B6E85"
PINK, BLUE, YELLOW = "#FF48B0", "#0078BF", "#FFE800"
JURY_COLOR = {"human": PINK, "ai": BLUE, "rod": YELLOW}
DEFAULT_FONT = Path("/private/tmp/claude-501/-Users-ironieser-project-sci-fiction/"
                    "dc773bb4-d22d-4c86-97bc-52d36de053c5/scratchpad/font/smiley-sans-v2.0.1/SmileySans-Oblique.ttf")


def run(*args):
    subprocess.run([str(a) for a in args], check=True, capture_output=True)


def render_svg(svg: Path, size: int, tmp: Path) -> Path:
    run("qlmanage", "-t", "-s", size, "-o", tmp, svg)
    raw = tmp / (svg.name + ".png")
    out = tmp / (svg.stem + "-trim.png")
    # qlmanage 会把非方形画面补成白色方块，裁掉白边
    run("magick", raw, "-bordercolor", "white", "-border", "1", "-fuzz", "1%", "-trim", "+repage", out)
    return out


def awards(meta):
    out = {}
    for j in meta["juries"]:
        for t in j["tiers"]:
            for wid in t["works"]:
                label = j["name"] if j["id"] == "rod" else f"{j['name']} {t['name']}"
                out.setdefault(wid, []).append((j["id"], label))
    return out


def title_size(title):
    n = len(title)
    return 124 if n <= 3 else 104 if n <= 5 else 84 if n <= 6 else 66


def work_card(w, aw, cover_png, font, dest):
    x = 520
    args = ["magick", "-size", "1200x630", f"xc:{PAPER}",
            # 封面：先画一块错位的墨色投影，再贴封面
            "-fill", "#D5D6CF", "-draw", "rectangle 82,52 485,592",
            "(", cover_png, "-resize", "x540", ")", "-geometry", "+70+40", "-composite",
            "-font", font, "-fill", MUTED, "-pointsize", "30",
            "-annotate", f"+{x}+108", "2026 海豹杯科幻文学大赛",
            "-fill", INK, "-pointsize", str(title_size(w["title"])),
            "-annotate", f"+{x}+{108 + 30 + title_size(w['title'])}", w["title"],
            "-fill", INK, "-pointsize", "44",
            "-annotate", f"+{x}+{108 + 30 + title_size(w['title']) + 72}", w["author"]]
    y = 108 + 30 + title_size(w["title"]) + 72 + 70
    for jury, label in aw:
        args += ["-fill", JURY_COLOR[jury], "-draw", f"rectangle {x},{y - 26} {x + 26},{y}",
                 "-fill", INK, "-pointsize", "32", "-annotate", f"+{x + 42}+{y}", label]
        y += 52
    args += ["-fill", MUTED, "-pointsize", "26", "-annotate", f"+{x}+590", "scifi.ironieser.cc", "-quality", "84", dest]
    run(*args)


def home_card(hero_png, font, meta, dest, tmp):
    total = sum(t["prize"] * len(t["works"]) if t["each"] else t["prize"]
                for j in meta["juries"] for t in j["tiers"])
    # 插画靠右，左侧留给套印标题
    base = tmp / "home-base.png"
    run("magick", "-size", "1200x630", f"xc:{PAPER}",
        "(", hero_png, "-resize", "860x", ")", "-gravity", "east", "-geometry", "+0+0", "-composite", base)
    layers = []
    for color, dx, dy, name in ((PINK, 0, 0, "p"), (BLUE, 5, -4, "b")):
        layer = tmp / f"home-{name}.png"
        run("magick", "-size", "1200x630", "xc:none", "-font", font, "-fill", color,
            "-pointsize", "128", "-annotate", f"+{64 + dx}+{190 + dy}", "海豹杯",
            "-pointsize", "104", "-annotate", f"+{64 + dx}+{320 + dy}", "科幻文学大赛", layer)
        layers.append(layer)
    run("magick", base, layers[0], "-compose", "multiply", "-composite",
        layers[1], "-compose", "multiply", "-composite",
        "-compose", "over", "-font", font, "-fill", INK, "-pointsize", "36",
        "-annotate", "+68+420", f"2026 获奖作品集  {len(meta['works'])} 部作品",
        "-annotate", "+68+472", f"两个评审团  奖金合计 {total:,} 元",
        "-fill", MUTED, "-pointsize", "26", "-annotate", "+68+590", "scifi.ironieser.cc", "-quality", "84", dest)


def main():
    font = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_FONT
    if not font.exists() or not shutil.which("magick") or not shutil.which("qlmanage"):
        print("跳过 og 图：缺少字体、magick 或 qlmanage")
        return
    meta = json.loads((ROOT / "data" / "works.json").read_text("utf-8"))
    aw = awards(meta)
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        for w in meta["works"]:
            svg = ROOT / "art" / "covers" / f"{w['id']}.svg"
            if not svg.exists():
                continue
            work_card(w, aw.get(w["id"], []), render_svg(svg, 800, tmp), font, OUT / f"{w['id']}.jpg")
        hero = ROOT / "art" / "hero.svg"
        if hero.exists():
            home_card(render_svg(hero, 1200, tmp), font, meta, OUT / "home.jpg", tmp)
    files = sorted(OUT.glob("*.jpg"))
    print(f"og 图 {len(files)} 张，合计 {sum(f.stat().st_size for f in files) // 1024} KB")


if __name__ == "__main__":
    main()
