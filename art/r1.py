"""够级 正式美术第一轮候选（PixelLab）。结果在 art/out/r1/（被 gitignore，不进仓库）。

照 art/spec.md「青岛海边露台」：
- 场景 /create-image-pixen 512×288：夜、日同一组种子、同一段构图描述，只换光照；去掉样张里的圆桌，下半部是空石板露台。
- 封面 /create-image-pixflux 384×192（大厅 covers.py 的 STYLE），不画人、不画字和数字。
- 「够级！」底下的爆炸形 pixflux 96×40（字由代码画）。
- 小图（≤42px）/generate-image-v2 一次 64 个：6 个头像动物、两队徽记、7 个状态图标、火苗、大火、水滴、金星、海鸥、烟花火箭。
用法：~/miniconda3/envs/quant/bin/python art/r1.py [名字 ...]   不写就全跑；出过的跳过，中断后重跑接着出。
会员（2026-10-10）：一个进程里线程池并发（≤10），pxqueue 按进程占位；不要开多个出图进程。
"""
from __future__ import annotations

import os
import sys
from concurrent.futures import ThreadPoolExecutor

import pixellab

OUT = pixellab.ART / "out" / "r1"
NO = "no text, no letters, no numbers, no writing"
NOPEOPLE = "no people, no characters, no faces, no animals on the floor, no flags, no signs, " + NO + ", pixel art, crisp pixels"

# ---------- 场景 ----------
SCENE_BASE = (
    "{time} on a wide empty seaside stone terrace in an old European-style Chinese coastal city, seen from a high "
    "three-quarter view looking out to sea, the whole lower half of the picture is an empty flat paved terrace floor of large "
    "stone slabs with low contrast and no objects on it, a stone balustrade railing runs across the middle with lamp posts on "
    "the railing pillars, beyond the railing old houses with red clay tile roofs on the left and right edges, a long stone pier "
    "stretching straight into the sea in the center, a small octagonal pavilion with a red tile roof at the end of the pier, "
    "{light}, no table, no chairs, no furniture, " + NOPEOPLE
)
NIGHT = SCENE_BASE.format(
    time="calm summer night",
    light="dark blue night sky with a crescent moon at the upper right, moonlight reflecting on gentle waves, warm orange glowing "
          "lamps on the railing and along the pier, warm lit windows, a string of warm light bulbs across the top, cool deep blue "
          "and teal palette with warm orange lamp accents",
)
DAY = SCENE_BASE.format(
    time="bright sunny summer afternoon",
    light="clear light blue sky with a few white clouds and two small seagulls, sunlight sparkling on turquoise waves, lamps "
          "unlit, a string of unlit bulbs across the top, pale beige stone floor, fresh light blue and turquoise palette with warm "
          "red roof tiles",
)
SCENE_SEEDS = (7101, 7201, 7202, 7203)
SCENES = {"scene-night": NIGHT, "scene-day": DAY}

# ---------- pixflux ----------
COVER_STYLE = ("cozy 16-bit pixel art game cover illustration, rich warm colors, soft lighting, crisp clean pixels, "
               "no text, no letters, no logo, no numbers, no people, no faces")
FLUX = {
    # 名字: (提示词, 宽, 高, 透明, 种子们)
    "cover-terrace": ("a seaside stone terrace at night in an old coastal city with red tile roofs, a small wooden card table on the "
                      "terrace with several stacks of playing cards lying face down showing red backs, two glasses of beer, a stone "
                      "railing with warm glowing lamps, a long pier with warm lamps stretching into the dark blue sea toward a small "
                      "octagonal pavilion, a string of warm bulbs overhead, crescent moon, " + COVER_STYLE, 384, 192, False, (811, 812)),
    "cover-cards": ("close view of a wooden table on a seaside terrace at night, four decks of playing cards fanned out face down "
                    "showing red and blue backs, a bowl of steamed clams, a glass of beer, warm lamp light, behind the stone railing "
                    "the dark blue sea with a lit pier and a small octagonal pavilion, " + COVER_STYLE, 384, 192, False, (813, 814)),
    "cover-day": ("a sunny afternoon on a seaside terrace in an old coastal city, red clay tile roofs, a small card table with playing "
                  "cards face down showing red backs, turquoise sea, white clouds, seagulls flying, a long stone pier leading to a "
                  "small octagonal pavilion with a red roof, " + COVER_STYLE, 384, 192, False, (815, 816)),
    "burst": ("a comic style explosion burst shape, wide horizontal jagged spiky star outline, bright orange yellow outer ring and "
              "red inner area, the middle is plain flat red empty space, flat colors, dark navy outline, pixel art game ui, " + NO,
              96, 40, True, (931, 932, 933)),
}

# ---------- v2（一次 64 个） ----------
AV = (", cute friendly round character, head and shoulders portrait facing the viewer, simple shapes, big readable silhouette, "
      "dark navy outline, soft light from the upper left, centered, pixel art game avatar, transparent background, " + NO)
ICON = (", tiny pixel art game icon, bold readable silhouette, 1px dark navy outline, lit from the upper left, centered, "
        "transparent background, " + NO)
