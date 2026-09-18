# -*- coding: utf-8 -*-
"""
fit.py —— 把一张松散生成的图片，等比缩放并定位到 192×208 的透明标准帧画布上。

对应规范第 5.1 节的“198 px 基准占画尺度 + 锚点”要求：
- 默认按“可见高度 198 px”等比缩放（同一来源的一行应使用同一系数，不要逐帧各调）。
- 默认锚点 bottom-center（底部居中），保留主体脚底基线。
- 结果统一输出 192×208 RGBA PNG，供 assemble.py 使用。

用法：
  单张:  python3 fit.py 输入.png -o 输出.png [--height 198] [--anchor bottom-center]
  整目录(镜像结构批量):  python3 fit.py 输入目录 -o 输出目录 [--height 198] [--anchor ...]

参数：
  --height   目标可见高度 px（默认 198；规范基准）。用 --scale 时忽略。
  --scale    固定缩放系数（如 0.85）。指定后不再按 --height 算，适合“同一来源整行固定系数”。
  --anchor   定位锚点，水平-垂直，取值见 ANCHORS。默认 bottom-center。
  --no-alpha 输入无透明通道时按不透明处理（默认自动 RGBA）。

注意：本脚本只做“确定的等比缩放 + 定位”，不做抠图/去底。生成图需要先有真实透明背景。
最宽姿态装不下时，请按规范第 5.1 节做尺寸决策，而不是本脚本强行压缩。
"""
import os
import sys
import argparse
from PIL import Image

FRAME_W, FRAME_H = 192, 208

# 锚点: 水平(left/center/right) + 垂直(top/center/bottom)
ANCHORS = {
    "bottom-center": ("center", "bottom"),
    "bottom-left": ("left", "bottom"),
    "bottom-right": ("right", "bottom"),
    "center": ("center", "center"),
    "center-left": ("left", "center"),
    "center-right": ("right", "center"),
    "top-center": ("center", "top"),
}


def visible_bbox(img: Image.Image):
    """返回非透明内容的包围盒 (l, t, r, b)；全透明返回 None。"""
    return img.getchannel("A").getbbox()


def fit_image(img: Image.Image, height=None, scale=None, anchor="bottom-center") -> Image.Image:
    if anchor not in ANCHORS:
        raise ValueError("未知 anchor: %s，可用 %s" % (anchor, list(ANCHORS)))
    hx, vx = ANCHORS[anchor]

    img = img.convert("RGBA")
    bbox = visible_bbox(img)
    if bbox is None:
        return Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    l, t, r, b = bbox
    content = img.crop((l, t, r, b))
    cw, ch = r - l, b - t
    if scale is None:
        if height is None:
            height = 198
        scale = height / ch
    nw = max(1, round(cw * scale))
    nh = max(1, round(ch * scale))
    content = content.resize((nw, nh), Image.LANCZOS)

    canvas = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    # 水平位置
    if hx == "left":
        x = 0
    elif hx == "right":
        x = FRAME_W - nw
    else:
        x = (FRAME_W - nw) // 2
    # 垂直位置
    if vx == "top":
        y = 0
    elif vx == "bottom":
        y = FRAME_H - nh
    else:
        y = (FRAME_H - nh) // 2

    canvas.paste(content, (x, y), content)
    return canvas


def process_file(src, dst, height, scale, anchor):
    img = Image.open(src)
    out = fit_image(img, height=height, scale=scale, anchor=anchor)
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    out.save(dst)
    print("  %s -> %s" % (src, dst))


def main():
    ap = argparse.ArgumentParser(description="缩放定位松散图到 192x208 标准帧")
    ap.add_argument("input", help="输入图片或目录")
    ap.add_argument("-o", "--out", required=True, help="输出文件或目录")
    ap.add_argument("--height", type=float, default=198, help="目标可见高度px（默认198）")
    ap.add_argument("--scale", type=float, default=None, help="固定缩放系数（覆盖--height）")
    ap.add_argument("--anchor", default="bottom-center", help="锚点，见 ANCHORS")
    args = ap.parse_args()

    if os.path.isdir(args.input):
        n = 0
        for root, _, files in os.walk(args.input):
            for f in sorted(files):
                if f.lower().endswith((".png", ".webp", ".jpg", ".jpeg")):
                    rel = os.path.relpath(os.path.join(root, f), args.input)
                    dst = os.path.join(args.out, rel)
                    process_file(os.path.join(root, f), dst, args.height, args.scale, args.anchor)
                    n += 1
        print("完成：处理 %d 张图 -> %s" % (n, args.out))
    else:
        process_file(args.input, args.out, args.height, args.scale, args.anchor)


if __name__ == "__main__":
    sys.exit(main())
