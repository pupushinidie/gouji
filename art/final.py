"""够级 正式美术定稿导出：按 art/spec.md 的文件名、尺寸、帧数，把挑定的候选导出到 art/out/final/（目录结构和 public/art/ 一样）。

- 每样素材的候选都写在 CANDS 里（构造函数 + 说明），第一个标 rec 的是我挑定的；art/selection.json 由本脚本写出，
  他在画廊里改选时，把 selection.json 里那一项的 pick 改成别的候选 id，再跑一遍就行。
- 只用代码画的（座位框、名牌、名次徽章、对头标记和虚线框、进贡箭头、拖尾、结算横幅、网页图标、无头、四人乱缠）直接调 simple.py。
- 不碰 apps/web/public/art/（换图由开发 agent 做）。

用法（仓库根目录）：
    ~/miniconda3/envs/quant/bin/python art/final.py            # 导出全部到 art/out/final/，写 art/selection.json，封面写 art/out/covers/
    ~/miniconda3/envs/quant/bin/python art/simple.py --check --dir art/out/final
    ~/miniconda3/envs/quant/bin/python art/finalize.py report
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.argv = sys.argv[:1]
import simple as S  # noqa: E402
import pick as P  # noqa: E402

ART = Path(__file__).resolve().parent
OUT = ART / "out"
FINAL = OUT / "final"
R1, R2 = OUT / "r1", OUT / "r2"
CLEAR = (0, 0, 0, 0)


# ---------------- 通用小工具 ----------------

def v2(name: str, k: int) -> Image.Image:
    return P.v2(name, k)


def center24(img: Image.Image, size=(24, 24), dx: int = 0, dy: int = 0) -> Image.Image:
    """透明图裁掉四周空白，再放回 24×24 正中（v2 图标常常偏一点）。"""
    t = S.crop_alpha(img)
    out = Image.new("RGBA", size, CLEAR)
    out.alpha_composite(t, ((size[0] - t.width) // 2 + dx, (size[1] - t.height) // 2 + dy))
    return out


def anim(name: str, seed: int) -> list[Image.Image]:
    folder = R2 / "anim" / f"{name}-{seed}"
    ps = sorted(folder.glob("*.png"), key=lambda p: int(re.findall(r"(\d+)$", p.stem)[0]))
    return [Image.open(p).convert("RGBA") for p in ps]


def drop_specks(img: Image.Image, min_px: int = 6) -> Image.Image:
    """去掉和主体不连通、小于 min_px 像素的零星色块（火苗动画上方飘的几粒深色描边点，看着像脏点）。"""
    a = img.split()[3]
    w, h = img.size
    px = a.load()
    seen = [[False] * w for _ in range(h)]
    out = img.copy()
    op = out.load()
    for y in range(h):
        for x in range(w):
            if seen[y][x] or px[x, y] == 0:
                continue
            comp, stack = [], [(x, y)]
            seen[y][x] = True
            while stack:
                cx, cy = stack.pop()
                comp.append((cx, cy))
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and px[nx, ny] > 0:
                        seen[ny][nx] = True
                        stack.append((nx, ny))
            if len(comp) < min_px:
                for cx, cy in comp:
                    op[cx, cy] = CLEAR
    return out


def crop_frames(frames: list[Image.Image], w: int, h: int, anchor: str = "bottom") -> list[Image.Image]:
    """所有帧用同一个裁切框：按全部帧的并集定位（bottom = 底边对齐并集底边、水平居中；center = 并集居中）。"""
    boxes = [f.getbbox() for f in frames if f.getbbox()]
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    x1, y1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
    cx = (x0 + x1) // 2
    left = cx - w // 2
    top = (y1 - h) if anchor == "bottom" else ((y0 + y1) // 2 - h // 2)
    if (x1 - x0) > w or (y1 - y0) > h:
        print(f"    注意：动画并集 {x1 - x0}×{y1 - y0} 超过 {w}×{h}，边上会被裁掉一点")
    return [f.crop((left, top, left + w, top + h)) for f in frames]


def scene(theme: str, seed: int) -> Image.Image:
    return Image.open(R1 / "scenes" / f"scene-{theme}-s{seed}.png").convert("RGB")


def check_mark(img: Image.Image) -> Image.Image:
    """烧牌成功：在火焰右下压一个白边绿对勾（和简洁版同一个画法，色盲靠形状认）。"""
    ink = Image.new("RGBA", img.size, CLEAR)
    dd = ImageDraw.Draw(ink)
    dd.line([(13, 16), (16, 19), (22, 11)], fill=S.hx("#ffffff"), width=3)
    ring = S.outline(ink)
    base = img.copy()
    base.alpha_composite(ring)
    d2 = ImageDraw.Draw(base)
    d2.line([(13, 16), (16, 19), (22, 11)], fill=S.hx("#ffffff"), width=3)
    d2.line([(14, 16), (16, 18), (21, 12)], fill=S.hx("#3aa860"), width=1)
    return base


def code_icon(name: str) -> Image.Image:
    return S.status_icons()[name]


# ---------------- 动画 ----------------

def fx_flame(seed: int) -> Image.Image:
    fr = anim("flame", seed)[:6]  # first=last 时返回 7 帧，第 7 帧和第 1 帧一样，去掉
    fr = [drop_specks(f) for f in fr]
    return S.strip(crop_frames(fr, 16, 24))


def fx_seagull(name: str, seed: int) -> Image.Image:
    fr = anim(name, seed)[:4]
    fr = [drop_specks(f, 3) for f in fr]
    return S.strip(crop_frames(fr, 24, 16, anchor="center"))


def warm_specks(img: Image.Image, color: str, max_px: int = 8) -> Image.Image:
    """炸开后飘散的小碎点常是描边色（深蓝黑），白天底上像脏点：把不超过 max_px 的孤立深色碎块换成暖色。"""
    w, h = img.size
    px = img.load()
    out = img.copy()
    op = out.load()
    seen = set()
    rgb = S.hx(color)
    for y in range(h):
        for x in range(w):
            if (x, y) in seen or px[x, y][3] == 0:
                continue
            comp, stack = [], [(x, y)]
            seen.add((x, y))
            while stack:
                cx, cy = stack.pop()
                comp.append((cx, cy))
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen and px[nx, ny][3] > 0:
                        seen.add((nx, ny))
                        stack.append((nx, ny))
            if len(comp) <= max_px:
                for cx, cy in comp:
                    r, g, b, a = px[cx, cy]
                    if r + g + b < 150:
                        op[cx, cy] = rgb
    return out


SPECK_COLOR = {"burn": "#b8641f", "finish": "#a8761f"}


def fx_once(name: str, seed: int, n: int) -> Image.Image:
    fr = anim(name, seed)[1:1 + n]  # 第 0 帧是送进去的首帧（静止），从第 1 帧起播
    if name in SPECK_COLOR:
        fr = [warm_specks(f, SPECK_COLOR[name]) for f in fr]
    return S.strip(fr)


# ---------------- 候选表 ----------------
# 相对 public/art 的路径: [(候选 id, 构造函数, 一句话说明, 是否挑定)]
CANDS: dict[str, list[tuple[str, object, str, bool]]] = {
    "scene-night.png": [
        ("pixen-s7201", lambda: scene("night", 7201), "两边红瓦老房、正中栈桥通到八角亭，灯串和月亮在上方，和白天 s7201 构图几乎一样（换主题不跳）", True),
        ("pixen-s7101", lambda: scene("night", 7101), "构图最开阔，地面石板多；但和任何一张白天图都配不成对", False),
        ("pixen-s7202", lambda: scene("night", 7202), "暖色灯光地面很漂亮；左下角有个小花盆和矮墙，底部略杂", False),
    ],
    "scene-day.png": [
        ("pixen-s7201", lambda: scene("day", 7201), "和夜间 s7201 同一个构图：两边老房、正中栈桥和亭子，太阳在上方，地面米色石板干净", True),
        ("pixen-s7202", lambda: scene("day", 7202), "灯柱、亭子都好看；右边多了一道拱门，和夜间图对不上", False),
        ("pixen-s7101", lambda: scene("day", 7101), "带柱廊的阳台，很有度假感；但和夜间版构图差别大", False),
    ],
    "team/*": [
        ("code", lambda: (S.emblem("A"), S.emblem("B")), "代码画的盾牌：撑满 24px、颜色正好是 spec 的海蓝 / 瓦红，浪和屋顶形状差别大，1× 也认得出", True),
        ("v2-16-10", lambda: (center24(v2("team-a", 16)), center24(v2("team-b", 10))), "PixelLab 盾牌，质感好，但图案只占 16px，1× 时浪纹像三条横线", False),
        ("v2-25-35", lambda: (center24(v2("team-a", 25)), center24(v2("team-b", 35))), "PixelLab 另一组，同样偏小", False),
    ],
    "avatar/0.png": [
        ("v2-seagull2-?", None, "", False),  # 由 r3 结果填（见下面 _seagull_avatars）
    ],
    "avatar/1.png": [
        ("v2-0", lambda: P.avatar_compose(v2("av-starfish", 0)), "笑脸海星，五个角清楚，1× 也一眼认出", True),
        ("v2-29", lambda: P.avatar_compose(v2("av-starfish", 29)), "表情更憨", False),
        ("v2-18", lambda: P.avatar_compose(v2("av-starfish", 18)), "眯眼笑", False),
    ],
    "avatar/2.png": [
        ("v2-25", lambda: P.avatar_compose(v2("av-clam", 25)), "壳顶浅、条纹清楚，小脸在壳里，1× 也像蛤蜊", True),
        ("v2-19", lambda: P.avatar_compose(v2("av-clam", 19)), "壳更扁", False),
        ("v2-21", lambda: P.avatar_compose(v2("av-clam", 21)), "壳张得更开", False),
    ],
    "avatar/3.png": [
        ("v2-5", lambda: P.avatar_compose(v2("av-octopus", 5)), "紫色章鱼，触手卷得整齐，脸清楚", True),
        ("v2-32", lambda: P.avatar_compose(v2("av-octopus", 32)), "颜色更饱和", False),
        ("v2-12", lambda: P.avatar_compose(v2("av-octopus", 12)), "偏玫红，和乙联邦瓦红有点近", False),
    ],
    "avatar/4.png": [
        ("v2-0", lambda: P.avatar_compose(v2("av-turtle", 0)), "亮绿海龟，大眼睛，在深色底上最醒目", True),
        ("v2-16", lambda: P.avatar_compose(v2("av-turtle", 16)), "深绿带斑点", False),
        ("v2-33", lambda: P.avatar_compose(v2("av-turtle", 33)), "青绿色，和海蓝底有点混", False),
    ],
    "avatar/5.png": [
        ("v2-16", lambda: P.avatar_compose(v2("av-seal", 16)), "灰褐海豹，胡须和白肚皮清楚", True),
        ("v2-48", lambda: P.avatar_compose(v2("av-seal", 48)), "颜色更暖", False),
        ("v2-2", lambda: P.avatar_compose(v2("av-seal", 2)), "张嘴笑，偏暗", False),
    ],
    "status/shao*": [
        ("v2-26", lambda: (center24(v2("st-shao", 26)), check_mark(center24(v2("st-shao", 26), dx=-3))),
         "PixelLab 火焰，三层火舌有动感；烧牌成功在同一个火焰上压白边绿对勾", True),
        ("code", lambda: (code_icon("shao"), code_icon("shao-ok")), "代码画的火焰，撑满 24px 但形状比较平", False),
        ("v2-9", lambda: (center24(v2("st-shao", 9)), check_mark(center24(v2("st-shao", 9), dx=-3))), "另一个 PixelLab 火焰，更圆", False),
    ],
    "status/jieshao.png": [
        ("code", lambda: code_icon("jieshao"), "代码画的大水滴压在暗火苗上，24px 撑满，1× 一眼看出是「水灭火」", True),
        ("v2-7", lambda: center24(v2("st-jieshao", 7)), "PixelLab 水滴 + 冒烟的火苗，好看但只有 12px 宽，1× 太小", False),
        ("v2-19", lambda: center24(v2("st-jieshao", 19)), "同上，水滴更蓝", False),
    ],
    "status/jiefeng.png": [
        ("v2-0", lambda: center24(v2("st-jiefeng", 0)), "PixelLab 风团：三道卷起来的风线，一看就是「风」，比直线更有意思", True),
        ("code", lambda: code_icon("jiefeng"), "代码画的三道直线，容易看成「菜单」图标", False),
        ("v2-12", lambda: center24(v2("st-jiefeng", 12)), "风团更圆", False),
    ],
    "status/geming.png": [
        ("v2-3", lambda: center24(v2("st-geming", 3)), "PixelLab：一张牌外面一圈金色循环箭头，意思最直接，质感好", True),
        ("code", lambda: code_icon("geming"), "代码画的同一个意思，箭头较粗糙", False),
        ("v2-32", lambda: center24(v2("st-geming", 32)), "牌面是红心，和瓦红队色有点撞", False),
    ],
    "status/kanggong.png": [
        ("v2-7", lambda: center24(v2("st-kanggong", 7)), "PixelLab 银盾，有金属高光，没有十字（避开像红十字的图案）", True),
        ("code", lambda: code_icon("kanggong"), "代码画的平面银盾", False),
        ("v2-2", lambda: center24(v2("st-kanggong", 2)), "更窄更亮", False),
    ],
    "status/gouji.png": [
        ("code", lambda: code_icon("gouji"), "代码画的三张扇形牌 + 金星，「一手好几张大牌」的意思清楚", True),
        ("v2-37", lambda: center24(v2("st-gouji", 37)), "PixelLab 只画出一张牌 + 星，像「收藏」", False),
        ("v2-59", lambda: center24(v2("st-gouji", 59)), "同上", False),
    ],
    "status/rang.png": [
        ("code", lambda: code_icon("rang"), "代码画的举手 + 往右箭头（让后面的人先接），意思完整", True),
        ("v2-0", lambda: center24(v2("st-rang", 0)), "PixelLab 手掌更好看，但没有箭头，只像「停」", False),
        ("v2-48", lambda: center24(v2("st-rang", 48)), "同上", False),
    ],
    "fx/gouji.png": [
        ("pixflux-burst931", lambda: S.fx_gouji(P.burst(931)), "PixelLab 漫画爆炸形（颜色换成 spec 的灯橙 / 瓦红），字用 22px 粗体画，笔画清楚（修了遗留的 I1）", True),
        ("code", lambda: S.fx_gouji(None), "代码画的星形 + 红色字牌，同样是新的 22px 字", False),
    ],
    "fx/flame.png": [
        ("anim-3103", lambda: fx_flame(3103), "火苗左右摇、火舌一伸一缩，首末帧接得上；飘起来的几粒深色点已去掉", True),
        ("anim-3101", lambda: fx_flame(3101), "火苗往上窜得多，最高的两帧顶端被 16×24 裁掉一点", False),
        ("anim-3102", lambda: fx_flame(3102), "动作最小", False),
    ],
    "fx/burn.png": [
        ("anim-3101", lambda: fx_once("burn", 3101, 8), "火焰窜起、整团炸开成火星往上飘，最后剩一点小火，节奏最好", True),
        ("anim-3103", lambda: fx_once("burn", 3103, 8), "火舌卷成漩涡再散开，火星多，深色碎点也多", False),
        ("anim-3102", lambda: fx_once("burn", 3102, 8), "中间有一帧顶上冒出深色尖块，像坏帧", False),
    ],
    "fx/douse.png": [
        ("anim-3101", lambda: fx_once("douse", 3101, 6), "水滴落下、溅开水花、火变小冒灰烟，三步都看得清", True),
        ("anim-3102", lambda: fx_once("douse", 3102, 6), "水滴钻进火里冒高烟，水花不明显", False),
        ("anim-3103", lambda: fx_once("douse", 3103, 6), "水花一圈很好看，但火没变小", False),
    ],
    "fx/finish.png": [
        ("anim-3103", lambda: fx_once("finish", 3103, 8), "金星鼓起、炸成一圈金色碎片慢慢散开，最后一帧空白，播完直接撤掉", True),
        ("anim-3102", lambda: fx_once("finish", 3102, 8), "中间一帧有紫色描边框，略怪", False),
        ("anim-3101", lambda: fx_once("finish", 3101, 8), "炸开时中间是一块灰色，像破洞", False),
    ],
    "fx/chuan.png": [
        ("anim-3103", lambda: fx_once("chuan", 3103, 10), "三支火箭拖着尾焰升空，在上方炸成三朵烟花，夜间白天底上都清楚", True),
        ("anim-3102", lambda: fx_once("chuan", 3102, 10), "烟花炸得更大，但颜色偏灰褐", False),
        ("anim-3101", lambda: fx_once("chuan", 3101, 10), "火箭拖出很长的红线，像在流血", False),
    ],
    "deco/seagull.png": [
        ("anim-?", None, "", False),  # 由 r3 结果填（见下面 _seagull_anim）
    ],
}

# 只用代码画的（简洁版就是正式版，文件名尺寸不变）
CODE_ONLY = {
    "seat/frame-a.png": lambda: S.frame("A"), "seat/frame-b.png": lambda: S.frame("B"),
    "seat/plate-a.png": lambda: S.plate("A"), "seat/plate-b.png": lambda: S.plate("B"),
    "marks/duitou.png": S.duitou_mark, "fx/duitou-ring.png": S.duitou_ring,
    "fx/tribute-arrow.png": S.fx_tribute_arrow, "fx/trail.png": S.fx_trail,
    "deco/ribbon-a.png": lambda: S.ribbon("A"), "deco/ribbon-b.png": lambda: S.ribbon("B"),
    "icon.png": S.icon32,
    "status/wutou.png": lambda: code_icon("wutou"), "status/luanchan.png": lambda: code_icon("luanchan"),
    **{f"rank/{r[0]}.png": (lambda r=r: S.rank_badge(r)) for r in S.RANKS},
}

# 封面（不在 public/art 里；384×192，上下黑边裁掉）
COVERS = [
    ("pixflux-s818", R2 / "covers" / "cover-terrace2-s818.png", "夜里海边露台：小牌桌上扣着红背的牌和两杯啤酒，灯柱一路排到栈桥尽头的八角亭，月亮倒影，最有「青岛夏夜打够级」的味道", True),
    ("pixflux-s811", R1 / "covers" / "cover-terrace-s811.png", "灯串 + 弯月 + 亭子 + 小牌桌，画面最满；顶上原有一条黑边已裁掉", False),
    ("pixflux-s817", R2 / "covers" / "cover-terrace2-s817.png", "斜俯视的露台和栈桥，构图大气，牌桌偏左", False),
]


def _fill_seagull() -> None:
    """r3 出的海鸥头像和扇翅动画：按 SEAGULL_* 的挑选填进 CANDS。"""
    CANDS["avatar/0.png"] = [
        (f"v2-{n}-{k}", (lambda n=n, k=k: P.avatar_compose(v2(n, k))), why, i == 0) for i, (n, k, why) in enumerate(SEAGULL_AVATARS)
    ]
    CANDS["deco/seagull.png"] = [
        (f"anim-{n}-{s}", (lambda n=n, s=s: fx_seagull(n, s)), why, i == 0) for i, (n, s, why) in enumerate(SEAGULL_ANIMS)
    ]


SEAGULL_AVATARS: list[tuple[str, int, str]] = [
    ("av-seagull2", 2, "白海鸥、黄嘴，留出了底色，1× 也认得出；和其他五个一样不戴配饰"),
    ("av-seagull2", 12, "眼睛更圆"),
    ("av-seagull3", 34, "戴白水兵帽（青岛海军城的意思），有趣但和其他五个风格不齐"),
]
SEAGULL_ANIMS: list[tuple[str, int, str]] = [
    ("seagull2", 3105, "翅膀上→平→下→平一整拍，身体不跳，循环顺"),
    ("seagull2", 3104, "也是整拍，但第 3 帧嘴变黑、身体走形"),
    ("seagull", 3103, "翅膀一直朝上，只是轻轻抖，看着像滑翔"),
]


def crop_black(img: Image.Image) -> Image.Image:
    """裁掉上下（和左右）整行几乎全黑的边。"""
    rgb = img.convert("RGB")
    w, h = rgb.size

    def dark_row(y):
        # 整行同一个近黑色才算黑边（夜空本身也很暗，不能按亮度裁）
        px = {rgb.getpixel((x, y)) for x in range(w)}
        return len(px) <= 2 and all(max(p) < 24 for p in px)

    top = 0
    while top < h // 4 and dark_row(top):
        top += 1
    bot = h
    while bot > h * 3 // 4 and dark_row(bot - 1):
        bot -= 1
    return rgb.crop((0, top, w, bot))


def picks() -> dict[str, str]:
    sel_path = ART / "selection.json"
    chosen = {}
    if sel_path.exists():
        for rel, row in json.loads(sel_path.read_text()).get("items", {}).items():
            chosen[rel] = row.get("pick")
    return chosen


def export() -> None:
    _fill_seagull()
    S.PUB = FINAL
    S.TIER = "final"
    FINAL.mkdir(parents=True, exist_ok=True)
    chosen = picks()
    items = {}
    for rel, cands in CANDS.items():
        rec = next(c for c in cands if c[3])
        want = chosen.get(rel, rec[0])
        cid, build, why, _ = next((c for c in cands if c[0] == want), rec)
        out = build()
        if rel == "team/*":
            S.save(out[0], "team/a.png")
            S.save(out[1], "team/b.png")
        elif rel == "status/shao*":
            S.save(out[0], "status/shao.png")
            S.save(out[1], "status/shao-ok.png")
        else:
            S.save(out, rel)
        items[rel] = {"pick": cid, "recommended": rec[0], "reason": why,
                      "candidates": [{"id": c[0], "note": c[2]} for c in cands]}
    for rel, build in CODE_ONLY.items():
        S.save(build(), rel)
        items[rel] = {"pick": "code", "reason": "代码画（art/simple.py），简洁版就是正式版"}
    # 封面
    cdir = OUT / "covers"
    cdir.mkdir(parents=True, exist_ok=True)
    want = chosen.get("cover", next(c[0] for c in COVERS if c[3]))
    for cid, src, why, rec in COVERS:
        img = crop_black(Image.open(src))
        img.save(cdir / f"cover-{cid}.png")
        if cid == want:
            img.save(ART / "cover-final.png")
            print(f"  封面 {cid} → art/cover-final.png {img.width}×{img.height}")
    items["cover"] = {"pick": want, "recommended": next(c[0] for c in COVERS if c[3]),
                      "candidates": [{"id": c[0], "note": c[2], "file": f"art/out/covers/cover-{c[0]}.png"} for c in COVERS]}
    sel = {"note": "够级正式美术定稿（guluga-game-art 自查自选，2026-10-10）。改选：把某项的 pick 改成 candidates 里的 id，"
                   "再跑 python art/final.py；候选原图在 art/out/r1、r2（gitignore），出图脚本 art/r1.py–r3.py。",
           "items": items}
    (ART / "selection.json").write_text(json.dumps(sel, ensure_ascii=False, indent=1))
    print("写好", ART / "selection.json")


if __name__ == "__main__":
    export()
