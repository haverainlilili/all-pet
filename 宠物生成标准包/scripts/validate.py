# -*- coding: utf-8 -*-
"""
validate.py —— 校验精灵图结构与 pet.json 一致性（对应规范第 7 节“验收”里的结构检查）。

校验内容：
  1) 整图尺寸/格式/Alpha 是否正确（1536×2288，RGBA）。
  2) 73 个有效格有内容、15 个透明格完全透明（逐格按 Alpha 判定，非空口数数）。
  3) 透明格内是否残留隐藏 RGB（RGBA 未清零，只警告不判错）。
  4) 可选 --pet pet.json：校验版本字段、9 状态行号/帧数/时长、两行方向映射一致。
  5) 可选 --size-audit：按规范 5.1 的 6% 辅助容差，输出每状态相对 idle 的尺度偏差。

结果写入 structural-audit.json；结构不通过时退出码为 1。

用法：
  python3 validate.py --atlas spritesheet.png [--pet pet.json] [--size-audit] [--report structural-audit.json]
"""
import os
import sys
import json
import argparse
from PIL import Image

import petformat as F


def cell_alpha(img, row, col):
    """返回某格 (min_alpha, max_alpha, nonzero_rgb_pixels)。"""
    box = (col * F.FRAME_W, row * F.FRAME_H, (col + 1) * F.FRAME_W, (row + 1) * F.FRAME_H)
    cell = img.crop(box)
    a = cell.getchannel("A")
    extrema = a.getextrema()  # (min, max) alpha
    # 隐藏 RGB 检查：alpha==0 但 RGB 非 0 的像素数
    rgba = cell.load()
    hidden = 0
    for y in range(F.FRAME_H):
        for x in range(F.FRAME_W):
            r, g, b, al = rgba[x, y]
            if al == 0 and (r or g or b):
                hidden += 1
    return extrema[0], extrema[1], hidden


def transparent_cells():
    """返回 15 个必须透明的 (row, col)。"""
    cells = []
    for row in range(F.ROWS):
        n = F.FRAMES_PER_ROW[row]
        for col in range(n, F.COLS):
            cells.append((row, col))
    return cells


