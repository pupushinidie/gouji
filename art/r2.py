"""够级 正式美术第二轮（PixelLab）：动画 + 补封面。结果在 art/out/r2/。

首帧都用第一轮挑出来的 v2 静态图拼（主线程先画好，线程里只读）：
- flame（16×24×6 循环）：v2 火苗 0 放进 32×32 画布，first=last，6 帧（返回 7 帧，去掉重复的末帧），再裁回 16×24。
- seagull（24×16×4 循环）：v2 海鸥 0 放进 32×32 画布，first=last，4 帧。
- burn（64×64×8 播一次）：v2 大火 20 放在底部中间，火焰窜起再散成火星。
- douse（64×64×6 播一次）：v2 大火 36 在底部 + v2 水滴 1 在上方，水滴落下、火变烟、水花。
- finish（64×64×8 播一次）：v2 金星 26 在中间，炸成金色星屑和彩色碎片。
- chuan（128×96×10 播一次）：三支 v2 火箭（蓝 18、红 40、金 43）在底部，依次升空炸开。
每样 3 个种子。用法同 r1.py。
"""
from __future__ import annotations

import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

import pixellab

ART = pixellab.ART
V2 = ART / "out" / "r1" / "v2"
OUT = ART / "out" / "r2"
FIRST = OUT / "first"


def v2(name: str, k: int) -> Image.Image:
    p = V2 / name / (f"{name}.png" if k == 0 else f"{name}-{k}.png")
    return Image.open(p).convert("RGBA")


def canvas(w, h, items):
    c = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for im, (x, y) in items:
        c.alpha_composite(im, (x, y))
    return c


def make_first_frames() -> None:
    FIRST.mkdir(parents=True, exist_ok=True)
    canvas(32, 32, [(v2("flame", 0), (8, 8))]).save(FIRST / "flame.png")
    canvas(32, 32, [(v2("seagull", 0), (4, 8))]).save(FIRST / "seagull.png")
    canvas(64, 64, [(v2("fire-big", 20), (16, 24))]).save(FIRST / "burn.png")
    canvas(64, 64, [(v2("fire-big", 36), (16, 24)), (v2("drop", 1), (24, 0))]).save(FIRST / "douse.png")
    canvas(64, 64, [(v2("star", 26), (20, 20))]).save(FIRST / "finish.png")
    canvas(128, 96, [(v2("rocket", 18), (24, 72)), (v2("rocket", 40), (56, 72)), (v2("rocket", 43), (88, 72))]).save(FIRST / "chuan.png")


ANIM = {
    # 名字: (动作, 帧数, 循环)
    "flame": ("the small flame flickers and sways gently left and right", 6, True),
    "seagull": ("the seagull flaps its wings down and up while flying", 4, True),
    "burn": ("the fire suddenly flares up much higher, then breaks apart into many flying orange sparks and embers that drift up and fade", 8, False),
    "douse": ("the water drop falls down onto the fire, the fire goes out and turns into a puff of grey smoke, small water droplets splash out", 6, False),
    "finish": ("the golden star bursts open into many small golden sparkles and colorful confetti pieces flying outward", 8, False),
    "chuan": ("the three firework rockets shoot up into the night sky one after another and each explodes into a big round sparkling firework burst, blue, red and gold", 10, False),
}
SEEDS = (3101, 3102, 3103)


def one(job) -> None:
    name, seed = job
    action, n, loop = ANIM[name]
    folder = OUT / "anim" / f"{name}-{seed}"
    if folder.exists() and any(folder.glob("*.png")):
        return
    first = pixellab.b64_image(FIRST / f"{name}.png")
    body = {"first_frame": first, "action": action, "frame_count": n, "no_background": True, "seed": seed}
    if loop:
        body["last_frame"] = first
    try:
        pixellab.animate(f"{name}-{seed}", body, folder)
        print(name, seed, "ok", flush=True)
    except Exception as error:
        print(name, seed, "失败：", error, flush=True)


COVER_STYLE = ("cozy 16-bit pixel art game cover illustration, rich warm colors, soft lighting, crisp clean pixels, "
               "no text, no letters, no logo, no numbers, no people, no faces, no flags")
COVERS = {
    "cover-terrace2": ("a seaside stone terrace at night in an old coastal city with red tile roofs and warm lit windows, a small wooden "
                       "card table in the middle of the terrace with a few stacks of playing cards lying face down showing plain red "
                       "backs and two glasses of beer, a stone railing with warm glowing lamps, a long stone pier with warm lamps "
                       "stretching into the calm dark blue sea toward a small octagonal pavilion, a string of warm bulbs overhead, "
                       "crescent moon, " + COVER_STYLE, (817, 818)),
}


def cover(job) -> None:
    name, seed = job
    target = f"{name}-s{seed}"
    if (OUT / "covers" / f"{target}.png").exists():
        return
    try:
        pixellab.generate_image(target, {"description": COVERS[name][0], "image_size": {"width": 384, "height": 192},
                                         "no_background": False, "seed": seed}, OUT / "covers")
        print(target, "ok", flush=True)
    except Exception as error:
        print(target, "失败：", error, flush=True)


if __name__ == "__main__":
    make_first_frames()
    names = sys.argv[1:] or (list(ANIM) + list(COVERS))
    jobs = [("a", (n, s)) for n in names if n in ANIM for s in SEEDS] + \
           [("c", (n, s)) for n in names if n in COVERS for s in COVERS[n][1]]
    with ThreadPoolExecutor(max_workers=int(os.environ.get("R2_WORKERS", "10"))) as pool:
        list(pool.map(lambda j: one(j[1]) if j[0] == "a" else cover(j[1]), jobs))
    print("全部跑完", flush=True)
