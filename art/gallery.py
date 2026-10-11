"""够级美术画廊：把 final.py 里每样素材的候选按实际用法画成图（小图 2× 夜间底 + 白天底 + 1× 原大；动画做成 GIF），
写成不阻塞的拍板 JSON：~/projects/pipeline/games/gouji/assets/gallery-decision.json（由制作人发布，不要自己 gpipe ask）。

用法：python art/gallery.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

sys.argv = sys.argv[:1]
import final as F  # noqa: E402

ART = Path(__file__).resolve().parent
GAL = ART / "out" / "gallery"
DEST = Path.home() / "projects" / "pipeline" / "games" / "gouji" / "assets" / "gallery-decision.json"
NIGHT, DAY = (22, 32, 46, 255), (236, 230, 216, 255)

# 动画：(帧数, 每帧毫秒, 循环, 放大倍数)
ANIMS = {"fx/gouji.png": (6, 80, False, 3), "fx/flame.png": (6, 100, True, 6), "fx/burn.png": (8, 90, False, 3),
         "fx/douse.png": (6, 90, False, 3), "fx/finish.png": (8, 80, False, 3), "fx/chuan.png": (10, 100, False, 2),
         "deco/seagull.png": (4, 150, True, 6)}

QUESTIONS = {
    "scene-night.png": "夜间牌桌背景（scene-night.png，512×288，铺满 3×/4×）",
    "scene-day.png": "白天牌桌背景（scene-day.png，512×288，构图要和夜间版对得上）",
    "team/*": "两队徽记（team/a.png 甲联邦海浪、team/b.png 乙联邦屋顶，24×24）",
    "avatar/0.png": "头像 0：海鸥（40×40，套在头像框里）",
    "avatar/1.png": "头像 1：海星",
    "avatar/2.png": "头像 2：蛤蜊",
    "avatar/3.png": "头像 3：章鱼",
    "avatar/4.png": "头像 4：海龟",
    "avatar/5.png": "头像 5：海豹",
    "status/shao*": "状态图标：烧牌中 / 烧牌成功（status/shao.png、shao-ok.png，24×24）",
    "status/jieshao.png": "状态图标：解烧",
    "status/jiefeng.png": "状态图标：接风",
    "status/geming.png": "状态图标：革命",
    "status/kanggong.png": "状态图标：抗贡",
    "status/gouji.png": "状态图标：够级牌",
    "status/rang.png": "状态图标：让牌",
    "fx/gouji.png": "「够级！」提示（fx/gouji.png，96×40×6 帧，播一次）",
    "fx/flame.png": "烧牌按钮旁的小火苗（fx/flame.png，16×24×6 帧，循环）",
    "fx/burn.png": "烧牌成功特效（fx/burn.png，64×64×8 帧，播一次）",
    "fx/douse.png": "解烧特效（fx/douse.png，64×64×6 帧，播一次）",
    "fx/finish.png": "走科特效（fx/finish.png，64×64×8 帧，播一次）",
    "fx/chuan.png": "串三户烟花（fx/chuan.png，128×96×10 帧，播一次）",
    "deco/seagull.png": "首页 / 等候房间的小海鸥（deco/seagull.png，24×16×4 帧，循环）",
}


def tiles(imgs: list[Image.Image], k: int = 2) -> Image.Image:
    """每张图：夜间底 k 倍、白天底 k 倍、夜间底 1 倍，横排；多张（徽记一对）竖排。"""
    rows = []
    for im in imgs:
        w, h = im.width * k, im.height * k
        row = Image.new("RGBA", (2 * w + im.width + 40, h + 16), (60, 60, 60, 255))
        for j, bg in enumerate((NIGHT, DAY)):
            t = Image.new("RGBA", (w + 8, h + 8), bg)
            t.alpha_composite(im.resize((w, h), Image.NEAREST), (4, 4))
            row.paste(t, (4 + j * (w + 12), 4))
        t = Image.new("RGBA", (im.width + 8, im.height + 8), NIGHT)
        t.alpha_composite(im, (4, 4))
        row.paste(t, (2 * w + 28, 4))
        rows.append(row)
    out = Image.new("RGBA", (max(r.width for r in rows), sum(r.height for r in rows)), (60, 60, 60, 255))
    y = 0
    for r in rows:
        out.paste(r, (0, y))
        y += r.height
    return out


def gif(strip: Image.Image, n: int, ms: int, loop: bool, k: int, path: Path) -> None:
    w = strip.width // n
    frames = []
    for i in range(n):
        f = strip.crop((i * w, 0, (i + 1) * w, strip.height)).resize((w * k, strip.height * k), Image.NEAREST)
        c = Image.new("RGBA", (2 * f.width + 12, f.height + 8), (60, 60, 60, 255))
        for j, bg in enumerate((NIGHT, DAY)):
            t = Image.new("RGBA", (f.width, f.height), bg)
            t.alpha_composite(f)
            c.paste(t, (4 + j * (f.width + 4), 4))
        frames.append(c.convert("RGB"))
    durations = [ms] * n
    if not loop:
        durations[-1] = 1200  # 播一次的停在最后一帧，GIF 里停 1.2 秒再重播，方便看
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=durations, loop=0, disposal=1)


def main() -> None:
    F._fill_seagull()
    GAL.mkdir(parents=True, exist_ok=True)
    questions = []
    for rel, cands in F.CANDS.items():
        opts = []
        for cid, build, why, rec in cands:
            out = build()
            stem = rel.replace("/", "-").replace("*", "").replace(".png", "") + "-" + cid
            if rel.startswith("scene"):
                path = GAL / f"{stem}.png"
                out.resize((1024, 576), Image.NEAREST).save(path)
            elif rel in ANIMS:
                n, ms, loop, k = ANIMS[rel]
                path = GAL / f"{stem}.gif"
                gif(out, n, ms, loop, k, path)
            elif isinstance(out, tuple):
                path = GAL / f"{stem}.png"
                tiles(list(out), 4).save(path)
            elif rel.startswith("avatar"):
                path = GAL / f"{stem}.png"
                tiles([F.P.in_frame(out)], 3).save(path)
            else:
                path = GAL / f"{stem}.png"
                tiles([out], 4).save(path)
            opt = {"value": cid, "label": cid, "images": [str(path)], "description": why}
            if rec:
                opt["recommended"] = True
            opts.append(opt)
        questions.append({"id": rel.replace("/", "-").replace("*", "").replace(".png", "").rstrip("-"), "type": "choice",
                          "question": QUESTIONS[rel], "options": opts, "required": False})
    # 封面
    copts = []
    for cid, _src, why, rec in F.COVERS:
        path = ART / "out" / "covers" / f"cover-{cid}.png"
        big = GAL / f"cover-{cid}.png"
        im = Image.open(path)
        im.resize((im.width * 2, im.height * 2), Image.NEAREST).save(big)
        opt = {"value": cid, "label": cid, "images": [str(big)], "description": why + f"（{im.width}×{im.height}，上下黑边已裁）"}
        if rec:
            opt["recommended"] = True
        copts.append(opt)
    questions.append({"id": "cover", "type": "choice", "question": "大厅封面（384 宽，不画字、不画人）", "options": copts, "required": False})
    data = {
        "id": "art-gallery",
        "title": "够级：美术画廊（可随时换图）",
        "stage": "art",
        "blocking": False,
        "intro": ("够级正式美术（PixelLab，开工选的「青岛海边露台」）。每样我已经挑定一张（标「推荐」）并导出成定稿；"
                  "你想换哪张随时选，不选就按推荐。小图每张左边是夜间底 / 白天底放大，右边是原大；动画是 GIF，左夜右日。\n\n"
                  "整体效果示意（不是界面，只看配色和大小）：`~/projects/gouji/art/out/preview-final/table-night-1440.png`、"
                  "`table-day-1440.png`。座位框、名牌、名次徽章、对头标记、进贡箭头、结算横幅、网页图标、无头和四人乱缠两个图标"
                  "是代码画的（字要准），不在这里选。"),
        "questions": questions,
    }
    DEST.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    print("写好", DEST, len(questions), "题")


if __name__ == "__main__":
    main()