def main():
    ap = argparse.ArgumentParser(description="校验精灵图结构与 pet.json")
    ap.add_argument("--atlas", default="spritesheet.png", help="精灵图路径")
    ap.add_argument("--pet", default=None, help="pet.json 路径（可选）")
    ap.add_argument("--size-audit", action="store_true", help="附加尺度审计（6% 容差）")
    ap.add_argument("--report", default="structural-audit.json", help="报告输出路径")
    args = ap.parse_args()

    checks = []
    fails = 0

    def add(name, ok, detail):
        nonlocal fails
        if not ok:
            fails += 1
        checks.append({"check": name, "result": "pass" if ok else "fail", "detail": detail})

    # 1) 基本尺寸/格式
    if not os.path.exists(args.atlas):
        print("错误：找不到 %s" % args.atlas)
        sys.exit(1)
    img = Image.open(args.atlas)
    fmt = img.format
    has_alpha = img.mode in ("RGBA", "LA", "PA") or ("A" in img.getbands())
    size_ok = img.size == (F.ATLAS_WIDTH, F.ATLAS_HEIGHT)
    add("atlas_size", size_ok,
        "%s=%dx%d，期望 %dx%d" % (args.atlas, img.width, img.height, F.ATLAS_WIDTH, F.ATLAS_HEIGHT))
    add("atlas_alpha", has_alpha, "模式=%s，格式=%s，含Alpha=%s" % (img.mode, fmt, has_alpha))
    if not (size_ok and has_alpha):
        img = img.convert("RGBA")  # 仍继续做逐格检查

    # 2) 逐格占用
    valid_ok = True
    valid_bad = []
    for row in range(F.ROWS):
        for col in range(F.FRAMES_PER_ROW[row]):
            mn, mx, _h = cell_alpha(img, row, col)
            if mx == 0:
                valid_bad.append("r%dc%d" % (row, col))
    if valid_bad:
        valid_ok = False
    add("valid_cells_present", valid_ok,
        "有效格应为 %d 个，空内容格：%s" % (F.VALID_CELLS, valid_bad or "无"))

    empty_ok = True
    empty_bad = []
    for (row, col) in transparent_cells():
        mn, mx, _h = cell_alpha(img, row, col)
        if mx != 0:
            empty_bad.append("r%dc%d(alpha_max=%d)" % (row, col, mx))
    if empty_bad:
        empty_ok = False
    add("transparent_cells_empty", empty_ok,
        "透明格应为 %d 个，非透明：%s" % (F.TRANSPARENT_CELLS, empty_bad or "无"))

    # 3) 透明格隐藏 RGB（警告）
    hidden_total = 0
    for (row, col) in transparent_cells():
        _mn, _mx, h = cell_alpha(img, row, col)
        hidden_total += h
    checks.append({"check": "transparent_cells_rgb_zero", "result": "warning" if hidden_total else "pass",
                   "detail": "透明格内 alpha==0 但 RGB 非零的像素：%d（应清零为 0,0,0,0）" % hidden_total})

    # 4) pet.json 一致性
    if args.pet:
        if not os.path.exists(args.pet):
            add("pet_json_exists", False, "找不到 %s" % args.pet)
        else:
            with open(args.pet, encoding="utf-8") as f:
                pet = json.load(f)
            add("pet_version", pet.get("spriteVersionNumber") == F.SPRITE_VERSION,
                "spriteVersionNumber=%s，期望 %d" % (pet.get("spriteVersionNumber"), F.SPRITE_VERSION))
            add("pet_frame_size", (pet.get("frameWidth"), pet.get("frameHeight")) == (192, 208),
                "frameWidth/frameHeight=%s/%s" % (pet.get("frameWidth"), pet.get("frameHeight")))
            states = pet.get("states", {})
            st_ok = True
            st_detail = []
            for row, state, frames, dur, _l, _p in F.STATE_ROWS:
                s = states.get(state)
                if not s or s.get("row") != row or s.get("frames") != frames or s.get("durationMs") != dur:
                    st_ok = False
                    st_detail.append("%s(期望 row%d/%d帧/%dms)" % (state, row, frames, dur))
            add("pet_states", st_ok, "状态映射不一致：%s" % (st_detail or "无"))

    # 5) 尺度审计（可选）
    size_audit = None
    if args.size_audit:
        def frame_area(row, col):
            box = (col * F.FRAME_W, row * F.FRAME_H, (col + 1) * F.FRAME_W, (row + 1) * F.FRAME_H)
            hist = img.crop(box).getchannel("A").histogram()  # 256 个强度计数
            return sum(hist[1:])  # alpha > 0 的像素数
        size_audit = {}
        idle_mean = None
        per_state = {}
        for row, state, frames, _d, _l, _p in F.STATE_ROWS:
            areas = [frame_area(row, c) for c in range(frames)]
            per_state[state] = {"mean_sqrt_area": (sum(a ** 0.5 for a in areas) / len(areas))}
            if state == "idle":
                idle_mean = per_state[state]["mean_sqrt_area"]
        for state in per_state:
            dev = abs(per_state[state]["mean_sqrt_area"] / idle_mean - 1)
            per_state[state]["deviation"] = round(dev, 4)
            per_state[state]["within_6pct"] = dev <= 0.06

    report = {
        "atlas": args.atlas,
        "size": [img.width, img.height],
        "format": fmt,
        "mode": img.mode,
        "grid": {"columns": F.COLS, "rows": F.ROWS,
                 "validCells": F.VALID_CELLS, "transparentCells": F.TRANSPARENT_CELLS},
        "checks": checks,
    }
    if size_audit is not None:
        report["size_audit"] = size_audit

    with open(args.report, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print("报告已写入 %s" % args.report)
    for c in checks:
        mark = {"pass": "✅", "warning": "⚠️", "fail": "❌"}[c["result"]]
        print("  %s %s: %s" % (mark, c["check"], c["detail"]))
    print("结果：%s（失败 %d 项）" % ("通过" if fails == 0 else "未通过", fails))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
