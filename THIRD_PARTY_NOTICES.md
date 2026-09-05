# Third-party notices

本项目参考并复用了以下开源项目的设计思路、格式规范与部分实现（均按其许可证使用）：

## openpets

- 仓库：https://github.com/alterhq/openpets
- 许可证：MIT
- 复用内容：Codex 宠物图集（8 列 × 9 行）与动画状态机规范（`idle` / `running-right` /
  `running-left` / `waving` / `jumping` / `failed` / `waiting` / `running` / `review`
  以及各状态逐帧时长）、`pet.json` 清单格式、Codex 宠物目录发现位置。
- 具体对应：本仓库 `Sources/AllPetCore/PetAnimation.swift`、
  `Sources/AllPetCore/PetManifest.swift`、`Sources/AllPetCore/PetBundle.swift`。

## codex-to-dsh-pet

- 仓库：https://github.com/Signalight/codex-to-dsh-pet
- 许可证：MIT
- 复用内容：Codex v1/v2 图集规范（帧尺寸 192×208、8 列、v1 9 行 / v2 11 行）、
  agent 活动状态（运行 / 思考 / 完成 / 报错 / 中断）到宠物姿势的映射思路，
  DSH 活动信号（`~/.dsh/sessions/**/session.jsonl.zstd`）的来源确认。
