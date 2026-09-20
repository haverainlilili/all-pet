# 宠物生成标准包（AllPet / Petdex 桌宠形象制作）

这是一套**指导文档 + 模板 + 脚本**，用来生成一只桌面宠物形象，并打包成 AllPet 能直接导入的格式。最终产物是一个文件夹，`./allpet pet import <文件夹>` 就能加载成桌宠。

两条路可选：

- **零 LLM 一键生成（最省）**：传一张参考图 → `scripts/generate.py` 全程脚本 + 图生图 API 出 73 帧，**不经过 LLM、0 token、0 决策**（见 `05-参考图一键生成.md`）。
- **手动/半自动**：照 `02` 的 prompt 模板自己出图，再用 `03` 的脚本拼图打包。

---

## 三步做完一只宠物

```
① 定角色  →  ② 生成图  →  ③ 拼图打包导入
   填设定       照 prompt 模板      脚本一键
   (02 文档)     用图像工具出图       (03 文档)
```

- **① 定角色**：在 `02-文生图Prompt模板.md` 的「角色设定表」里写下名字、画风、配色、身体结构。
- **② 生成图**：照着 `02` 文档里 9 个状态 + 16 方向的 prompt 模板，用任意图像生成工具出图（透明底 PNG）。
- **③ 拼图打包**：用 `scripts/` 里的脚本拼成标准精灵图、校验、打包，再按 `04-导入AllPet.md` 导入。

---

## 零 LLM 一键生成（最省）

不想写 prompt、不想做决策？传一张参考图就行，全程脚本 + 图生图 API，**0 LLM token、0 决策**：

```bash
# 1) 在 scripts/gen_adapter.py 的 CustomAdapter 里填你的图生图 API（一次即可）
# 2) 传参考图一键生成
python3 scripts/generate.py --ref 参考图.png --adapter custom --config config.json \
    --id my-pet --name "我的宠物"
```

详细说明（含条带模式把 73 次调用压到 ~11 次）见 `05-参考图一键生成.md`。

---

## 目录说明

| 文件 / 目录 | 作用 |
|---|---|
| `01-桌面宠物制作流程与交付规范.md` | **规则主文件**（v3.0）：固定规格、9 状态、16 方向、质量与验收、交付结构。动工前通读第 1~5 节 |
| `02-文生图Prompt模板.md` | **生成图片的指南**：角色设定表 + 逐状态 prompt + 风格一致性锁定技巧 |
| `03-脚本使用与拼图打包.md` | **脚本用法**：fit → assemble → validate → preview → make_pet 的完整命令 |
| `04-导入AllPet.md` | **最后一步**：把成品导入 AllPet、菜单换宠、看缩略图 |
| `05-参考图一键生成.md` | **零 LLM 生成**：传参考图 → `generate.py` 全程脚本出 73 帧 |
| `templates/pet.json` | pet.json 模板（占位符版，`make_pet.py` 会自动填好） |
| `config.example.json` | 图生图 API 配置样例（`generate.py` 用） |
| `scripts/` | 可执行脚本（生成 / 拼图 / 校验 / 打包 / 预览） |
| `example/` | 一个合成示例宠物 + 生成器，用来验证脚本端到端跑通 |

---

## 环境准备

```bash
pip3 install -r requirements.txt        # 只需 Pillow
brew install webp                        # 可选：无损动画 WebP 预览用
```

---

## 最快验证：跑一遍自带示例

```bash
cd example
python3 make_demo.py                     # 合成 73 帧示例并跑通整套脚本
ls out/demo-pet/                         # 看成品：pet.json + spritesheet.webp + 两个 ZIP
```

跑通后，把 `out/demo-pet/petdex-package/demo-pet/` 目录导入 AllPet 即可看到一只会动的示例宠物。

---

## 关键约束（一句话版）

> 一个宠物 = `pet.json` + `spritesheet.webp` 两个文件。精灵图固定 **1536×2288，8 列 × 11 行，每格 192×208**，第 0~8 行是 9 个状态（57 帧），第 9~10 行是 16 个视线方向，共 **73 有效格 + 15 透明格**，版本字段 `spriteVersionNumber: 2`。

详细规则见 `01` 文档，别在没读的情况下凭感觉拼图。
