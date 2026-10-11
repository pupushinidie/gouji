"""够级「简洁版」美术：全部用代码画（PIL），能直接上线；PixelLab 正式图定稿后按同样的文件名覆盖。

用法（仓库根目录）：
    ~/miniconda3/envs/quant/bin/python art/simple.py            # 画全部，写进 apps/web/public/art/
    ~/miniconda3/envs/quant/bin/python art/simple.py --check    # 核对 art/spec.md 和文件一一对应、尺寸对
    ~/miniconda3/envs/quant/bin/python art/simple.py --preview  # 另外拼几张缩放到显示尺寸的预览图到 art/out/preview/

风格照 art/spec.md「青岛海边露台」：深海蓝 + 红瓦 + 暖橙灯；光从左上来（亮边左上、暗边右下）；
描边 1px #0b1220（不用纯黑）；全部整像素、不抗锯齿；文字只用 Fusion Pixel 12px（或其 2 倍）。
不用 PixelLab，不用任何外部图片。
"""
from __future__ import annotations

import math
import random
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "apps" / "web" / "public" / "art"
WOFF2 = ROOT / "apps" / "web" / "src" / "assets" / "pixel" / "fusion-pixel-12px-zh_hans.woff2"
FONT_CACHE = ROOT / "art" / "out" / "fusion12.ttf"
SPEC = ROOT / "art" / "spec.md"

CLEAR = (0, 0, 0, 0)


def hx(s: str, a: int = 255) -> tuple[int, int, int, int]:
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), a)


# ---------------- 调色板（和 spec.md 第 1 节一致） ----------------
PAL = {
    "ink": "#0b1220",        # 描边
    "cream": "#f6ecd0",      # 文字亮色、高光
    "cream2": "#d9c9a0",
    "lamp": "#f2a03d",       # 暖橙灯
    "lamp2": "#ffd27a",
    "lamp3": "#b8641f",
    "tile": "#c4512f",       # 红瓦
    "tile2": "#e07a4f",
    "tile3": "#7e2c1f",
    "stone": "#6b6e72",
    "stone2": "#9a9a92",
    "stone3": "#3d4148",
    "wood": "#8a5a33",
    "wood2": "#b07a46",
    "wood3": "#5e3a20",
    # 夜
    "sky0": "#0a1322", "sky1": "#11213a", "sea0": "#10304a", "sea1": "#174461", "sea2": "#1e5675",
    "wave": "#4f93b5", "moon": "#f4e9c1",
    "floor0": "#262c35", "floor1": "#2d343e", "grout": "#1c2129",
    # 日
    "dsky0": "#8fd0ee", "dsky1": "#c4e9f8", "dsea0": "#2a92b4", "dsea1": "#3aa9c8", "dsea2": "#5cc3da",
    "dwave": "#e8f8fb", "dfloor0": "#ddd5c4", "dfloor1": "#e6dfd0", "dgrout": "#c2b8a4",
    # 联邦色：甲 海蓝 / 乙 瓦红
    "A": "#2f86d6", "A2": "#79bdf2", "A3": "#17487e",
    "B": "#d4553a", "B2": "#f39068", "B3": "#86281a",
    "gold": "#f0c04a", "gold2": "#fff0a8", "gold3": "#a8761f",
}


def C(k: str, a: int = 255):
    return hx(PAL[k], a)


INK = C("ink")

# ---------------- 基础工具 ----------------

def _font() -> ImageFont.FreeTypeFont:
    if not FONT_CACHE.exists():
        from fontTools.ttLib import TTFont

        FONT_CACHE.parent.mkdir(parents=True, exist_ok=True)
        f = TTFont(str(WOFF2))
        f.flavor = None
        f.save(str(FONT_CACHE))
    return ImageFont.truetype(str(FONT_CACHE), 12)


FONT = _font()


def text_img(s: str, fill, scale: int = 1, ink=INK, shadow=None) -> Image.Image:
    """12px 像素字（scale 倍最近邻放大），外加 1 原始像素的描边；shadow 是右下投影色。"""
    d0 = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    x0, y0, x1, y1 = d0.textbbox((0, 0), s, font=FONT)
    w, h = x1 - x0, y1 - y0
    base = Image.new("RGBA", (w + 4, h + 4), CLEAR)
    d = ImageDraw.Draw(base)
    d.fontmode = "1"
    d.text((2 - x0, 2 - y0), s, font=FONT, fill=fill)
    if scale > 1:
        base = base.resize((base.width * scale, base.height * scale), Image.NEAREST)
    out = base
    if shadow is not None:
        sh = Image.new("RGBA", (out.width + scale, out.height + scale), CLEAR)
        mask = out.split()[3]
        sh.paste(Image.new("RGBA", out.size, shadow), (scale, scale), mask)
        sh.alpha_composite(out)
        out = sh
    if ink is not None:
        out = outline(out, ink)
    return out


def paste_center(dst: Image.Image, src: Image.Image, cx: int, cy: int) -> None:
    dst.alpha_composite(src, (cx - src.width // 2, cy - src.height // 2))


def crop_alpha(img: Image.Image) -> Image.Image:
    bb = img.getbbox()
    return img.crop(bb) if bb else img


def outline(img: Image.Image, color=INK, diagonal: bool = False) -> Image.Image:
    """在不透明像素外面包一圈 1px 描边（只往透明处长）。"""
    w, h = img.size
    out = img.copy()
    sp, op = img.load(), out.load()
    nb = [(1, 0), (-1, 0), (0, 1), (0, -1)] + ([(1, 1), (-1, -1), (1, -1), (-1, 1)] if diagonal else [])
    for y in range(h):
        for x in range(w):
            if sp[x, y][3]:
                continue
            for dx, dy in nb:
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and sp[nx, ny][3] > 0:
                    op[x, y] = color
                    break
    return out


def mix(a, b, t: float):
    return tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3)) + (a[3] if len(a) > 3 else 255,)


def lighten(c, t=0.3):
    return mix(c, (255, 248, 225, 255), t)


def darken(c, t=0.3):
    return mix(c, (8, 14, 26, 255), t)


def bevel(img: Image.Image, light=0.3, dark=0.3) -> Image.Image:
    """左上亮边、右下暗边（只看透明邻居和描边色），给平涂色块一点体积。"""
    w, h = img.size
    out = img.copy()
    sp, op = img.load(), out.load()

    def edge(x, y):
        return not (0 <= x < w and 0 <= y < h) or sp[x, y][3] == 0 or sp[x, y][:3] == INK[:3]

    for y in range(h):
        for x in range(w):
            p = sp[x, y]
            if not p[3] or p[:3] == INK[:3]:
                continue
            if edge(x - 1, y) or edge(x, y - 1):
                op[x, y] = lighten(p, light)[:3] + (p[3],)
            elif edge(x + 1, y) or edge(x, y + 1):
                op[x, y] = darken(p, dark)[:3] + (p[3],)
    return out


BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]


def dither_pick(a, b, t: float, x: int, y: int):
    """两色有序抖动：t=0 全 a，t=1 全 b。"""
    return b if t * 16 > BAYER[y % 4][x % 4] + 0.5 else a


def glow(img: Image.Image, cx: int, cy: int, r: int, color, strength: float = 0.5) -> None:
    """有序抖动的光晕：越靠中心越多像素被提亮成 color。不抗锯齿。"""
    px = img.load()
    for y in range(max(0, cy - r), min(img.height, cy + r + 1)):
        for x in range(max(0, cx - r), min(img.width, cx + r + 1)):
            d = math.hypot(x - cx, y - cy) / r
            if d >= 1:
                continue
            t = (1 - d) ** 1.6 * strength
            if t * 16 > BAYER[y % 4][x % 4] + 0.5:
                p = px[x, y]
                px[x, y] = mix(p, color, 0.35)[:3] + (p[3],)


TIER = "simple"  # art/final.py 导出正式版时改成 "final"，PUB 改成 art/out/final


def save(img: Image.Image, rel: str) -> None:
    p = PUB / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    from PIL import PngImagePlugin

    info = PngImagePlugin.PngInfo()
    info.add_text("tier", TIER)
    img.save(p, pnginfo=info)
    print(f"  {rel:28s} {img.width}×{img.height}")


