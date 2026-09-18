# -*- coding: utf-8 -*-
"""
make_demo.py —— 合成一只示例宠物（简单像素风团子），并端到端跑通整套脚本。

这是用来验证本包脚本能正常工作的自测 + 示例，不依赖任何外部图片。
运行后会在 example/ 下产出：
  frames-raw/  合成原始帧（256×256）
  frames/       fit.py 处理后的 192×208 标准帧
  spritesheet.png / .webp
  previews/     GIF + 动画 WebP
  out/demo-pet/ 完整交付包（含 petdex-package/demo-pet/ 可导入 AllPet）

用法：cd example && python3 make_demo.py
"""
import os
import sys
import math
import shutil
import subprocess

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.abspath(os.path.join(HERE, "..", "scripts"))
sys.path.insert(0, SCRIPTS)

import petformat as F  # noqa: E402

RAW = 256
BODY = (245, 166, 35)
BELLY = (255, 243, 214)
OUTLINE = (74, 59, 42)
EYE = (40, 30, 20)
BODY_BOX = (48, 40, 208, 232)  # 160x192


def canvas():
    return Image.new("RGBA", (RAW, RAW), (0, 0, 0, 0))


def body(d, dy=0, dx=0, lean=0):
    bx = list(BODY_BOX)
    bx[0] += dx; bx[2] += dx
    bx[1] += dy; bx[3] += dy
    d.ellipse(bx, fill=BODY, outline=OUTLINE, width=4)
    w = bx[2] - bx[0]; h = bx[3] - bx[1]
    d.ellipse((bx[0] + w * 0.32, bx[1] + h * 0.55, bx[0] + w * 0.68, bx[1] + h * 0.9),
              fill=BELLY)
    return bx


def eyes(d, bx, pupil=(0, 0), blink=False, cross=False):
    cx = (bx[0] + bx[2]) / 2
    ey = bx[1] + (bx[3] - bx[1]) * 0.35
    for ex in (cx - 24, cx + 24):
        if cross:
            d.line((ex - 6, ey - 6, ex + 6, ey + 6), fill=EYE, width=3)
            d.line((ex - 6, ey + 6, ex + 6, ey - 6), fill=EYE, width=3)
        elif blink:
            d.line((ex - 6, ey, ex + 6, ey), fill=EYE, width=3)
        else:
            d.ellipse((ex - 7, ey - 7, ex + 7, ey + 7), fill=EYE)
            d.ellipse((ex + pupil[0] - 3, ey + pupil[1] - 3, ex + pupil[0] + 3, ey + pupil[1] + 3),
                      fill=(255, 255, 255))


def mouth(d, bx, kind="smile"):
    cx = (bx[0] + bx[2]) / 2
    my = bx[1] + (bx[3] - bx[1]) * 0.48
    if kind == "smile":
        d.arc((cx - 10, my - 6, cx + 10, my + 6), 20, 160, fill=EYE, width=3)
    elif kind == "frown":
        d.arc((cx - 10, my + 4, cx + 10, my + 16), 200, 340, fill=EYE, width=3)
    elif kind == "o":
        d.ellipse((cx - 5, my - 5, cx + 5, my + 5), fill=EYE)


def render(state, f):
    im = canvas()
    d = ImageDraw.Draw(im)

    if state == "idle":
        dy = int(2 * math.sin(2 * math.pi * f / 6))
        bx = body(d, dy=dy)
        eyes(d, bx, blink=(f % 3 == 2))
        mouth(d, bx)

    elif state == "running-right":
        dy = int(2 * math.sin(2 * math.pi * f / 8))
        bx = body(d, dy=dy, dx=4)
        eyes(d, bx, pupil=(4, 0))
        mouth(d, bx, kind="o")
        # 两条腿交替
        leg_y = bx[3] - 10
        for i in range(2):
            off = (f + i) % 2 * 10
            d.rounded_rectangle((bx[0] + 30 + i * 60 + (6 if off else 0), leg_y,
                                 bx[0] + 46 + i * 60 + (6 if off else 0), leg_y + 22),
                                radius=6, fill=BODY, outline=OUTLINE, width=3)

    elif state == "running-left":
        im = render("running-right", f).transpose(Image.FLIP_LEFT_RIGHT)
        return im

    elif state == "waving":
        bx = body(d)
        eyes(d, bx)
        mouth(d, bx, kind="smile")
        arm_ang = math.sin(2 * math.pi * f / 4) * 40
        ax = bx[2] - 8
        ay = bx[1] + 30
        tipx = ax + int(30 * math.sin(math.radians(arm_ang)))
        tipy = ay - int(34 * math.cos(math.radians(arm_ang)))
        d.line((ax, ay, tipx, tipy), fill=BODY, width=12)
        d.line((ax, ay, tipx, tipy), fill=OUTLINE, width=3)

    elif state == "jumping":
        arc = [0, -34, -52, -34, 0]
        bx = body(d, dy=arc[f % 5])
        eyes(d, bx)
        mouth(d, bx, kind="o")

    elif state == "failed":
        bx = body(d, dy=2)
        eyes(d, bx, cross=True)
        mouth(d, bx, kind="frown")
        # 汗滴
        d.ellipse((bx[2] - 16, bx[1] + 6, bx[2] - 6, bx[1] + 20), fill=(120, 180, 255))

    elif state == "waiting":
        dx = int(3 * math.sin(2 * math.pi * f / 6))
        bx = body(d, dx=dx)
        eyes(d, bx, pupil=(0, -4))
        mouth(d, bx, kind="o")

    elif state == "running":
        dy = int(2 * math.sin(2 * math.pi * f / 6))
        bx = body(d, dy=dy)
        eyes(d, bx, pupil=(0, 2))
        mouth(d, bx)
        # 键盘
        kb = (bx[0] + 20, bx[3] - 26, bx[2] - 20, bx[3] - 6)
        d.rounded_rectangle(kb, radius=4, fill=(90, 90, 110), outline=OUTLINE, width=3)
        for k in range(3):
            d.rounded_rectangle((kb[0] + 6 + k * 40, kb[1] + 4, kb[0] + 30 + k * 40, kb[1] + 12),
                                radius=2, fill=(230, 230, 240))

    elif state == "review":
        bx = body(d)
        eyes(d, bx, pupil=(0, -2))
        mouth(d, bx)
        # 托腮手
        cx = (bx[0] + bx[2]) / 2
        d.ellipse((cx - 8, bx[1] + 62, cx + 16, bx[1] + 82), fill=BODY, outline=OUTLINE, width=3)

    else:  # look-directions 由 render_look 处理，不会到这里
        raise ValueError(state)

    return im


