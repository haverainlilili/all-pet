# -*- coding: utf-8 -*-
"""
make_pet.py —— 从一张已验收的 1536×2288 精灵图，产出可交付/可导入的完整宠物包。

对应规范第 8 节“交付”。会生成：
  - 73 张 192×208 独立 PNG（57 标准帧 + 16 方向帧，不含 15 空格）
  - frame-map.json（73 条完整映射）
  - 填好元数据的 pet.json（states/animations 数值由 petformat 固定生成）
  - 无损 spritesheet.webp + 安装目录 petdex-package/<id>/（只含 pet.json + spritesheet.webp）
  - 两个 ZIP：<id>-petdex.zip、<id>-individual-frames.zip
  - SHA-256 摘要

用法：
  python3 make_pet.py --atlas spritesheet.png \
      --id my-pet --name "My Pet" --desc "A cozy coding companion" --kind creature \
      --tags cat,cozy --vibes cozy,calm [--out-dir .]
"""
import os
import sys
import json
import argparse
import hashlib
import zipfile
from PIL import Image

import petformat as F


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def export_frames(img, out_root):
    """按固定格位导出 73 张单帧，返回 frame-map 的 frames 列表。"""
    frames = []
    for row, state, n, _dur, _label, _purpose in F.STATE_ROWS:
        d = os.path.join(out_root, state)
        os.makedirs(d, exist_ok=True)
        for col in range(n):
            box = (col * F.FRAME_W, row * F.FRAME_H, (col + 1) * F.FRAME_W, (row + 1) * F.FRAME_H)
            cell = img.crop(box)
            fname = "%02d.png" % col
            cell.save(os.path.join(d, fname))
            frames.append({
                "file": "individual-frames/%s/%s" % (state, fname),
                "state": state,
                "frame": col,
                "angle_degrees": None,
                "row": row,
                "column": col,
                "width": F.FRAME_W,
                "height": F.FRAME_H,
            })

    d = os.path.join(out_root, "look-directions")
    os.makedirs(d, exist_ok=True)
    for i, angle in enumerate(F.DIRECTION_ANGLES):
        row = 9 + i // 8
        col = i % 8
        box = (col * F.FRAME_W, row * F.FRAME_H, (col + 1) * F.FRAME_W, (row + 1) * F.FRAME_H)
        cell = img.crop(box)
        fname = F.angle_filename(angle)
        cell.save(os.path.join(d, fname))
        frames.append({
            "file": "individual-frames/look-directions/%s" % fname,
            "state": "look-directions",
            "frame": i,
            "angle_degrees": angle,
            "row": row,
            "column": col,
            "width": F.FRAME_W,
            "height": F.FRAME_H,
        })
    return frames


def build_pet_json(args):
    pet = {
        "id": args.id,
        "displayName": args.name,
        "description": args.desc,
        "kind": args.kind,
        "tags": args.tags,
        "vibes": args.vibes,
        "frameWidth": F.FRAME_W,
        "frameHeight": F.FRAME_H,
        "spriteVersionNumber": F.SPRITE_VERSION,
        "states": F.pet_json_states(),
        "animations": F.pet_json_animations(),
    }
    return pet


def zip_dir(zip_path, base_dir, entries):
    """把 base_dir 下 entries(相对路径列表) 打包进 zip_path。"""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in entries:
            z.write(os.path.join(base_dir, rel), arcname=rel)


def main():
    ap = argparse.ArgumentParser(description="精灵图 -> 交付宠物包")
    ap.add_argument("--atlas", default="spritesheet.png", help="精灵图路径（1536x2288）")
    ap.add_argument("--id", required=True, help="宠物 id（slug）")
    ap.add_argument("--name", default=None, help="展示名（默认同 id）")
    ap.add_argument("--desc", default="", help="描述")
    ap.add_argument("--kind", default="creature", help="creature|object|character")
    ap.add_argument("--tags", default="", help="逗号分隔 tags")
    ap.add_argument("--vibes", default="", help="逗号分隔 vibes")
    ap.add_argument("--out-dir", default=".", help="输出根目录")
    args = ap.parse_args()

    if args.name is None:
        args.name = args.id
    args.tags = [t.strip() for t in args.tags.split(",") if t.strip()]
    args.vibes = [v.strip() for v in args.vibes.split(",") if v.strip()]

    if not os.path.exists(args.atlas):
        print("错误：找不到 %s" % args.atlas)
        sys.exit(1)
    img = Image.open(args.atlas).convert("RGBA")
    if img.size != (F.ATLAS_WIDTH, F.ATLAS_HEIGHT):
        print("错误：%s 尺寸 %s，应为 1536x2288（先 assemble.py 再 validate.py）" % (args.atlas, img.size))
        sys.exit(1)

    root = os.path.join(args.out_dir, args.id)
    frames_dir = os.path.join(root, "individual-frames")
    install_dir = os.path.join(root, "petdex-package", args.id)
    os.makedirs(install_dir, exist_ok=True)

    # 1) 独立帧 + 映射
    frames = export_frames(img, frames_dir)
    frame_map = {
        "atlas": {"width": F.ATLAS_WIDTH, "height": F.ATLAS_HEIGHT, "columns": F.COLS, "rows": F.ROWS,
                  "frameWidth": F.FRAME_W, "frameHeight": F.FRAME_H,
                  "usedCells": F.VALID_CELLS, "transparentCells": F.TRANSPARENT_CELLS},
        "frames": frames,
    }
    with open(os.path.join(root, "frame-map.json"), "w", encoding="utf-8") as f:
        json.dump(frame_map, f, ensure_ascii=False, indent=2)

    # 2) 主 PNG + 无损 WebP + pet.json
    master_png = os.path.join(root, "spritesheet.png")
    master_webp = os.path.join(root, "spritesheet.webp")
    img.save(master_png)
    img.save(master_webp, "WEBP", lossless=True, quality=100)
    pet = build_pet_json(args)
    with open(os.path.join(root, "pet.json"), "w", encoding="utf-8") as f:
        json.dump(pet, f, ensure_ascii=False, indent=2)

    # 3) 安装目录（只含两个文件）
    with open(os.path.join(install_dir, "pet.json"), "w", encoding="utf-8") as f:
        json.dump(pet, f, ensure_ascii=False, indent=2)
    install_webp = os.path.join(install_dir, "spritesheet.webp")
    img.save(install_webp, "WEBP", lossless=True, quality=100)

    # 4) 两个 ZIP
    petdex_zip = os.path.join(root, "%s-petdex.zip" % args.id)
    zip_dir(petdex_zip, install_dir, ["pet.json", "spritesheet.webp"])
    frames_zip = os.path.join(root, "%s-individual-frames.zip" % args.id)
    entries = []
    for fr in frames:
        entries.append(fr["file"])
    entries.append("frame-map.json")
    zip_dir(frames_zip, root, entries)

    # 5) 摘要
    print("宠物包已生成：%s" % root)
    print("  安装目录：%s（仅 pet.json + spritesheet.webp）" % install_dir)
    print("  SHA-256：")
    for p in (master_png, master_webp, petdex_zip, frames_zip):
        print("    %s  %s" % (sha256(p), os.path.basename(p)))
    print("  独立帧 %d 张 + frame-map.json 已写入" % len(frames))


if __name__ == "__main__":
    main()