def strip(frames: list[Image.Image]) -> Image.Image:
    w, h = frames[0].size
    out = Image.new("RGBA", (w * len(frames), h), CLEAR)
    for i, f in enumerate(frames):
        out.alpha_composite(f, (i * w, 0))
    return out


# ---------------- 场景 512×288 ----------------

def scene(day: bool) -> Image.Image:
    W, H = 512, 288
    rnd = random.Random(21)
    k = (lambda n: C("d" + n)) if day else (lambda n: C(n))
    img = Image.new("RGBA", (W, H), k("sky0"))
    px = img.load()
    d = ImageDraw.Draw(img)
    HORIZON, RAIL = 74, 146

    # 天空：上深下浅（白天反过来，上浅下深也行，这里统一用 sky0→sky1 抖动渐变）
    for y in range(HORIZON):
        t = y / HORIZON
        for x in range(W):
            px[x, y] = dither_pick(k("sky0"), k("sky1"), t, x, y)
    if day:
        # 云：几团叠起来的椭圆，平涂两层
        for cx, cy, s in ((70, 22, 1.0), (300, 14, 0.8), (450, 30, 1.1), (190, 40, 0.6)):
            for dx, dy, r in ((0, 0, 9), (10, -4, 11), (22, 0, 9), (12, 4, 9)):
                rr = int(r * s)
                d.ellipse([cx + dx * s - rr, cy + dy - rr // 2, cx + dx * s + rr, cy + dy + rr // 2], fill=hx("#ffffff"))
            d.line([cx - 8 * s, cy + 5, cx + 30 * s, cy + 5], fill=hx("#dff2fb"))
        # 海鸥：小 v 字
        for gx, gy in ((150, 26), (162, 20), (380, 44)):
            d.point([(gx, gy), (gx + 1, gy - 1), (gx + 2, gy), (gx + 3, gy - 1), (gx + 4, gy)], fill=hx("#3a4a5a"))
    else:
        for _ in range(90):
            x, y = rnd.randrange(W), rnd.randrange(HORIZON - 14)
            px[x, y] = C("moon") if rnd.random() < 0.3 else hx("#6f86a8")
        # 月亮（右上），月牙阴影
        d.ellipse([388, 12, 410, 34], fill=C("moon"))
        d.ellipse([394, 10, 416, 32], fill=mix(C("sky0"), C("sky1"), 0.2))
        glow(img, 399, 23, 30, C("moon"), 0.35)

    # 远处岬角和山
    hill = k("sea0") if day else hx("#0c1a2b")
    hill = darken(hill, 0.25) if day else hill
    for x in range(W):
        h1 = int(6 + 5 * math.sin(x / 37) + 3 * math.sin(x / 11 + 1))
        if x < 170 or x > 360:
            for y in range(HORIZON - max(0, h1), HORIZON):
                px[x, y] = mix(hill, k("sky1"), 0.35) if day else hill

    # 海：三段颜色 + 横向浪花短线
    for y in range(HORIZON, RAIL):
        t = (y - HORIZON) / (RAIL - HORIZON)
        base = k("sea0") if t < 0.33 else (k("sea1") if t < 0.66 else k("sea2"))
        for x in range(W):
            px[x, y] = base
    wave = k("wave")
    for _ in range(260):
        y = rnd.randrange(HORIZON + 2, RAIL - 2)
        x = rnd.randrange(W)
        ln = 2 + int((y - HORIZON) / 16) + rnd.randrange(3)
        d.line([x, y, x + ln, y], fill=mix(k("sea1"), wave, 0.6 if not day else 0.8))
    # 月光（或阳光）倒影：一条亮短线的竖带
    rx = 399 if not day else 330
    for y in range(HORIZON + 2, RAIL - 2, 2):
        spread = 4 + (y - HORIZON) // 5
        for _ in range(2):
            x = rx + rnd.randint(-spread, spread)
            d.line([x, y, x + rnd.randint(2, 5), y], fill=C("moon") if not day else hx("#ffffff"))

    # 栈桥：从栏杆中间伸向海里，尽头小亭子
    top_y, bot_y = 96, RAIL
    for y in range(top_y, bot_y):
        t = (y - top_y) / (bot_y - top_y)
        half = int(4 + t * 22)
        col = mix(C("stone3"), C("stone2"), 0.25 + 0.4 * t) if not day else mix(C("stone2"), hx("#e9e4d8"), 0.5 * t + 0.2)
        d.line([256 - half, y, 256 + half, y], fill=col)
        if y % 6 == 0:
            d.line([256 - half, y, 256 + half, y], fill=darken(col, 0.18))
    # 栈桥灯
    for t in (0.15, 0.4, 0.7):
        y = int(top_y + t * (bot_y - top_y))
        half = int(4 + t * 22)
        for sx in (-1, 1):
            x = 256 + sx * (half + 1)
            d.line([x, y - 3 - int(t * 4), x, y], fill=C("stone3") if not day else C("stone"))
            lamp = C("lamp2") if not day else C("cream2")
            d.point((x, y - 4 - int(t * 4)), fill=lamp)
            if not day:
                glow(img, x, y - 4 - int(t * 4), 6 + int(t * 6), C("lamp2"), 0.7)
    # 小亭子（八角亭的剪影：台座 + 柱 + 两层红瓦尖顶）
    d.rectangle([242, 90, 270, 96], fill=C("stone2") if day else C("stone"))
    for x in (245, 251, 261, 267):
        d.line([x, 82, x, 90], fill=C("wood3"))
    d.polygon([(238, 83), (274, 83), (266, 77), (246, 77)], fill=C("tile"))
    d.polygon([(246, 77), (266, 77), (256, 68)], fill=C("tile2") if day else C("tile"))
    d.line([238, 83, 274, 83], fill=C("tile3"))
    d.point((256, 67), fill=C("gold"))
    if not day:
        glow(img, 256, 86, 14, C("lamp2"), 0.6)

    # 两边红瓦屋顶（左上、右上斜坡），一排排鱼鳞瓦
    def roof(x0: int, x1: int, ytop: int, ybot: int, left: bool) -> None:
        for y in range(ytop, ybot):
            t = (y - ytop) / (ybot - ytop)
            edge = int(x0 + (x1 - x0) * t) if left else int(x1 - (x1 - x0) * t)
            xs = range(0, edge) if left else range(edge, W)
            row = (y - ytop) // 5
            for x in xs:
                ox = (x + (row % 2) * 4) % 8
                c = C("tile")
                if (y - ytop) % 5 == 4:
                    c = C("tile3")
                elif ox == 0:
                    c = C("tile3") if not day else darken(C("tile"), 0.2)
                elif (y - ytop) % 5 == 0 and ox in (2, 3, 4):
                    c = C("tile2")
                if not day:
                    c = darken(c, 0.25)
                px[x, y] = c
            # 屋檐（斜边）一条亮线
            ex = edge - 1 if left else edge
            if 0 <= ex < W:
                px[ex, y] = C("tile2") if day else lighten(darken(C("tile"), 0.2), 0.2)
        # 屋檐下的墙和窗
        wall = hx("#e6dccb") if day else hx("#3b3a3f")
        wy = ybot
        xa, xb = (0, x1 - 6) if left else (W - (x1 - x0) - (W - x1) + 6, W)
        if left:
            d.rectangle([0, wy, x1 - 10, RAIL - 1], fill=wall)
            wins = [(12, wy + 8), (44, wy + 8)]
        else:
            d.rectangle([x0 + 10, wy, W - 1, RAIL - 1], fill=wall)
            wins = [(W - 28, wy + 8), (W - 60, wy + 8)]
        for wx, wyy in wins:
            if wyy + 18 >= RAIL:
                continue
            win = C("lamp") if not day else hx("#5d8fb0")
            d.rectangle([wx, wyy, wx + 12, wyy + 16], fill=C("wood3"))
            d.rectangle([wx + 2, wyy + 2, wx + 10, wyy + 14], fill=win)
            d.line([wx + 6, wyy + 2, wx + 6, wyy + 14], fill=C("wood3"))
            d.line([wx + 2, wyy + 8, wx + 10, wyy + 8], fill=C("wood3"))
            if not day:
                d.rectangle([wx + 3, wyy + 3, wx + 5, wyy + 7], fill=C("lamp2"))
                glow(img, wx + 6, wyy + 8, 18, C("lamp"), 0.45)

    roof(0, 112, 20, 96, True)
    roof(400, W, 20, 96, False)

    # 栏杆（石头）：扶手 + 立柱 + 底座
    rail_top = RAIL
    stone_l = C("stone2") if not day else hx("#f1ede4")
    stone_m = C("stone") if not day else hx("#d8d2c4")
    stone_d = C("stone3") if not day else hx("#a9a192")
    d.rectangle([0, rail_top, W, rail_top + 4], fill=stone_m)
    d.line([0, rail_top, W, rail_top], fill=stone_l)
    d.line([0, rail_top + 4, W, rail_top + 4], fill=stone_d)
    for x in range(4, W, 10):
        d.rectangle([x, rail_top + 5, x + 4, rail_top + 15], fill=stone_m)
        d.line([x, rail_top + 5, x, rail_top + 15], fill=stone_l)
        d.line([x + 4, rail_top + 5, x + 4, rail_top + 15], fill=stone_d)
        d.point((x + 2, rail_top + 9), fill=stone_d)
    # 立柱缝里看得见的海
    d.rectangle([0, rail_top + 16, W, rail_top + 19], fill=stone_m)
    d.line([0, rail_top + 19, W, rail_top + 19], fill=stone_d)
    # 栏杆柱头灯
    for x in (96, 416):
        d.rectangle([x - 4, rail_top - 10, x + 4, rail_top + 19], fill=stone_m)
        d.line([x - 4, rail_top - 10, x - 4, rail_top + 19], fill=stone_l)
        d.line([x + 4, rail_top - 10, x + 4, rail_top + 19], fill=stone_d)
        d.rectangle([x - 3, rail_top - 20, x + 3, rail_top - 11], fill=hx("#2a2a30"))
        d.rectangle([x - 2, rail_top - 18, x + 2, rail_top - 12], fill=C("lamp2") if not day else hx("#f4efe0"))
        d.line([x - 4, rail_top - 21, x + 4, rail_top - 21], fill=hx("#2a2a30"))
        if not day:
            glow(img, x, rail_top - 15, 26, C("lamp"), 0.4)

    # 露台地面：大块石板错缝，越近越大（简单两档）
    FLOOR = rail_top + 20
    f0, f1, g = k("floor0"), k("floor1"), k("grout")
    for y in range(FLOOR, H):
        row_h = 14 if y < FLOOR + 42 else 20
        ry = (y - FLOOR) if y < FLOOR + 42 else (y - FLOOR - 42)
        row = ry // row_h + (0 if y < FLOOR + 42 else 10)
        tile_w = 40 if y < FLOOR + 42 else 56
        for x in range(W):
            ox = (x + (row % 2) * tile_w // 2) % tile_w
            if ry % row_h == 0 or ox == 0:
                px[x, y] = g
            else:
                tile_id = (x + (row % 2) * tile_w // 2) // tile_w + row * 7
                px[x, y] = f1 if tile_id % 3 == 0 else f0
    # 地面上的暖光（夜间：两盏灯 + 中间一团月光）
    if not day:
        for x in (96, 416):
            glow(img, x, FLOOR + 6, 44, C("lamp"), 0.22)
        glow(img, 256, 230, 150, hx("#3e5677"), 0.3)
    else:
        glow(img, 256, 230, 170, hx("#fff8e8"), 0.35)

    # 灯串：一条下垂的线，上面一串小灯泡
    def sag(x):
        return int(10 + 18 * math.sin(math.pi * x / W))

    for x in range(W):
        px[x, sag(x)] = hx("#1a1f28") if not day else hx("#5a5048")
    for x in range(12, W, 26):
        y = sag(x) + 1
        bulb = C("lamp2") if not day else hx("#f6efd8")
        d.rectangle([x - 1, y, x + 1, y + 2], fill=bulb)
        if not day:
            d.point((x, y), fill=hx("#fff6d8"))
            glow(img, x, y + 1, 9, C("lamp2"), 0.7)
    return img


# ---------------- 联邦徽记 24×24 ----------------

def emblem(team: str, size: int = 24) -> Image.Image:
    """甲 = 海浪（海蓝），乙 = 瓦片屋顶（瓦红）。形状不同，色盲也分得开。"""
    s = size
    img = Image.new("RGBA", (s, s), CLEAR)
    d = ImageDraw.Draw(img)
    base, light, dark = C(team), C(team + "2"), C(team + "3")
    if s < 20:
        # 小号：方块底 + 一个粗符号（甲：一道 2px 粗的浪；乙：实心屋顶三角）
        d.rectangle([1, 1, s - 2, s - 2], fill=base)
        d.line([1, 1, s - 2, 1], fill=light)
        d.line([1, 1, 1, s - 2], fill=light)
        cream = C("cream")
        if team == "A":
            # 两道 1px 的小浪（≈）：每 4px 一个起伏
            for yy in (s // 2 - 2, s // 2 + 2):
                for x in range(3, s - 3):
                    d.point((x, yy + (0 if (x - 3) % 4 in (0, 1) else 1) - (1 if (x - 3) % 4 == 0 else 0)), fill=cream)
        else:
            d.polygon([(3, s - 5), (s // 2 - 1, 3), (s // 2, 3), (s - 4, s - 5)], fill=cream)
            d.line([3, s - 4, s - 4, s - 4], fill=cream)
        return outline(img)
    # 盾形底
    m = 1
    d.polygon([(m, m), (s - 1 - m, m), (s - 1 - m, s * 0.55), (s // 2, s - 1 - m), (m, s * 0.55)], fill=base)
    img = bevel(img, 0.35, 0.3)
    d = ImageDraw.Draw(img)
    cream = C("cream")
    if team == "A":
        # 两道浪
        for yy in (int(s * 0.32), int(s * 0.56)):
            pts = []
            for x in range(4, s - 4):
                y = yy + round(2 * math.sin((x - 4) / (s - 8) * 2 * math.pi * 1.5))
                pts.append((x, y))
            d.line(pts, fill=cream)
            d.line([(x, y + 1) for x, y in pts], fill=cream)
    else:
        # 一个三角屋顶 + 三排瓦
        cx = s // 2
        d.polygon([(4, int(s * 0.5)), (cx, int(s * 0.18)), (s - 5, int(s * 0.5))], fill=cream)
        for i, yy in enumerate((int(s * 0.36), int(s * 0.46))):
            d.line([(6 + i * 0, yy), (s - 7, yy)], fill=dark)
        d.rectangle([cx - 5, int(s * 0.5), cx + 4, int(s * 0.7)], fill=cream)
        d.rectangle([cx - 1, int(s * 0.58), cx, int(s * 0.7)], fill=dark)
    return outline(img)


# ---------------- 头像框 48×48、名牌九宫格 24×24 ----------------

def frame(team: str) -> Image.Image:
    S = 48
    img = Image.new("RGBA", (S, S), CLEAR)
    d = ImageDraw.Draw(img)
    base, light, dark = C(team), C(team + "2"), C(team + "3")
    d.rectangle([0, 0, S - 1, S - 1], fill=INK)
    d.rectangle([1, 1, S - 2, S - 2], fill=base)
    d.line([1, 1, S - 2, 1], fill=light)
    d.line([1, 1, 1, S - 2], fill=light)
    d.line([2, S - 2, S - 2, S - 2], fill=dark)
    d.line([S - 2, 2, S - 2, S - 2], fill=dark)
    d.rectangle([3, 3, S - 4, S - 4], fill=INK)
    d.rectangle([4, 4, S - 5, S - 5], fill=CLEAR)  # 中间 40×40 透明，头像放在 (4,4)
    # 四角铆钉
    for x, y in ((1, 1), (S - 3, 1), (1, S - 3), (S - 3, S - 3)):
        d.rectangle([x, y, x + 1, y + 1], fill=C("cream"))
    # 右下角徽记缺口：联邦形状（色盲也能认）
    em = emblem(team, 14)
    img.alpha_composite(em, (S - 15, S - 15))
    return img


def plate(team: str) -> Image.Image:
    """名牌底板九宫格：24×24，四边各 8px 不拉伸（CSS border-image: url() 8 fill / 16px）。"""
    S = 24
    img = Image.new("RGBA", (S, S), CLEAR)
    d = ImageDraw.Draw(img)
    base, light, dark = C(team), C(team + "2"), C(team + "3")
    d.rectangle([1, 0, S - 2, S - 1], fill=INK)
    d.rectangle([0, 1, S - 1, S - 2], fill=INK)
    d.rectangle([1, 1, S - 2, S - 2], fill=base)
    d.line([2, 1, S - 3, 1], fill=light)
    d.line([1, 2, 1, S - 3], fill=light)
    d.line([2, S - 2, S - 3, S - 2], fill=dark)
    d.line([S - 2, 2, S - 2, S - 3], fill=dark)
    d.rectangle([3, 3, S - 4, S - 4], fill=INK)
    d.rectangle([4, 4, S - 5, S - 5], fill=hx("#101a29", 232))
    # 顶边中间留一小段亮色缝线
    for x in range(6, S - 6, 2):
        d.point((x, 2), fill=light)
    return img


# ---------------- 头像 40×40（6 个海边小动物，中性色，不和队色撞） ----------------

def avatar(i: int) -> Image.Image:
    S = 40
    bg_top, bg_bot = hx("#24364a"), hx("#1a2838")
    img = Image.new("RGBA", (S, S), bg_top)
    px = img.load()
    for y in range(S):
        for x in range(S):
            px[x, y] = dither_pick(bg_top, bg_bot, y / S, x, y)
    # 地平线：一条浅色的海
    d = ImageDraw.Draw(img)
    d.rectangle([0, 30, S, S], fill=hx("#2b4c66"))
    d.line([0, 30, S, 30], fill=hx("#4f7f9f"))
    spr = Image.new("RGBA", (S, S), CLEAR)
    s = ImageDraw.Draw(spr)
    if i == 0:  # 海鸥
        s.ellipse([10, 12, 30, 34], fill=hx("#f2f2ee"))
        s.ellipse([13, 6, 27, 20], fill=hx("#f2f2ee"))
        s.polygon([(10, 20), (4, 30), (16, 28)], fill=hx("#9aa3ad"))
        s.polygon([(30, 20), (36, 30), (24, 28)], fill=hx("#9aa3ad"))
        s.polygon([(19, 14), (26, 15), (19, 17)], fill=hx("#f0a02a"))
        s.rectangle([16, 10, 17, 11], fill=INK)
        s.rectangle([22, 10, 23, 11], fill=INK)
    elif i == 1:  # 海星
        cx, cy = 20, 21
        pts = []
        for k in range(10):
            r = 15 if k % 2 == 0 else 6
            a = -math.pi / 2 + k * math.pi / 5
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        s.polygon(pts, fill=hx("#f2b636"))
        for k in range(5):
            a = -math.pi / 2 + k * 2 * math.pi / 5
            s.point((round(cx + 8 * math.cos(a)), round(cy + 8 * math.sin(a))), fill=hx("#fff0a8"))
        s.rectangle([16, 18, 17, 19], fill=INK)
        s.rectangle([22, 18, 23, 19], fill=INK)
        s.line([18, 23, 21, 23], fill=hx("#9a5a12"))
    elif i == 2:  # 蛤蜊
        s.pieslice([6, 8, 34, 40], 180, 360, fill=hx("#e8d6b0"))
        s.rectangle([6, 24, 34, 30], fill=hx("#e8d6b0"))
        for x in (11, 16, 20, 24, 29):
            s.line([20, 10, x, 29], fill=hx("#b89a68"))
        s.rectangle([6, 30, 34, 32], fill=hx("#b89a68"))
        s.rectangle([14, 20, 15, 22], fill=INK)
        s.rectangle([25, 20, 26, 22], fill=INK)
    elif i == 3:  # 章鱼
        s.ellipse([9, 4, 31, 26], fill=hx("#a77ad0"))
        for x in range(9, 32, 5):
            s.rectangle([x, 22, x + 3, 33 + (x // 5) % 2 * 2], fill=hx("#a77ad0"))
        s.rectangle([14, 13, 16, 16], fill=hx("#ffffff"))
        s.rectangle([23, 13, 25, 16], fill=hx("#ffffff"))
        s.rectangle([15, 14, 16, 16], fill=INK)
        s.rectangle([24, 14, 25, 16], fill=INK)
        s.point([(12, 8), (14, 7)], fill=hx("#d4b4f0"))
    elif i == 4:  # 海龟
        s.ellipse([8, 14, 32, 34], fill=hx("#5aa05a"))
        s.ellipse([12, 17, 28, 31], fill=hx("#7fc06a"))
        s.line([20, 17, 20, 31], fill=hx("#3c7a3c"))
        s.line([12, 24, 28, 24], fill=hx("#3c7a3c"))
        s.ellipse([15, 4, 25, 16], fill=hx("#9ad07a"))
        s.rectangle([17, 9, 18, 10], fill=INK)
        s.rectangle([22, 9, 23, 10], fill=INK)
        for x, y in ((6, 18), (30, 18), (7, 30), (29, 30)):
            s.ellipse([x - 2, y - 2, x + 3, y + 2], fill=hx("#9ad07a"))
    else:  # 海豹
        s.ellipse([7, 8, 33, 36], fill=hx("#9a8a7a"))
        s.ellipse([12, 20, 28, 34], fill=hx("#bfae98"))
        s.rectangle([14, 15, 16, 17], fill=INK)
        s.rectangle([24, 15, 26, 17], fill=INK)
        s.rectangle([19, 19, 21, 20], fill=INK)
        for y in (21, 23):
            s.line([10, y, 16, y + 1], fill=hx("#ece0cc"))
            s.line([24, y + 1, 30, y], fill=hx("#ece0cc"))
    spr = outline(bevel(spr, 0.2, 0.25))
    img.alpha_composite(spr)
    return img


# ---------------- 名次徽章 36×20 ----------------

RANKS = [
    ("1", "头科", "#f0c04a", "#fff0a8", "#a8761f", "#3a2406"),
    ("2", "二科", "#c9d3dd", "#f4f8fb", "#7d8a97", "#1c2733"),
    ("3", "三科", "#d08c4c", "#f2b47a", "#8a5222", "#2a1404"),
    ("4", "四科", "#6aa8a0", "#9cd4cc", "#3e6e68", "#0c2420"),
    ("5", "二落", "#5f5a78", "#8a84a6", "#3a3650", "#f2ecff"),
    ("6", "大落", "#3e3a3a", "#625c5a", "#221f1f", "#f0e2d0"),
]


def rank_badge(spec) -> Image.Image:
    _, label, base, light, dark, fg = spec
    W, H = 36, 20
    img = Image.new("RGBA", (W, H), CLEAR)
    d = ImageDraw.Draw(img)
    # 飘带：中间矩形 + 两头燕尾
    d.polygon([(1, 3), (6, 3), (6, 16), (1, 16), (3, 9)], fill=hx(dark))
    d.polygon([(W - 2, 3), (W - 7, 3), (W - 7, 16), (W - 2, 16), (W - 4, 9)], fill=hx(dark))
    d.rectangle([4, 1, W - 5, 18], fill=hx(base))
    d.line([5, 2, W - 6, 2], fill=hx(light))
    d.line([5, 17, W - 6, 17], fill=hx(dark))
    img = outline(img)
    t = text_img(label, hx(fg), 1, ink=None)
    paste_center(img, t, W // 2, H // 2)
    return img


# ---------------- 状态图标 24×24 ----------------

def _canvas():
    img = Image.new("RGBA", (24, 24), CLEAR)
    return img, ImageDraw.Draw(img)


def flame_shape(d: ImageDraw.ImageDraw, cx: int, base_y: int, h: int, w: int, phase: float = 0.0,
                cols=("#e0482a", "#f29a2e", "#ffe27a")) -> None:
    for layer, (scale, col) in enumerate(zip((1.0, 0.68, 0.38), cols)):
        hh, ww = h * scale, w * scale
        pts = []
        for k in range(17):
            t = k / 16
            y = base_y - t * hh
            sway = math.sin(phase + t * 3.2) * (1.6 * t) * (1 + layer * 0.3)
            r = ww / 2 * math.sin(math.pi * min(1, (1 - t) * 1.05)) ** 0.8 * (1 - t * 0.35)
            pts.append((cx + sway - r, y))
        for k in range(16, -1, -1):
            t = k / 16
            y = base_y - t * hh
            sway = math.sin(phase + t * 3.2) * (1.6 * t) * (1 + layer * 0.3)
            r = ww / 2 * math.sin(math.pi * min(1, (1 - t) * 1.05)) ** 0.8 * (1 - t * 0.35)
            pts.append((cx + sway + r, y))
        d.polygon([(round(x), round(y)) for x, y in pts], fill=hx(col))


def mini_card(d, x, y, w=9, h=12, fill="#f6ecd0", pip="#c4512f"):
    d.rectangle([x, y, x + w - 1, y + h - 1], fill=hx(fill))
    d.line([x + 1, y + h - 1, x + w - 1, y + h - 1], fill=hx("#b8a882"))
    d.rectangle([x + 2, y + 2, x + 3, y + 3], fill=hx(pip))


def status_icons() -> dict[str, Image.Image]:
    icons: dict[str, Image.Image] = {}

    # 够级：三张扇形牌 + 金星
    img, d = _canvas()
    mini_card(d, 3, 7, pip="#2f86d6")
    mini_card(d, 7, 5)
    mini_card(d, 11, 7, pip="#2f86d6")
    star = [(18, 2), (19, 5), (22, 5), (20, 7), (21, 10), (18, 8), (15, 10), (16, 7), (14, 5), (17, 5)]
    d.polygon(star, fill=C("gold"))
    d.point((18, 5), fill=C("gold2"))
    d.rectangle([5, 19, 18, 20], fill=C("gold3"))
    icons["gouji"] = outline(img)

    # 烧牌中：火焰
    img, d = _canvas()
    flame_shape(d, 12, 22, 20, 15)
    icons["shao"] = outline(img)

    # 烧牌成功：火焰 + 绿色对勾（对勾带白边，红绿色盲靠形状认）
    img, d = _canvas()
    flame_shape(d, 10, 22, 18, 14)
    d.line([(13, 16), (16, 19), (22, 11)], fill=hx("#ffffff"), width=3)
    d.line([(14, 16), (16, 18), (21, 12)], fill=hx("#3aa860"), width=1)
    icons["shao-ok"] = outline(img)

    # 解烧：小火苗被一滴蓝水压住
    img, d = _canvas()
    flame_shape(d, 12, 22, 11, 14, cols=("#8a4a2a", "#b0703a", "#d8a060"))
    d.polygon([(12, 1), (17, 9), (17, 13), (12, 16), (7, 13), (7, 9)], fill=hx("#4aa8e8"))
    d.point([(9, 10), (9, 11)], fill=hx("#c8ecff"))
    icons["jieshao"] = outline(img)

    # 无头：人像的头只剩一个虚线圈（对头已经走了）
    img, d = _canvas()
    d.pieslice([3, 14, 20, 32], 180, 360, fill=hx("#8a93a6"))
    d.rectangle([3, 22, 20, 23], fill=hx("#8a93a6"))
    for a0 in (20, 110, 200, 290):
        d.arc([5, 1, 18, 14], a0, a0 + 50, fill=hx("#f6ecd0"), width=2)
    d.line([18, 2, 22, 6], fill=hx("#e0482a"), width=2)
    d.line([22, 2, 18, 6], fill=hx("#e0482a"), width=2)
    icons["wutou"] = outline(img)

    # 让牌：举起的手掌（先不出）+ 往右的箭头（让后面的人先接）
    img, d = _canvas()
    skin, sk2 = hx("#f2cfa0"), hx("#c89466")
    d.rectangle([3, 12, 12, 21], fill=skin)
    for i, x in enumerate((3, 6, 9)):
        d.rectangle([x, 5 + (i == 1) * -1, x + 1, 12], fill=skin)
    d.rectangle([11, 9, 12, 12], fill=skin)
    d.rectangle([13, 14, 14, 17], fill=skin)
    d.line([3, 21, 12, 21], fill=sk2)
    d.rectangle([15, 7, 19, 9], fill=hx("#79bdf2"))
    d.polygon([(19, 3), (23, 8), (19, 13)], fill=hx("#79bdf2"))
    icons["rang"] = outline(img)

    # 接风：三道风线
    img, d = _canvas()
    for y, x0, x1, r in ((6, 3, 16, 3), (12, 2, 20, 3), (18, 5, 14, 2)):
        d.line([x0, y, x1, y], fill=hx("#c8ecff"), width=2)
        d.arc([x1 - r, y - 2 * r, x1 + r, y], 270, 90 + 180, fill=hx("#c8ecff"), width=2)
    icons["jiefeng"] = outline(img)

    # 革命：两张牌 + 一圈循环箭头（大小翻过来）
    img, d = _canvas()
    mini_card(d, 7, 6, w=10, h=13, fill="#f6ecd0", pip="#c4512f")
    d.arc([1, 1, 22, 22], 30, 160, fill=C("gold"), width=2)
    d.arc([1, 1, 22, 22], 210, 340, fill=C("gold"), width=2)
    d.polygon([(2, 9), (6, 9), (4, 13)], fill=C("gold"))
    d.polygon([(18, 14), (22, 14), (20, 10)], fill=C("gold"))
    icons["geming"] = outline(img)

    # 抗贡：盾牌
    img, d = _canvas()
    d.polygon([(4, 3), (20, 3), (20, 12), (12, 22), (4, 12)], fill=hx("#9aa3ad"))
    d.polygon([(7, 6), (17, 6), (17, 12), (12, 18), (7, 12)], fill=hx("#c9d3dd"))
    d.line([12, 6, 12, 17], fill=hx("#7d8a97"))
    img = bevel(img, 0.25, 0.25)
    icons["kanggong"] = outline(img)

    # 四人乱缠：四个方向的箭头缠在一起
    img, d = _canvas()
    cols = ["#2f86d6", "#d4553a", "#79bdf2", "#f39068"]
    d.ellipse([7, 7, 16, 16], outline=hx("#f6ecd0"), width=2)
    for k, col in enumerate(cols):
        a = k * math.pi / 2 + math.pi / 4
        ex, ey = 11.5 + 10 * math.cos(a), 11.5 + 10 * math.sin(a)
        d.line([11.5 + 4 * math.cos(a), 11.5 + 4 * math.sin(a), ex, ey], fill=hx(col), width=2)
        d.rectangle([round(ex) - 1, round(ey) - 1, round(ex) + 1, round(ey) + 1], fill=hx(col))
    icons["luanchan"] = outline(img)
    return icons


# ---------------- 对头标记 ----------------

def duitou_mark() -> Image.Image:
    """24×24：上下相对的两个箭头（对头 = 正对面），金色。"""
    img, d = _canvas()
    g, g2, g3 = C("gold"), C("gold2"), C("gold3")
    d.polygon([(12, 1), (19, 8), (14, 8), (14, 10), (10, 10), (10, 8), (5, 8)], fill=g)
    d.polygon([(12, 22), (19, 15), (14, 15), (14, 13), (10, 13), (10, 15), (5, 15)], fill=g)
    d.line([6, 11, 17, 11], fill=g3)
    d.line([6, 12, 17, 12], fill=g3)
    img = bevel(img, 0.35, 0.3)
    return outline(img)


def duitou_ring() -> Image.Image:
    """64×64 × 4 帧，循环：对头头像外的一圈金色虚线框，虚线沿框转动（够级牌打出时套在对头头像上）。"""
    frames = []
    S = 64
    for f in range(4):
        img = Image.new("RGBA", (S, S), CLEAR)
        px = img.load()
        per = []
        for x in range(2, S - 2):
            per.append((x, 2))
        for y in range(2, S - 2):
            per.append((S - 3, y))
        for x in range(S - 3, 1, -1):
            per.append((x, S - 3))
        for y in range(S - 3, 1, -1):
            per.append((2, y))
        for i, (x, y) in enumerate(per):
            if (i + f * 2) % 8 < 5:
                for dx in (0, 1) if y in (2, S - 3) else (0,):
                    pass
                px[x, y] = C("gold")
                # 两像素粗
                ix = x + (1 if x == 2 else -1 if x == S - 3 else 0)
                iy = y + (1 if y == 2 else -1 if y == S - 3 else 0)
                px[ix, iy] = C("gold2")
        # 四角箭头
        for cx, cy in ((0, 0), (S - 6, 0), (0, S - 6), (S - 6, S - 6)):
            ImageDraw.Draw(img).rectangle([cx, cy, cx + 5, cy + 5], fill=C("gold"))
        frames.append(outline(img))
    return strip(frames)


# ---------------- 特效 ----------------

BOLD_CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc"  # W6（index 2），22px 单色渲染，只给「够级！」大字用


def big_text(s: str, size: int = 22, fill=None, shadow=None) -> Image.Image:
    """大号粗体字（单色渲染、不抗锯齿），1px 描边 + 右下 1px 投影。12px 像素字放 2 倍时「够」字笔画挤成一团（遗留 I1），
    所以「够级！」的大字改用系统粗黑体按 22px 原生像素画，笔画清楚。没有这个字体的机器退回 12px 像素字 ×2。"""
    fill = fill or C("cream")
    try:
        f = ImageFont.truetype(BOLD_CJK, size, index=2)
    except OSError:
        small = text_img(s, fill, 1, ink=None)
        return outline(small.resize((small.width * 2, small.height * 2), Image.NEAREST))
    d0 = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    x0, y0, x1, y1 = d0.textbbox((0, 0), s, font=f)
    base = Image.new("RGBA", (x1 - x0 + 4, y1 - y0 + 4), CLEAR)
    d = ImageDraw.Draw(base)
    d.fontmode = "1"
    d.text((2 - x0, 2 - y0), s, font=f, fill=fill)
    if shadow is not None:
        sh = Image.new("RGBA", (base.width + 1, base.height + 1), CLEAR)
        sh.paste(Image.new("RGBA", base.size, shadow), (1, 1), base.split()[3])
        sh.alpha_composite(base)
        base = sh
    return outline(crop_alpha(base))


def fx_gouji(burst: Image.Image | None = None) -> Image.Image:
    """96×40 × 6 帧，播一次：爆炸形从小到大，第 3 帧起「够级！」大字（22px 粗体）弹一下，最后一帧停住。
    burst：PixelLab 出的 96×40 透明爆炸形（正式版）；不给就用代码画的星形。字一直由代码画。"""
    W, H = 96, 40
    frames = []
    small = text_img("够级！", C("cream"), 1, ink=None)
    big = big_text("够级！", 22, shadow=C("tile3"))
    for f in range(6):
        img = Image.new("RGBA", (W, H), CLEAR)
        if burst is not None:
            k = [0.45, 0.8, 1.06, 0.98, 1.0, 1.0][f]
            b = burst.resize((max(1, round(W * k)), max(1, round(H * k))), Image.NEAREST)
            if b.width > W or b.height > H:
                b = b.crop(((b.width - W) // 2, (b.height - H) // 2, (b.width - W) // 2 + W, (b.height - H) // 2 + H))
            paste_center(img, b, W // 2, H // 2)
        else:
            d = ImageDraw.Draw(img)
            r = [8, 16, 22, 20, 19, 19][f]
            rot = f * 0.18
            rays = []
            for k in range(16):
                a = rot + k * math.pi / 8
                rr = r * (1.0 if k % 2 == 0 else 0.55)
                rays.append((W / 2 + rr * 2.2 * math.cos(a), H / 2 + rr * math.sin(a)))
            d.polygon([(round(x), round(y)) for x, y in rays], fill=C("lamp"))
            inner = [(W / 2 + (x - W / 2) * 0.72, H / 2 + (y - H / 2) * 0.72) for x, y in rays]
            d.polygon([(round(x), round(y)) for x, y in inner], fill=C("tile"))
            if f >= 2:
                d.rectangle([W // 2 - 38, H // 2 - 12, W // 2 + 37, H // 2 + 11], fill=C("ink"))
                d.rectangle([W // 2 - 37, H // 2 - 11, W // 2 + 36, H // 2 + 10], fill=C("tile3"))
            img = outline(img)
        if f == 1:
            paste_center(img, small, W // 2, H // 2)
        elif f >= 2:
            dy = [0, 0, -2, 1, 0, 0][f]
            paste_center(img, big, W // 2, H // 2 + dy)
        frames.append(img)
    return strip(frames)


def fx_flame() -> Image.Image:
    """16×24 × 6 帧循环：烧牌按钮两边的小火苗。"""
    frames = []
    for f in range(6):
        img = Image.new("RGBA", (16, 24), CLEAR)
        d = ImageDraw.Draw(img)
        h = 19 + [0, 1, 2, 1, 0, -1][f]
        flame_shape(d, 8, 22, h, 12, phase=f * math.pi / 3)
        frames.append(outline(img))
    return strip(frames)


def burst_frames(n: int, S: int, palette: list[str], kind: str, seed: int) -> list[Image.Image]:
    rnd = random.Random(seed)
    parts = [(rnd.uniform(0, 2 * math.pi), rnd.uniform(0.55, 1.0), rnd.randrange(len(palette))) for _ in range(28)]
    frames = []
    for f in range(n):
        t = f / (n - 1)
        img = Image.new("RGBA", (S, S), CLEAR)
        d = ImageDraw.Draw(img)
        c = S // 2
        if kind == "burn":
            # 火焰从底部窜起再散成火星
            if t < 0.7:
                flame_shape(d, c, S - 6, int(S * (0.35 + 0.55 * math.sin(math.pi * t / 0.7 * 0.5 + 0.2))), int(S * 0.55),
                            phase=f)
            for a, sp, ci in parts:
                if t < 0.2:
                    continue
                rr = (t - 0.2) * S * 0.55 * sp
                x, y = c + rr * math.cos(a), S - 14 - abs(rr * math.sin(a)) * 1.2
                if 0 <= x < S and 0 <= y < S:
                    sz = 2 if t < 0.75 else 1
                    d.rectangle([x, y, x + sz - 1, y + sz - 1], fill=hx(palette[ci]))
        elif kind == "douse":
            # 一团水落下、溅开，火苗变成烟
            if t < 0.35:
                y = int(12 + t / 0.35 * (S * 0.4))
                d.polygon([(c, y - 10), (c + 7, y), (c + 7, y + 4), (c, y + 9), (c - 7, y + 4), (c - 7, y)], fill=hx("#4aa8e8"))
                flame_shape(d, c, S - 6, int(S * 0.35), int(S * 0.4), phase=f, cols=("#e0482a", "#f29a2e", "#ffe27a"))
            else:
                k = (t - 0.35) / 0.65
                for a, sp, ci in parts:
                    if math.sin(a) > 0.2:
                        continue
                    rr = k * S * 0.45 * sp
                    x, y = c + rr * math.cos(a), S * 0.62 + rr * math.sin(a) + k * k * 14
                    if 0 <= x < S and 0 <= y < S:
                        d.rectangle([x, y, x + 1, y + 1], fill=hx("#79bdf2" if ci % 2 else "#c8ecff"))
                # 烟：三团灰圈往上飘
                for j in range(3):
                    sy = S - 12 - k * 26 - j * 6
                    sx = c - 8 + j * 8 + math.sin(k * 6 + j) * 2
                    r = 3 + j + k * 3
                    d.ellipse([sx - r, sy - r, sx + r, sy + r], fill=hx("#9aa3ad", 255 if k < 0.8 else 0))
        else:  # finish / chuan：星星或烟花散开
            for a, sp, ci in parts:
                rr = (0.15 + 0.85 * math.sin(math.pi / 2 * t)) * (S * 0.46) * sp
                x, y = c + rr * math.cos(a), c + rr * math.sin(a) + (t ** 2) * 6
                if t > 0.9 and ci % 2:
                    continue
                if 0 <= x < S - 1 and 0 <= y < S - 1:
                    sz = 3 if t < 0.4 else (2 if t < 0.8 else 1)
                    d.rectangle([x, y, x + sz - 1, y + sz - 1], fill=hx(palette[ci]))
            if t < 0.5:
                r = int(3 + t * 14)
                star = []
                for k in range(8):
                    rr = r if k % 2 == 0 else r * 0.35
                    a = -math.pi / 2 + k * math.pi / 4
                    star.append((c + rr * math.cos(a), c + rr * math.sin(a)))
                d.polygon([(round(x), round(y)) for x, y in star], fill=C("gold2"))
        frames.append(outline(img) if f < n - 1 else img)
    return frames


def fx_chuan() -> Image.Image:
    """128×96 × 10 帧，播一次：串三户——三朵烟花依次炸开（不带字，界面另外显示「串三户」）。"""
    W, H, n = 128, 96, 10
    shells = [(30, 34, 0, ["#79bdf2", "#2f86d6", "#f6ecd0"]), (96, 30, 2, ["#f39068", "#d4553a", "#ffd27a"]),
              (64, 52, 4, ["#f0c04a", "#fff0a8", "#f6ecd0"])]
    frames = []
    for f in range(n):
        img = Image.new("RGBA", (W, H), CLEAR)
        for x, y, start, pal in shells:
            k = f - start
            if k < 0:
                # 升空的尾迹
                d = ImageDraw.Draw(img)
                ty = H - 4 - (f + 1) * (H - y) / (start + 1)
                d.line([x, H - 2, x, int(ty)], fill=hx(pal[2], 140))
                continue
            sub = burst_frames(6, 64, pal, "finish", seed=x * 7 + y)
            if k < 6:
                img.alpha_composite(sub[k], (x - 32, y - 32))
        frames.append(img)
    return strip(frames)


def fx_tribute_arrow() -> Image.Image:
    """48×16 × 4 帧循环：朝右的三道箭头依次亮起（进贡：谁给谁）。"""
    frames = []
    for f in range(4):
        img = Image.new("RGBA", (48, 16), CLEAR)
        d = ImageDraw.Draw(img)
        for k in range(4):
            x = 4 + k * 11
            on = (k == f)
            col = C("gold2") if on else C("gold") if (k - f) % 4 == 3 else C("gold3")
            d.polygon([(x, 2), (x + 6, 2), (x + 12, 8), (x + 6, 14), (x, 14), (x + 6, 8)], fill=col)
        frames.append(outline(img))
    return strip(frames)


def fx_trail() -> Image.Image:
    """16×16 × 4 帧循环：飞牌后面的小闪光（进贡飞牌时跟在牌背后面）。"""
    frames = []
    for f in range(4):
        img = Image.new("RGBA", (16, 16), CLEAR)
        d = ImageDraw.Draw(img)
        r = [2, 5, 6, 3][f]
        c = 8
        d.line([c - r, c, c + r, c], fill=C("gold2"))
        d.line([c, c - r, c, c + r], fill=C("gold2"))
        if r > 3:
            d.point([(c - 2, c - 2), (c + 2, c + 2), (c - 2, c + 2), (c + 2, c - 2)], fill=C("gold"))
        d.point((c, c), fill=hx("#ffffff"))
        frames.append(outline(img))
    return strip(frames)


def seagull() -> Image.Image:
    """24×16 × 4 帧循环：海鸥扇翅（场景和结算画面的小装饰）。"""
    frames = []
    wing = [(-5, 0), (-2, 0), (2, 0), (-2, 0)]
    for f in range(4):
        img = Image.new("RGBA", (24, 16), CLEAR)
        d = ImageDraw.Draw(img)
        dy = wing[f][0]
        d.ellipse([9, 7, 15, 11], fill=hx("#f2f2ee"))
        d.polygon([(10, 8), (3, 8 + dy), (6, 10)], fill=hx("#c9d3dd"))
        d.polygon([(14, 8), (21, 8 + dy), (18, 10)], fill=hx("#c9d3dd"))
        d.point((15, 8), fill=hx("#f0a02a"))
        frames.append(outline(img))
    return strip(frames)


def ribbon(team: str) -> Image.Image:
    """160×32 结算横幅（不带字，界面在上面写「甲联邦胜」之类）：联邦色飘带 + 两头燕尾 + 金边。"""
    W, H = 160, 32
    img = Image.new("RGBA", (W, H), CLEAR)
    d = ImageDraw.Draw(img)
    base, light, dark = C(team), C(team + "2"), C(team + "3")
    d.polygon([(1, 8), (22, 8), (22, 29), (1, 29), (8, 18)], fill=dark)
    d.polygon([(W - 2, 8), (W - 23, 8), (W - 23, 29), (W - 2, 29), (W - 9, 18)], fill=dark)
    d.rectangle([14, 2, W - 15, 25], fill=base)
    d.line([15, 3, W - 16, 3], fill=light)
    d.line([15, 4, W - 16, 4], fill=C("gold"))
    d.line([15, 23, W - 16, 23], fill=C("gold"))
    d.line([15, 24, W - 16, 24], fill=dark)
    img = outline(img)
    em = emblem(team, 16)
    img.alpha_composite(em, (18, 6))
    img.alpha_composite(em, (W - 34, 6))
    return img


def icon32() -> Image.Image:
    """网页图标 32×32：后面一张瓦红牌、前面一张奶油色牌，牌面上一道海蓝的浪。"""
    img = Image.new("RGBA", (32, 32), CLEAR)
    d = ImageDraw.Draw(img)
    d.rectangle([2, 3, 17, 25], fill=C("B"))
    d.rectangle([4, 5, 15, 23], fill=C("B3"))
    d.polygon([(6, 14), (10, 8), (13, 14)], fill=C("B2"))
    d.rectangle([12, 7, 29, 29], fill=C("cream"))
    d.line([13, 28, 29, 28], fill=C("cream2"))
    for yy in (14, 20):
        pts = [(x, yy + round(2 * math.sin((x - 15) / 12 * 2 * math.pi))) for x in range(15, 27)]
        d.line(pts, fill=C("A"))
        d.line([(x, y + 1) for x, y in pts], fill=C("A"))
    return outline(img)


# ---------------- 封面（首发用开工样张 A 裁 384×192） ----------------

def launch_cover() -> None:
    src = Path.home() / "projects" / "pipeline" / "games" / "gouji" / "assets" / "sample-a.png"
    if not src.exists():
        print("  (没找到样张 A，跳过 art/cover-launch.png)")
        return
    im = Image.open(src).convert("RGBA")
    im.crop((64, 10, 448, 202)).save(ROOT / "art" / "cover-launch.png")
    print("  art/cover-launch.png 384×192（首发大厅封面，裁自开工样张 A，不进 public/）")


# ---------------- 主流程 ----------------

STATUS = ["gouji", "shao", "shao-ok", "jieshao", "wutou", "rang", "jiefeng", "geming", "kanggong", "luanchan"]


def build() -> None:
    print("画简洁版 →", PUB)
    save(scene(False), "scene-night.png")
    save(scene(True), "scene-day.png")
    save(icon32(), "icon.png")
    for t in ("A", "B"):
        tl = t.lower()
        save(emblem(t), f"team/{tl}.png")
        save(frame(t), f"seat/frame-{tl}.png")
        save(plate(t), f"seat/plate-{tl}.png")
        save(ribbon(t), f"deco/ribbon-{tl}.png")
    for i in range(6):
        save(avatar(i), f"avatar/{i}.png")
    save(duitou_mark(), "marks/duitou.png")
    save(duitou_ring(), "fx/duitou-ring.png")
    for r in RANKS:
        save(rank_badge(r), f"rank/{r[0]}.png")
    for name, img in status_icons().items():
        save(img, f"status/{name}.png")
    save(fx_gouji(), "fx/gouji.png")
    save(fx_flame(), "fx/flame.png")
    save(strip(burst_frames(8, 64, ["#e0482a", "#f29a2e", "#ffe27a", "#fff0a8"], "burn", 3)), "fx/burn.png")
    save(strip(burst_frames(6, 64, ["#79bdf2", "#c8ecff"], "douse", 5)), "fx/douse.png")
    save(strip(burst_frames(8, 64, ["#f0c04a", "#fff0a8", "#f6ecd0", "#79bdf2", "#f39068"], "finish", 9)), "fx/finish.png")
    save(fx_chuan(), "fx/chuan.png")
    save(fx_tribute_arrow(), "fx/tribute-arrow.png")
    save(fx_trail(), "fx/trail.png")
    save(seagull(), "deco/seagull.png")
    launch_cover()


def check(pub: Path | None = None) -> int:
    """spec.md 的素材表（以 `| \\`路径\\`` 开头、带 W×H 和帧数的行）和 public/art（或 --dir 给的目录）一一对应、尺寸对。"""
    PUB = pub or globals()["PUB"]
    print("核对目录", PUB)
    rows = []
    for line in SPEC.read_text().splitlines():
        m = re.match(r"\|\s*`([^`]+\.png)`\s*\|\s*(\d+)×(\d+)\s*\|[^|]*\|[^|]*\|\s*(\d+)\s*\|", line)
        if m:
            rows.append((m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))))
    bad = 0
    seen = set()
    for rel, w, h, n in rows:
        seen.add(rel)
        p = PUB / rel
        if not p.exists():
            print("缺文件", rel)
            bad += 1
            continue
        im = Image.open(p)
        if im.size != (w * n, h):
            print(f"尺寸不对 {rel}: 文件 {im.size}，spec {w}×{h}×{n} 帧 → 应为 {w * n}×{h}")
            bad += 1
        tier = im.info.get("tier", "final")
        print(f"  ok {rel:28s} {im.size[0]}×{im.size[1]}  {'简洁版' if tier == 'simple' else '正式'}")
    for p in sorted(PUB.rglob("*.png")):
        rel = p.relative_to(PUB).as_posix()
        if rel not in seen:
            print("spec 里没有的文件", rel)
            bad += 1
    print(f"spec 共 {len(rows)} 项，问题 {bad} 个")
    return bad


def preview() -> None:
    """拼几张「缩放到显示尺寸」的预览：背景 3×（1536×864 裁 1440×790）上摆座位、徽章、图标、特效。"""
    out = ROOT / "art" / "out" / ("preview" if PUB == ROOT / "apps" / "web" / "public" / "art" else "preview-final")
    out.mkdir(parents=True, exist_ok=True)
    cards = ROOT / "apps" / "web" / "public" / "cards-pixel"
    for theme in ("night", "day"):
        bg = Image.open(PUB / f"scene-{theme}.png").convert("RGBA").resize((1536, 864), Image.NEAREST).crop((48, 37, 1488, 827))

        def up(rel, k, frame=None, frames=1):
            im = Image.open(PUB / rel).convert("RGBA")
            if frames > 1:
                w = im.width // frames
                im = im.crop((w * frame, 0, w * (frame + 1), im.height))
            return im.resize((im.width * k, im.height * k), Image.NEAREST)

        # 6 个座位：自己下方，对头正上方；甲乙交替
        seats = [(720, 640), (1180, 470), (1180, 170), (720, 90), (260, 170), (260, 470)]
        for s, (x, y) in enumerate(seats):
            team = "a" if s % 2 == 0 else "b"
            pl = Image.open(PUB / f"seat/plate-{team}.png").convert("RGBA")
            # 九宫格拉伸成 224×96（边 8px×2 倍）
            W, H, b, k = 224, 96, 8, 2
            panel = Image.new("RGBA", (W, H), CLEAR)
            src = pl.resize((48, 48), Image.NEAREST)
            B = b * k
            panel.alpha_composite(src.crop((0, 0, B, B)), (0, 0))
            panel.alpha_composite(src.crop((48 - B, 0, 48, B)), (W - B, 0))
            panel.alpha_composite(src.crop((0, 48 - B, B, 48)), (0, H - B))
            panel.alpha_composite(src.crop((48 - B, 48 - B, 48, 48)), (W - B, H - B))
            panel.alpha_composite(src.crop((B, 0, 48 - B, B)).resize((W - 2 * B, B), Image.NEAREST), (B, 0))
            panel.alpha_composite(src.crop((B, 48 - B, 48 - B, 48)).resize((W - 2 * B, B), Image.NEAREST), (B, H - B))
            panel.alpha_composite(src.crop((0, B, B, 48 - B)).resize((B, H - 2 * B), Image.NEAREST), (0, B))
            panel.alpha_composite(src.crop((48 - B, B, 48, 48 - B)).resize((B, H - 2 * B), Image.NEAREST), (W - B, B))
            panel.alpha_composite(src.crop((B, B, 48 - B, 48 - B)).resize((W - 2 * B, H - 2 * B), Image.NEAREST), (B, B))
            bg.alpha_composite(panel, (x - W // 2, y - H // 2))
            bg.alpha_composite(up(f"avatar/{s}.png", 2), (x - W // 2 + 8 + 8, y - 40))
            bg.alpha_composite(up(f"seat/frame-{team}.png", 2), (x - W // 2 + 8, y - 48))
            name = text_img(f"玩家{s}", C("cream"), 2, ink=None)
            bg.alpha_composite(name, (x - W // 2 + 112, y - 40))
            bg.alpha_composite(up(f"rank/{s + 1}.png", 2), (x - W // 2 + 108, y + 2))
            if s == 3:
                bg.alpha_composite(up("fx/duitou-ring.png", 2, 0, 4), (x - W // 2 + 8 - 8, y - 48 - 8))
                bg.alpha_composite(up("marks/duitou.png", 2), (x + W // 2 - 52, y - 44))
        # 状态图标一排（2×）
        for i, n in enumerate(STATUS):
            bg.alpha_composite(up(f"status/{n}.png", 2), (420 + i * 60, 300))
        # 中间：出牌 + 够级提示
        for i, c in enumerate(["SK", "HK", "BJ"]):
            p = cards / f"{c}.png"
            if p.exists():
                bg.alpha_composite(up(str(p.relative_to(PUB.parent).as_posix()).replace("cards-pixel", "../cards-pixel"), 2) if False else Image.open(p).convert("RGBA").resize((82, 114), Image.NEAREST), (620 + i * 40, 360))
        bg.alpha_composite(up("fx/gouji.png", 2, 5, 6), (624, 470))
        bg.alpha_composite(up("fx/flame.png", 2, 2, 6), (880, 380))
        bg.alpha_composite(up("fx/tribute-arrow.png", 2, 1, 4), (920, 400))
        bg.alpha_composite(up("deco/ribbon-a.png", 2), (40, 700))
        bg.alpha_composite(up("deco/ribbon-b.png", 2), (1080, 700))
        bg.save(out / f"table-{theme}-1440.png")
        print("  预览", out / f"table-{theme}-1440.png")

    # 特效帧拼图（每帧 2×，带格子背景方便看透明）
    for rel, n in (("fx/gouji.png", 6), ("fx/flame.png", 6), ("fx/burn.png", 8), ("fx/douse.png", 6), ("fx/finish.png", 8),
                   ("fx/chuan.png", 10), ("fx/tribute-arrow.png", 4), ("fx/trail.png", 4), ("fx/duitou-ring.png", 4),
                   ("deco/seagull.png", 4)):
        im = Image.open(PUB / rel).convert("RGBA")
        im = im.resize((im.width * 2, im.height * 2), Image.NEAREST)
        bgc = Image.new("RGBA", im.size, hx("#1c2533"))
        bgc.alpha_composite(im)
        bgc.save(out / ("strip-" + rel.replace("/", "-")))
    # 小图总览：每样 2× 和 1×，夜间底和白天底各一行
    items = [f"team/{t}.png" for t in "ab"] + [f"seat/frame-{t}.png" for t in "ab"] + [f"avatar/{i}.png" for i in range(6)] + \
            ["marks/duitou.png", "icon.png"] + [f"rank/{i}.png" for i in range(1, 7)] + [f"status/{n}.png" for n in STATUS]
    for theme, col in (("night", "#16202e"), ("day", "#f4f1ea")):
        sheet = Image.new("RGBA", (1440, 300), hx(col))
        x, y = 12, 12
        for rel in items:
            im = Image.open(PUB / rel).convert("RGBA")
            im2 = im.resize((im.width * 2, im.height * 2), Image.NEAREST)
            if x + im2.width > 1430:
                x, y = 12, y + 110
            sheet.alpha_composite(im2, (x, y))
            sheet.alpha_composite(im, (x, y + im2.height + 4))
            x += im2.width + 14
        sheet.save(out / f"sheet-{theme}.png")
        print("  预览", out / f"sheet-{theme}.png")


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--check" in args:
        # --dir art/out/final：核对正式美术定稿目录（相对仓库根目录或绝对路径）
        target = None
        if "--dir" in args:
            target = Path(args[args.index("--dir") + 1])
            target = target if target.is_absolute() else ROOT / target
        sys.exit(1 if check(target) else 0)
    build()
    if "--preview" in args:
        preview()
