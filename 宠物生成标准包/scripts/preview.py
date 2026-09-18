# -*- coding: utf-8 -*-
"""
preview.py —— 从精灵图生成动画预览：GIF + 无损动画 WebP（+ 可选动作总览 contact sheet）。

对应规范第 6.6 / 8.2 节：至少交付 running-right / running-left / jumping 三项 GIF；
GIF 无法保留柔和透明边缘时，额外提供无损动画 WebP（本脚本二者都出）。

用法：
  python3 preview.py --atlas spritesheet.png --out previews            # 只出三项必需
  python3 preview.py --atlas spritesheet.png --out previews --all       # 全部状态+方向
  python3 preview.py --atlas spritesheet.png --out previews --contact-sheet
"""
import os
import sys
import shutil
import argparse
import subprocess
import tempfile
from PIL import Image

import petformat as F


def crop_frames(img, row, n):
    return [img.crop((c * F.FRAME_W, row * F.FRAME_H, (c + 1) * F.FRAME_W, (row + 1) * F.FRAME_H))
            for c in range(n)]


def save_gif(frames, path, duration_ms):
    frames[0].save(path, save_all=True, append_images=frames[1:],
                   duration=duration_ms, loop=0, disposal=2, transparency=0)


def save_lossless_webp(frames, path, duration_ms):
    """用 img2webp 生成无损（保留 Alpha）动画 WebP。找不到工具则跳过并提示。"""
    if not shutil.which("img2webp"):
        print("  （跳过无损WebP：未安装 img2webp，可 `brew install webp`）")
        return False
    with tempfile.TemporaryDirectory() as tmp:
        names = []
        for i, f in enumerate(frames):
            p = os.path.join(tmp, "%02d.png" % i)
            f.save(p)
            names.append(p)
        cmd = ["img2webp", "-lossless", "-loop", "0", "-d", str(duration_ms)] + names + ["-o", path]
        subprocess.run(cmd, check=True)
    return True


def make_state_previews(img, out_dir, state, row, n, dur):
    frames = crop_frames(img, row, n)
    save_gif(frames, os.path.join(out_dir, "%s.gif" % state), dur)
    save_lossless_webp(frames, os.path.join(out_dir, "%s.webp" % state), dur)
    print("  %s（%d 帧，%d ms）" % (state, n, dur))


def make_look_preview(img, out_dir):
    frames = []
    for i, angle in enumerate(F.DIRECTION_ANGLES):
        row = 9 + i // 8
        col = i % 8
        frames.append(img.crop((col * F.FRAME_W, row * F.FRAME_H, (col + 1) * F.FRAME_W, (row + 1) * F.FRAME_H)))
    save_gif(frames, os.path.join(out_dir, "look-directions.gif"), F.DIRECTION_DURATION_MS)
    save_lossless_webp(frames, os.path.join(out_dir, "look-directions.webp"), F.DIRECTION_DURATION_MS)
    print("  look-directions（16 帧）")


def make_contact_sheet(img, out_dir):
    """动作总览：带行标签的 73 帧拼版图。"""
    try:
        from PIL import ImageDraw, ImageFont
        font = ImageFont.load_default()
    except Exception:
        font = None
    gutter = 90
    sheet = Image.new("RGBA", (gutter + F.ATLAS_WIDTH, F.ATLAS_HEIGHT), (30, 30, 32, 255))
    sheet.paste(img, (gutter, 0))
    if font:
        d = ImageDraw.Draw(sheet)
        for row, state, n, _dur, label, _p in F.STATE_ROWS:
            d.text((4, row * F.FRAME_H + 6), "%d %s(%d)" % (row, state, n), fill=(255, 255, 255), font=font)
        d.text((4, 9 * F.FRAME_H + 6), "9 look 0-157.5", fill=(255, 255, 255), font=font)
        d.text((4, 10 * F.FRAME_H + 6), "10 look 180-337.5", fill=(255, 255, 255), font=font)
    path = os.path.join(out_dir, "layout-contact-sheet.png")
    sheet.convert("RGB").save(path)
    print("  动作总览：%s" % path)


def main():
    ap = argparse.ArgumentParser(description="生成动画预览")
    ap.add_argument("--atlas", default="spritesheet.png", help="精灵图路径")
    ap.add_argument("--out", default="previews", help="输出目录")
    ap.add_argument("--all", action="store_true", help="生成全部状态与方向预览")
    ap.add_argument("--contact-sheet", action="store_true", help="生成动作总览图")
    args = ap.parse_args()

    img = Image.open(args.atlas).convert("RGBA")
    if img.size != (F.ATLAS_WIDTH, F.ATLAS_HEIGHT):
        print("错误：%s 尺寸 %s，应为 1536x2288" % (args.atlas, img.size))
        sys.exit(1)
    os.makedirs(args.out, exist_ok=True)

    if args.all:
        for row, state, n, dur, _l, _p in F.STATE_ROWS:
            make_state_previews(img, args.out, state, row, n, dur)
        make_look_preview(img, args.out)
    else:
        for state in ("running-right", "running-left", "jumping"):
            row = next(r for r, s, _n, _d, _l, _p in F.STATE_ROWS if s == state)
            n = next(n for r, s, n, _d, _l, _p in F.STATE_ROWS if s == state)
            dur = next(d for r, s, _n, d, _l, _p in F.STATE_ROWS if s == state)
            make_state_previews(img, args.out, state, row, n, dur)

    if args.contact_sheet:
        make_contact_sheet(img, args.out)

    print("完成 -> %s" % args.out)


if __name__ == "__main__":
    main()
