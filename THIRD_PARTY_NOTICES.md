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

## 本地格式适配目标（未 vendoring）

以下项目仅作为 `PetModelImporter` 的**用户本地输入格式**。AllPet 不链接其代码、不下载、不在仓库中
附带其宠物模型或角色资产；生成的图集只保存在执行导入的用户自己的 `~/.config/all-pet/pets`。

### cc-haha

- 仓库：https://github.com/NanmiCoder/cc-haha
- 许可证：MIT（具体宠物/角色素材仍以原作者授权为准）
- 兼容格式：V2 `pet.json + spritesheetPath`、V1 `renderer.kind = single-image`。

### clawd-on-desk

- 仓库：https://github.com/rullerzhou-afk/clawd-on-desk
- 许可证：AGPL-3.0
- 兼容格式：用户本地 checkout 的 `themes/<theme>/theme.json` 与对应状态 GIF/SVG。AllPet 只解析数据和本地
  光栅化用户选中的素材，不复制项目代码到本仓库。

### LingChat

- 仓库：https://github.com/SlimeBoyOwO/LingChat
- 许可证：AGPL-3.0
- 兼容格式：用户本地角色目录中的 `settings.yml + avatar/`。
- LingChat 文档说明角色模型版权、Live2D 模型许可与 Cubism SDK 许可彼此独立；AllPet 当前不附带或执行
  Cubism runtime，仅提供用户已获授权的 avatar 静态回退。