SPRITE = ", pixel art game sprite, dark navy outline, centered, transparent background, " + NO
V2 = {
    # 名字: (提示词, 宽, 高)
    "av-seagull": ("a white seagull with grey wings and a yellow beak" + AV, 40, 40),
    "av-starfish": ("a smiling orange yellow starfish with five arms" + AV, 40, 40),
    "av-clam": ("a beige and brown striped clam shell slightly open with a tiny smiling face inside" + AV, 40, 40),
    "av-octopus": ("a purple octopus with curly tentacles" + AV, 40, 40),
    "av-turtle": ("a green sea turtle with a patterned shell" + AV, 40, 40),
    "av-seal": ("a grey brown harbor seal pup with whiskers" + AV, 40, 40),
    "team-a": ("a small heraldic shield badge filled with ocean blue, two white wavy wave lines across it" + ICON, 24, 24),
    "team-b": ("a small heraldic shield badge filled with brick red, a white triangle house roof with a small door on it" + ICON, 24, 24),
    "st-gouji": ("three playing cards fanned out with plain card faces and a small golden star in the corner" + ICON, 24, 24),
    "st-shao": ("a bright orange and yellow fire flame" + ICON, 24, 24),
    "st-jieshao": ("a blue water drop falling onto a small dim grey smoking flame" + ICON, 24, 24),
    "st-rang": ("an open raised hand palm, skin color" + ICON, 24, 24),
    "st-jiefeng": ("three curved white and light blue wind gust swirl lines blowing to the right" + ICON, 24, 24),
    "st-geming": ("a single playing card with a golden circular loop arrow around it" + ICON, 24, 24),
    "st-kanggong": ("a silver metal knight shield with a rim" + ICON, 24, 24),
    "flame": ("a single small bright orange and yellow flame tongue, like a candle flame without the candle" + SPRITE, 16, 24),
    "fire-big": ("a tall roaring bonfire flame without wood, orange yellow and red tongues of fire" + SPRITE, 32, 40),
    "drop": ("a single light blue water droplet" + SPRITE, 16, 16),
    "star": ("a shiny golden five pointed star with a small sparkle" + SPRITE, 24, 24),
    "seagull": ("a white seagull flying, side view facing right, wings spread up, grey wing tips, yellow beak" + SPRITE, 24, 16),
    "rocket": ("a small firework rocket flying straight up with a short sparkling trail below it" + SPRITE, 16, 24),
}

ORDER = ["scene-night", "scene-day"] + list(FLUX) + list(V2)


def run(name: str) -> None:
    if name in SCENES:
        for seed in SCENE_SEEDS:
            target = f"{name}-s{seed}"
            if (OUT / "scenes" / f"{target}.png").exists():
                continue
            pixellab.generate_image(target, {
                "description": SCENES[name], "image_size": {"width": 512, "height": 288},
                "detail": "highly detailed", "seed": seed,
            }, OUT / "scenes", endpoint="/create-image-pixen")
            print(target, "ok", flush=True)
    elif name in FLUX:
        prompt, w, h, transparent, seeds = FLUX[name]
        folder = OUT / ("covers" if name.startswith("cover") else "flux")
        for seed in seeds:
            target = f"{name}-s{seed}"
            if (folder / f"{target}.png").exists():
                continue
            body = {"description": prompt, "image_size": {"width": w, "height": h}, "detail": "highly detailed", "seed": seed}
            if transparent:
                body |= {"no_background": True, "outline": "single color black outline"}
            pixellab.generate_image(target, body, folder)
            print(target, "ok", flush=True)
    elif name in V2:
        prompt, w, h = V2[name]
        folder = OUT / "v2" / name
        if folder.exists() and any(folder.glob("*.png")):
            return
        paths = pixellab.generate_async(name, {
            "description": prompt, "image_size": {"width": w, "height": h}, "no_background": True, "seed": 2101,
        }, folder, endpoint="/generate-image-v2")
        print(name, len(paths), "张", flush=True)
    else:
        raise KeyError(name)


def jobs(names):
    """场景按种子拆开，好让线程池并发。"""
    out = []
    for n in names:
        if n in SCENES:
            out += [(n, s) for s in SCENE_SEEDS]
        else:
            out.append((n, None))
    return out


def one(job):
    name, seed = job
    try:
        if seed is not None:
            target = f"{name}-s{seed}"
            if (OUT / "scenes" / f"{target}.png").exists():
                return
            pixellab.generate_image(target, {
                "description": SCENES[name], "image_size": {"width": 512, "height": 288},
                "detail": "highly detailed", "seed": seed,
            }, OUT / "scenes", endpoint="/create-image-pixen")
            print(target, "ok", flush=True)
        else:
            run(name)
    except Exception as error:  # 一样失败不挡后面的
        print(name, seed or "", "失败：", error, flush=True)


if __name__ == "__main__":
    names = sys.argv[1:] or ORDER
    try:
        print("余额", pixellab.balance(), flush=True)
    except Exception as error:
        print("查余额失败：", error, flush=True)
    with ThreadPoolExecutor(max_workers=int(os.environ.get("R1_WORKERS", "10"))) as pool:
        list(pool.map(one, jobs(names)))
    print("全部跑完; spent", round(pixellab.spent_usd(), 4), flush=True)
