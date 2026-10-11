"""动画检查（照印加宝藏 / 宝石商人的 finalize.py 改的）：art/out/final/ 下每条横排精灵图按 spec 的帧数切开，
算每帧和首帧比变了多少像素、有没有坏帧（某帧突变又变回）、循环的那几条首末帧接不接得上。

用法：python art/finalize.py report [目录]   默认 art/out/final
也给 final.py 挑动画候选用：check_frames(frames, loop) 返回 (问题列表, 说明)。
"""
from __future__ import annotations

import pathlib
import sys

from PIL import Image, ImageChops

ROOT = pathlib.Path(__file__).resolve().parent
# 相对路径: (帧数, 是否循环)
FX = {
    "fx/gouji.png": (6, False), "fx/flame.png": (6, True), "fx/burn.png": (8, False), "fx/douse.png": (6, False),
    "fx/finish.png": (8, False), "fx/chuan.png": (10, False), "fx/duitou-ring.png": (4, True),
    "fx/tribute-arrow.png": (4, True), "fx/trail.png": (4, True), "deco/seagull.png": (4, True),
}
# 代码画的「跑马灯」：四道箭头轮流亮，每帧本来就变一大半，不算走形（走形检查是给 PixelLab 动画用的）
CHASE = {"fx/tribute-arrow.png"}


def frames(path: pathlib.Path, n: int) -> list[Image.Image]:
    strip = Image.open(path).convert("RGBA")
    w = strip.width // n
    return [strip.crop((i * w, 0, (i + 1) * w, strip.height)) for i in range(n)]


def changed(a: Image.Image, b: Image.Image) -> float:
    diff = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > 24 else 0)
    return sum(1 for v in diff.get_flattened_data() if v) / (a.width * a.height)


def has_glitch_frame(fr) -> bool:
    """相邻帧变化里某一步特别大（≥15% 且 ≥ 中位数 2.5 倍），而前后两帧彼此很像 → 中间那帧是坏帧。"""
    steps = [changed(fr[i], fr[i + 1]) for i in range(len(fr) - 1)]
    med = sorted(steps)[len(steps) // 2]
    for i in range(1, len(fr) - 1):
        jump = min(steps[i - 1], steps[i])
        around = changed(fr[i - 1], fr[i + 1])
        if jump >= 0.15 and jump >= 2.5 * max(med, 0.01) and around < jump / 2:
            return True
    return False


def check_frames(fr: list[Image.Image], loop: bool, chase: bool = False) -> tuple[list[str], str]:
    n = len(fr)
    ch = [changed(fr[0], f) for f in fr[1:]]
    worst = max(ch)
    steps = [changed(fr[i], fr[i + 1]) for i in range(n - 1)]
    loop_gap = changed(fr[-1], fr[0])
    flags = []
    if loop and worst > 0.45 and not chase:
        flags.append("走形?")
    if worst < 0.03:
        flags.append("太静?")
    if has_glitch_frame(fr):
        flags.append("有坏帧")
    if loop and loop_gap > max(steps) * 1.5 + 0.01:
        flags.append("循环接不上")
    # 只有第 0 帧不一样、后面几乎不动 = 一次静态重绘，循环点会闪
    if n > 3 and max(steps[1:]) < 0.01 and steps[0] > 0.05:
        flags.append("静态重绘?")
    note = (f"{n} 帧，最大变化 {worst:5.1%}，相邻帧 {min(steps):.1%}–{max(steps):.1%}"
            + (f"，末帧→首帧 {loop_gap:.1%}" if loop else ""))
    return flags, note


def report(folder: pathlib.Path) -> int:
    bad = 0
    for rel, (n, loop) in FX.items():
        p = folder / rel
        if not p.exists():
            print(f"{rel}: 缺文件")
            bad += 1
            continue
        flags, note = check_frames(frames(p, n), loop, rel in CHASE)
        bad += bool(flags)
        print(f"{rel}: {note}" + (" " + " ".join(flags) if flags else " 通过"))
    return bad


if __name__ == "__main__":
    cmd, *rest = sys.argv[1:] or ["report"]
    folder = pathlib.Path(rest[0]) if rest else ROOT / "out" / "final"
    sys.exit(1 if report(folder) else 0)
