# -*- coding: utf-8 -*-
"""
assemble.py —— 把“标准帧”拼成 1536×2288 的 8×11 精灵图（v2）。

对应规范第 6.4 节“定位与组装”。本脚本只做确定性的按格粘贴，不做缩放、不抠图。
输入的每张帧必须已经是 192×208 的 RGBA PNG（先由 fit.py 或你的工具处理成标准帧）。

输入目录结构（帧序号从 0 开始，两位补零；方向帧用角度命名）：
  frames/
    idle/00.png … 05.png            (6)
    running-right/00.png … 07.png   (8)
    running-left/00.png … 07.png    (8)
    waving/00.png … 03.png          (4)
    jumping/00.png … 04.png         (5)
    failed/00.png … 07.png          (8)
    waiting/00.png … 05.png         (6)
    running/00.png … 05.png         (6)
    review/00.png … 05.png          (6)
    look-directions/0.png, 22.5.png, …, 337.5.png  (16)

用法：
  python3 assemble.py --frames frames --out spritesheet.png
  python3 assemble.py --frames frames --out spritesheet.png --webp   # 同时输出无损 webp

空格（15 个透明格）由脚本按规范自动留空，不要自己放空白图占位。
"""
import os
import sys
import argparse
from PIL import Image

import petformat as F


def load_frame(path):
    if not os.path.exists(path):
        raise FileNotFoundError("缺少帧文件: %s" % path)
    im = Image.open(path).convert("RGBA")
    if im.size != (F.FRAME_W, F.FRAME_H):
        raise ValueError("帧尺寸错误: %s 为 %s，应为 192x208（请先用 fit.py 处理成标准帧）"
                         % (path, im.size))
    return im


def assemble(frames_dir):
    atlas = Image.new("RGBA", (F.ATLAS_WIDTH, F.ATLAS_HEIGHT), (0, 0, 0, 0))

    # 9 个标准状态行
    for row, state, frames, _dur, _label, _purpose in F.STATE_ROWS:
        for col in range(frames):
            p = os.path.join(frames_dir, state, "%02d.png" % col)
            im = load_frame(p)
            atlas.paste(im, (col * F.FRAME_W, row * F.FRAME_H))

    # 两行方向
    for i, angle in enumerate(F.DIRECTION_ANGLES):
        row = 9 + (i // 8)
        col = i % 8
        p = os.path.join(frames_dir, "look-directions", F.angle_filename(angle))
        im = load_frame(p)
        atlas.paste(im, (col * F.FRAME_W, row * F.FRAME_H))

    return atlas


def main():
    ap = argparse.ArgumentParser(description="标准帧 -> 8x11 精灵图")
    ap.add_argument("--frames", default="frames", help="标准帧目录（默认 frames）")
    ap.add_argument("--out", default="spritesheet.png", help="输出精灵图路径")
    ap.add_argument("--webp", action="store_true", help="同时输出无损 WebP")
    args = ap.parse_args()

    atlas = assemble(args.frames)
    atlas.save(args.out)
    print("已生成 %s (%dx%d)" % (args.out, atlas.width, atlas.height))

    if args.webp:
        webp = os.path.splitext(args.out)[0] + ".webp"
        atlas.save(webp, "WEBP", lossless=True, quality=100)
        print("已生成 %s（无损 WebP）" % webp)


if __name__ == "__main__":
    sys.exit(main())
