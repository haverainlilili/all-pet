# example · 合成示例宠物（端到端自测）

这里用程序合成一只「示例团子」（像素风团子），跑通本包全部脚本，产出可直接导入 AllPet 的成品。**不依赖任何外部图片**，用来验证脚本正常，也当「照做一遍长什么样」的样板。

## 运行

```bash
cd example
python3 make_demo.py
```

跑完后：

| 路径 | 内容 |
|---|---|
| `frames-raw/` | 合成的 73 张原始帧（256×256） |
| `frames/` | `fit.py` 处理后的 192×208 标准帧 |
| `spritesheet.png` / `.webp` | 1536×2288 精灵图 + 无损 WebP |
| `structural-audit.json` | 结构校验报告 |
| `out/demo-pet/` | 完整交付包（独立帧、frame-map、pet.json、两个 ZIP、previews） |
| `out/demo-pet/petdex-package/demo-pet/` | **可导入 AllPet 的安装目录**（仅 pet.json + spritesheet.webp） |

## 导入

```bash
./allpet pet import "/绝对路径/example/out/demo-pet/petdex-package/demo-pet"
./allpet pet set "示例团子"
```

## 说明

- 这是**合成示例**，用来演示流程和验证脚本；你的真实宠物要照 `02` 文档自己生成美术图。
- `frames-raw/`、`frames/`、`out/` 都是可再生的中间/成品，删除后重跑 `make_demo.py` 即可恢复。
