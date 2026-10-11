"""够级 正式美术第三轮：
- 第一轮的海鸥头像整张是不透明白底（身体和底色连成一片，抠不干净），换个说法重出（结果也放 art/out/r1/v2/，和其他头像一起挑）。
- 第二轮的海鸥扇翅动作太小（翅膀一直朝上），换个动作词、海鸥放高一点留出翅膀往下扇的空间，再出 3 个种子。
用法：python art/r3.py
"""
from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor

import r1
import r2

r1.V2.update({
    "av-seagull2": ("a small round white seagull with grey wings and a yellow beak, head and upper body, the bird does not touch "
                    "the edges of the image, empty transparent space around it" + r1.AV, 40, 40),
    "av-seagull3": ("a small round white seagull with grey wings and a yellow beak wearing a tiny white sailor cap, head and upper "
                    "body, the bird does not touch the edges of the image, empty transparent space around it" + r1.AV, 40, 40),
})
r2.ANIM["seagull2"] = ("the seagull flaps its wings in a full stroke: the wings sweep all the way down below its body, then rise back up", 4, True)
r2.ANIM["seagull3"] = ("flying bird wing flap cycle, wings up, wings level, wings down, wings level", 4, True)


def first_frames():
    r2.canvas(32, 32, [(r2.v2("seagull", 0), (4, 4))]).save(r2.FIRST / "seagull2.png")
    r2.canvas(32, 32, [(r2.v2("seagull", 0), (4, 4))]).save(r2.FIRST / "seagull3.png")


def job(j):
    kind, arg = j
    if kind == "v2":
        r1.one((arg, None))
    else:
        r2.one(arg)


if __name__ == "__main__":
    first_frames()
    jobs = [("v2", "av-seagull2"), ("v2", "av-seagull3")] + \
           [("a", ("seagull2", s)) for s in (3104, 3105)] + [("a", ("seagull3", s)) for s in (3106, 3107)]
    with ThreadPoolExecutor(max_workers=int(os.environ.get("R3_WORKERS", "10"))) as pool:
        list(pool.map(job, jobs))
    print("全部跑完", flush=True)