def render_look(angle_deg):
    im = canvas()
    d = ImageDraw.Draw(im)
    bx = body(d)
    rad = math.radians(angle_deg)
    px = int(4 * math.sin(rad))    # 屏幕 x 随角度
    py = int(-4 * math.cos(rad))   # 0° 朝上 -> y 负
    eyes(d, bx, pupil=(px, py))
    mouth(d, bx)
    cx = (bx[0] + bx[2]) / 2
    tipx = cx + int(26 * math.sin(rad))
    tipy = (bx[1] + bx[3]) / 2 - int(26 * math.cos(rad))
    d.polygon([(tipx, tipy), (cx - 6, tipy - 10), (cx + 6, tipy - 10)], fill=OUTLINE)
    return im


def gen_raw_frames():
    raw = os.path.join(HERE, "frames-raw")
    if os.path.exists(raw):
        shutil.rmtree(raw)
    for row, state, n, _d, _l, _p in F.STATE_ROWS:
        os.makedirs(os.path.join(raw, state), exist_ok=True)
        for f in range(n):
            render(state, f).save(os.path.join(raw, state, "%02d.png" % f))
    os.makedirs(os.path.join(raw, "look-directions"), exist_ok=True)
    for ang in F.DIRECTION_ANGLES:
        render_look(ang).save(os.path.join(raw, "look-directions", F.angle_filename(ang)))
    print("已合成 %d 张原始帧 -> frames-raw/" % F.VALID_CELLS)


def run(cmd):
    print("\n$ " + " ".join(cmd))
    r = subprocess.run(cmd, cwd=HERE)
    if r.returncode != 0:
        print("!! 命令失败退出码 %d" % r.returncode)
        sys.exit(r.returncode)


def main():
    py = sys.executable
    gen_raw_frames()

    run([py, os.path.join(SCRIPTS, "fit.py"), "frames-raw", "-o", "frames", "--height", "198"])
    run([py, os.path.join(SCRIPTS, "assemble.py"), "--frames", "frames",
         "--out", "spritesheet.png", "--webp"])
    run([py, os.path.join(SCRIPTS, "validate.py"), "--atlas", "spritesheet.png",
         "--report", "structural-audit.json"])
    run([py, os.path.join(SCRIPTS, "make_pet.py"), "--atlas", "spritesheet.png",
         "--id", "demo-pet", "--name", "示例团子", "--desc", "合成示例宠物",
         "--kind", "creature", "--tags", "demo,blob", "--vibes", "playful,cozy",
         "--out-dir", "out"])
    # 最终复验（用 make_pet 生成的 pet.json）
    run([py, os.path.join(SCRIPTS, "validate.py"), "--atlas", "spritesheet.png",
         "--pet", os.path.join("out", "demo-pet", "pet.json"),
         "--size-audit", "--report", os.path.join("out", "demo-pet", "structural-audit.json")])
    run([py, os.path.join(SCRIPTS, "preview.py"), "--atlas", "spritesheet.png",
         "--out", os.path.join("out", "demo-pet", "previews"), "--all", "--contact-sheet"])

    print("\n✅ 端到端跑通。可导入目录：out/demo-pet/petdex-package/demo-pet/")


if __name__ == "__main__":
    main()
