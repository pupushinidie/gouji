"""挑图用的小工具：把 v2 候选按界面实际用法拼起来（头像套进头像框、徽记放在名牌上），画成总览图看。
也给 final.py 用：avatar_compose、team_from_v2、icon_from_v2 这些拼合函数都在这里。

用法：python art/pick.py avatars | teams | icons
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.argv = sys.argv[:1] + [a for a in sys.argv[1:]]
import simple as S  # noqa: E402

ART = Path(__file__).resolve().parent
V2 = ART / "out" / "r1" / "v2"
SHEETS = ART / "out" / "sheets"
NIGHT, DAY = (22, 32, 46, 255), (236, 230, 216, 255)


def v2(name: str, k: int) -> Image.Image:
    p = V2 / name / (f"{name}.png" if k == 0 else f"{name}-{k}.png")
    return Image.open(p).convert("RGBA")


def avatar_bg() -> Image.Image:
    """头像底：和简洁版一样的夜海渐变 + 一条浅海平线（中性色，不和联邦色撞）。"""
    s = 40
    top, bot = S.hx("#24364a"), S.hx("#1a2838")
    img = Image.new("RGBA", (s, s), top)
    px = img.load()
    for y in range(s):
        for x in range(s):
            px[x, y] = S.dither_pick(top, bot, y / s, x, y)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 30, s, s], fill=S.hx("#2b4c66"))
    d.line([0, 30, s, 30], fill=S.hx("#4f7f9f"))
    return img


def avatar_compose(sprite: Image.Image) -> Image.Image:
    img = avatar_bg()
    img.alpha_composite(sprite)
    return img.convert("RGB").convert("RGBA")


def in_frame(av: Image.Image, team: str = "a") -> Image.Image:
    fr = S.frame(team.upper())
    out = Image.new("RGBA", fr.size, (0, 0, 0, 0))
    out.alpha_composite(av, (4, 4))
    out.alpha_composite(fr)
    return out


def labeled_row(items: list[tuple[str, Image.Image]], scale: int, bg) -> Image.Image:
    w = sum(i.width * scale + 10 for _, i in items) + 10
    h = max(i.height for _, i in items) * scale + 22
    row = Image.new("RGBA", (w, h), bg)
    d = ImageDraw.Draw(row)
    x = 10
    for label, im in items:
        row.alpha_composite(im.resize((im.width * scale, im.height * scale), Image.NEAREST), (x, 4))
        d.text((x, h - 16), label, fill=(255, 220, 0) if bg == NIGHT else (120, 40, 0))
        x += im.width * scale + 10
    return row


def stack(rows: list[Image.Image]) -> Image.Image:
    w = max(r.width for r in rows)
    out = Image.new("RGBA", (w, sum(r.height for r in rows)), (60, 60, 60, 255))
    y = 0
    for r in rows:
        out.alpha_composite(r, (0, y))
        y += r.height
    return out


AVATARS = {
    "av-seagull": [27, 4, 1, 24],
    "av-starfish": [0, 18, 29, 5],
    "av-clam": [19, 21, 59, 25],
    "av-octopus": [5, 32, 37, 12],
    "av-turtle": [0, 16, 19, 33],
    "av-seal": [16, 48, 21, 2],
}

TEAMS = {"team-a": [16, 20, 25, 40, 56, 2], "team-b": [10, 35, 2, 27, 48, 17]}

ICONS = {
    "st-gouji": [37, 38, 53, 59],
    "st-shao": [9, 10, 26, 30],
    "st-jieshao": [7, 19, 42, 16],
    "st-rang": [0, 24, 48, 1],
    "st-jiefeng": [0, 2, 12, 26],
    "st-geming": [3, 4, 32, 39],
    "st-kanggong": [2, 7, 25, 52],
}


if __name__ == "__main__":
    SHEETS.mkdir(parents=True, exist_ok=True)
    what = sys.argv[1]
    if what == "avatars":
        rows = []
        for name, ks in AVATARS.items():
            items = [(f"{name[3:]} {k}", in_frame(avatar_compose(v2(name, k)), "a" if j % 2 == 0 else "b")) for j, k in enumerate(ks)]
            items += [(f"1x {k}", in_frame(avatar_compose(v2(name, k)))) for k in ks]
            rows.append(labeled_row(items[:4], 2, NIGHT))
            rows.append(labeled_row(items[4:], 1, NIGHT))
        stack(rows).save(SHEETS / "pick-avatars.png")
    elif what == "teams":
        rows = []
        for bg in (NIGHT, DAY):
            for name, ks in TEAMS.items():
                code = S.emblem(name[-1].upper())
                items = [("code", code)] + [(str(k), v2(name, k)) for k in ks]
                rows.append(labeled_row(items, 3, bg))
                rows.append(labeled_row(items, 1, bg))
        stack(rows).save(SHEETS / "pick-teams.png")
    elif what == "icons":
        codes = S.status_icons()
        rows = []
        for bg in (NIGHT, DAY):
            for name, ks in ICONS.items():
                items = [("code", codes[name[3:]])] + [(str(k), v2(name, k)) for k in ks]
                rows.append(labeled_row(items, 2, bg))
        stack(rows).save(SHEETS / "pick-icons.png")
    print("ok")


def palettize(img: Image.Image, keys: list[str]) -> Image.Image:
    """把 PixelLab 图的颜色就近换成 spec 调色板里的颜色（RGB 最近），透明不动。"""
    pal = [S.C(k)[:3] for k in keys]
    out = img.copy()
    px = out.load()
    cache: dict = {}
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            c = cache.get((r, g, b))
            if c is None:
                c = min(pal, key=lambda p: (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2)
                cache[(r, g, b)] = c
            px[x, y] = (*c, 255 if a > 127 else 0)
    return out


BURST_KEYS = ["ink", "tile3", "tile", "tile2", "lamp3", "lamp", "lamp2"]


def burst(seed: int = 931) -> Image.Image:
    return palettize(Image.open(ART / "out" / "r1" / "flux" / f"burst-s{seed}.png").convert("RGBA"), BURST_KEYS)
