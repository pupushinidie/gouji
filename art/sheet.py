"""候选总览图：把一批候选拼成一张带编号的图，挑图时看总览，不逐张打开。

用法：
  python art/sheet.py v2 <名字> [倍数]        art/out/r1/v2/<名字>/ 的 64 张，8 列，夜/日两种底色交替 → art/out/sheets/v2-<名字>.png
  python art/sheet.py dir <目录> <输出名> [倍数] [列数]   目录里所有 png
"""
from __future__ import annotations

import pathlib
import re
import sys

from PIL import Image, ImageDraw

ART = pathlib.Path(__file__).resolve().parent
SHEETS = ART / "out" / "sheets"
NIGHT, DAY = (22, 32, 46, 255), (236, 230, 216, 255)


def natural(p: pathlib.Path):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", p.stem)]


def grid(paths: list[pathlib.Path], scale: int = 2, cols: int = 8, two_bg: bool = True) -> Image.Image:
    ims = [Image.open(p).convert("RGBA") for p in paths]
    w = max(i.width for i in ims) * scale
    h = max(i.height for i in ims) * scale
    cw = w * (2 if two_bg else 1) + 10
    ch = h + 16
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cw + 4, rows * ch + 4), (60, 60, 60, 255))
    d = ImageDraw.Draw(sheet)
    for k, im in enumerate(ims):
        x, y = 4 + (k % cols) * cw, 4 + (k // cols) * ch
        big = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
        for j, bg in enumerate((NIGHT, DAY) if two_bg else (NIGHT,)):
            tile = Image.new("RGBA", (w, h), bg)
            tile.alpha_composite(big, ((w - big.width) // 2, (h - big.height) // 2))
            sheet.paste(tile, (x + j * w, y))
        d.text((x, y + h + 1), str(k) if not paths[k].stem[-1:].isdigit() else paths[k].stem.split("-")[-1], fill=(255, 255, 0))
    return sheet


if __name__ == "__main__":
    SHEETS.mkdir(parents=True, exist_ok=True)
    cmd = sys.argv[1]
    if cmd == "v2":
        name = sys.argv[2]
        scale = int(sys.argv[3]) if len(sys.argv) > 3 else 2
        folder = ART / "out" / "r1" / "v2" / name
        paths = sorted(folder.glob("*.png"), key=natural)
        grid(paths, scale).save(SHEETS / f"v2-{name}.png")
        print(SHEETS / f"v2-{name}.png", len(paths))
    elif cmd == "dir":
        folder, outname = pathlib.Path(sys.argv[2]), sys.argv[3]
        scale = int(sys.argv[4]) if len(sys.argv) > 4 else 1
        cols = int(sys.argv[5]) if len(sys.argv) > 5 else 2
        paths = sorted(folder.glob("*.png"), key=natural)
        grid(paths, scale, cols, two_bg=False).save(SHEETS / f"{outname}.png")
        print(SHEETS / f"{outname}.png", [p.name for p in paths])
