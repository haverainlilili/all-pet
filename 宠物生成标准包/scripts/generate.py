# -*- coding: utf-8 -*-
"""
generate.py —— 参考图一键生成宠物（0 LLM，纯脚本 + 图生图 API）。

流程：读参考图 → 固定模板 + 参考图，逐状态/方向调图生图 API → 收集 73 帧
      → fit → assemble → validate → make_pet（复用既有脚本，无任何 LLM 决策）。

用法：
  # 1) 先用 mock 跑通（不联网，出占位图，验证整条链路）
  python3 scripts/generate.py --ref 参考图.png --adapter mock --id my-pet --name "我的宠物"

  # 2) 换成你自己的 API（先在 gen_adapter.py 的 CustomAdapter 里填好调用）
  python3 scripts/generate.py --ref 参考图.png --adapter custom --config config.json \
      --id my-pet --name "我的宠物" --desc "..." --kind creature --tags cat --vibes cozy

  # 3) 条带模式：9 状态条带 + 2 方向条带 ≈ 11 次调用（默认逐帧 73 次）
  python3 scripts/generate.py --ref 参考图.png --adapter custom --config config.json --strip --id my-pet

可选元数据：--name --desc --kind --tags --vibes（传给 make_pet，写进 pet.json）。
"""
import os
import sys
import json
import argparse
import subprocess

from PIL import Image

import petformat as F
import gen_prompts as P
import gen_adapter as A

HERE = os.path.dirname(os.path.abspath(__file__))


def run(cmd):
    print("$ " + " ".join(cmd))
    subprocess.run(cmd, check=True)


def load_config(path):
    cfg = {}
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    return cfg


def slice_strip(strip_path, out_dir, names):
    """把一条横向条带按列数等分切片，落到 out_dir 下的 names。"""
    im = Image.open(strip_path).convert("RGBA")
    w, h = im.size
    n = len(names)
    cw = w // n
    os.makedirs(out_dir, exist_ok=True)
    for i, name in enumerate(names):
        im.crop((i * cw, 0, (i + 1) * cw, h)).save(os.path.join(out_dir, name))


def main():
    ap = argparse.ArgumentParser(description="参考图一键生成宠物（0 LLM）")
    ap.add_argument("--ref", default=None, help="参考图路径（保持角色身份用）")
    ap.add_argument("--adapter", default="mock", choices=sorted(A.ADAPTERS),
                    help="图生图适配器（默认 mock 用于验证）")
    ap.add_argument("--config", default=None, help="config.json 路径（api_key/model 等）")
    ap.add_argument("--strip", action="store_true",
                    help="条带模式：9 状态 + 2 方向 ≈ 11 次调用（默认逐帧 73 次）")
    ap.add_argument("--workdir", default=".", help="工作目录（frames-raw/frames/spritesheet 放这）")
    ap.add_argument("--out", default="out", help="交付根目录（make_pet --out-dir）")
    ap.add_argument("--id", required=True, help="宠物 id（slug）")
    ap.add_argument("--name", default=None, help="展示名（默认同 id）")
    ap.add_argument("--desc", default="", help="描述")
    ap.add_argument("--kind", default="creature", help="creature|object|character")
    ap.add_argument("--tags", default="", help="逗号分隔 tags")
    ap.add_argument("--vibes", default="", help="逗号分隔 vibes")
    args = ap.parse_args()

    if args.name is None:
        args.name = args.id

    cfg = load_config(args.config)
    adapter = A.get_adapter(args.adapter)

    work = os.path.abspath(args.workdir)
    out = os.path.abspath(args.out)
    raw = os.path.join(work, "frames-raw")
    frames = os.path.join(work, "frames")
    atlas = os.path.join(work, "spritesheet.png")
    os.makedirs(raw, exist_ok=True)

    total_calls = 0

    def gen(prompt, out_path, meta):
        nonlocal total_calls
        adapter.generate(args.ref, prompt, out_path, cfg, meta)
        total_calls += 1

    # —— 9 个标准状态 ——
    for _row, state, n, _dur, _label, _purpose in F.STATE_ROWS:
        d = os.path.join(raw, state)
        if args.strip:
            strip_path = os.path.join(raw, state + "__strip.png")
            gen(P.state_strip_prompt(state, n), strip_path, {"state": state, "strip_n": n})
            slice_strip(strip_path, d, ["%02d.png" % i for i in range(n)])
            os.remove(strip_path)
        else:
            for i in range(n):
                gen(P.state_frame_prompt(state, i, n),
                    os.path.join(d, "%02d.png" % i), {"state": state, "frame": i})

    # —— 16 个视线方向 ——
    ld = os.path.join(raw, "look-directions")
    if args.strip:
        for half in (0, 1):
            angles = F.DIRECTION_ANGLES[half * 8:(half + 1) * 8]
            strip_path = os.path.join(raw, "look__strip%d.png" % half)
            gen(P.direction_strip_prompt(angles), strip_path,
                {"state": "look-directions", "strip_n": 8})
            slice_strip(strip_path, ld, [F.angle_filename(a) for a in angles])
            os.remove(strip_path)
    else:
        for ang in F.DIRECTION_ANGLES:
            gen(P.direction_prompt(ang), os.path.join(ld, F.angle_filename(ang)),
                {"state": "look-directions", "frame": ang})

    print("图生图调用次数：%d（%s模式）" % (total_calls, "条带" if args.strip else "逐帧"))

    # —— 复用既有脚本：fit → assemble → validate → make_pet ——
    py = sys.executable
    run([py, os.path.join(HERE, "fit.py"), raw, "-o", frames, "--height", "198"])
    run([py, os.path.join(HERE, "assemble.py"), "--frames", frames, "--out", atlas, "--webp"])
    run([py, os.path.join(HERE, "validate.py"), "--atlas", atlas,
         "--report", os.path.join(work, "structural-audit.json")])
    run([py, os.path.join(HERE, "make_pet.py"), "--atlas", atlas,
         "--id", args.id, "--name", args.name, "--desc", args.desc, "--kind", args.kind,
         "--tags", args.tags, "--vibes", args.vibes, "--out-dir", out])
    run([py, os.path.join(HERE, "validate.py"), "--atlas", atlas,
         "--pet", os.path.join(out, args.id, "pet.json"), "--size-audit",
         "--report", os.path.join(out, args.id, "structural-audit.json")])

    print("\n✅ 完成。可导入目录：%s/%s/petdex-package/%s/" % (out, args.id, args.id))


if __name__ == "__main__":
    main()
