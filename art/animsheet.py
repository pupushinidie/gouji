"""动画候选总览：art/out/r2/anim/<名字>-<种子>/ 的每一帧按倍数横排（夜间底一行、白天底一行），每个种子一组，
再跑 finalize.check_frames 把数字标在旁边。用法：python art/animsheet.py <名字> [倍数]"""
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

import finalize

ART = Path(__file__).resolve().parent
ANIM = ART / "out" / "r2" / "anim"
NIGHT, DAY = (22, 32, 46, 255), (236, 230, 216, 255)
LOOP = {"flame": True, "seagull": True, "seagull2": True, "seagull3": True}


def load(folder: Path) -> list[Image.Image]:
    ps = sorted(folder.glob("*.png"), key=lambda p: int(re.findall(r"(\d+)$", p.stem)[0]))
    return [Image.open(p).convert("RGBA") for p in ps]


if __name__ == "__main__":
    name = sys.argv[1]
    k = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    groups = []
    for folder in sorted(ANIM.glob(f"{name}-*")):
        fr = load(folder)
        if not fr:
            continue
        loop = LOOP.get(name, False)
        use = fr[:-1] if loop and len(fr) > 2 else fr
        flags, note = finalize.check_frames(use, loop)
        w, h = fr[0].width * k, fr[0].height * k
        img = Image.new("RGBA", (len(fr) * (w + 4) + 4, 2 * h + 30), (60, 60, 60, 255))
        for i, f in enumerate(fr):
            for j, bg in enumerate((NIGHT, DAY)):
                t = Image.new("RGBA", (w, h), bg)
                t.alpha_composite(f.resize((w, h), Image.NEAREST))
                img.paste(t, (4 + i * (w + 4), 4 + j * h))
        ImageDraw.Draw(img).text((4, 2 * h + 10), f"{folder.name}: {note} {' '.join(flags) or 'ok'}", fill=(255, 230, 0))
        groups.append(img)
    W = max(g.width for g in groups)
    out = Image.new("RGBA", (W, sum(g.height for g in groups)), (40, 40, 40, 255))
    y = 0
    for g in groups:
        out.paste(g, (0, y))
        y += g.height
    out.save(ART / "out" / "sheets" / f"anim-{name}.png")
    print("ok", len(groups))
