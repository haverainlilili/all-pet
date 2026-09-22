> [English](./README.md) · 中文

# AllPet 🐾

一只 AI 编码桌面宠物，同时查看 **Codex、Claude Code / Desktop、DeepSeek Harness（DSH）和 Grok** 的任务状态。原生宠物 GUI 仅 macOS；跨平台 Electron 壳（`desktop/`）可在 macOS / Linux / Windows 显示宠物并提供图形化宠物管理。核心监控与 `status`/`watch` 等 CLI 支持全平台。

宠物会根据运行、等待、完成和失败状态切换动画；点击任务气泡可以回到对应会话。

## 为什么同时看这么多平台？

你现在真正用到的能力不是「某个模型」，而是 **harness（执行外壳）× 模型** 的组合。harness 决定模型看到什么上下文、能用哪些工具、什么时候重试或收尾——同一个模型套上不同的 harness，结果可以差很远：

- 同一个 **Claude Sonnet 4.6**：在 Claude Code 里 SWE-bench Verified 约 71%，换成 Continue 外壳只剩约 52%。([TensorFeed](https://tensorfeed.ai/harnesses))
- 同一个 **Claude Opus 4.5**：统一 SEAL 脚手架下 45.9%，放回自家 Claude Code 是 55.4%。([arXiv 2605.23950](https://arxiv.org/html/2605.23950))
- 同一个 **Grok 4**：通用 SWE-agent 下 58.6%，换成 xAI 自家脚手架 72–75%。([arXiv 2605.23950](https://arxiv.org/html/2605.23950))

规律很一致：**各家模型在自己的 harness 里最强**（系统提示、工具定义、上下文管理都围绕自家模型调过），换到别家外壳就掉分。所以「Claude 用 Claude Code、GPT 用 Codex、Grok 用 Grok」才是日常用法——这也是 AllPet 同时盯着 Codex、Claude Code、DSH、Grok 的原因。

## 快速开始

### 下载安装包（推荐）

从 [GitHub Releases](https://github.com/haverainlilili/all-pet/releases) 下载最新版本：

- **macOS** — `AllPet-<版本>-arm64.dmg`
- **Windows** — `AllPet-Setup-<版本>.exe`
- **Linux** — `AllPet-<版本>.AppImage` 或 `allpet-desktop_<版本>_amd64.deb`

安装包内已包含 Swift 核心与 4 个内置宠物，无需安装 Node.js / Swift，也无需额外下载宠物。（macOS 版本暂未签名，首次打开需右键 →「打开」。）

### 选择正确安装包（供用户与 AI 直接判断）

**当前稳定版：v1.3.0。** 请同时按“系统 + CPU 架构”选择；下表是可直接下载的产物链接，AI 助手可直接返回对应链接，不需要让用户自行翻找 Release 页面。

| 设备 | 架构 / 适用型号 | 直接下载 | 适用场景 |
| --- | --- | --- | --- |
| macOS 14+ | **Apple Silicon arm64**：M1 / M2 / M3 / M4 / M5 | [DMG：AllPet-1.3.0-arm64.dmg](https://github.com/haverainlilili/all-pet/releases/download/v1.3.0/AllPet-1.3.0-arm64.dmg) · [ZIP](https://github.com/haverainlilili/all-pet/releases/download/v1.3.0/AllPet-1.3.0-arm64-mac.zip) | Apple M 系列芯片的 Mac |
| Windows 10 / 11 | **x64**：64 位 Intel / AMD | [EXE：AllPet-Setup-1.3.0.exe](https://github.com/haverainlilili/all-pet/releases/download/v1.3.0/AllPet-Setup-1.3.0.exe) | 常见 Intel / AMD Windows 电脑 |
| Linux（大多数 x64 发行版） | **x64**：64 位 Intel / AMD | [AppImage：AllPet-1.3.0.AppImage](https://github.com/haverainlilili/all-pet/releases/download/v1.3.0/AllPet-1.3.0.AppImage) | 大多数 x64 Linux，免安装便携使用 |
| Debian / Ubuntu Linux | **x64**：64 位 Intel / AMD | [DEB：allpet-desktop_1.3.0_amd64.deb](https://github.com/haverainlilili/all-pet/releases/download/v1.3.0/allpet-desktop_1.3.0_amd64.deb) | Debian / Ubuntu 及其兼容发行版 |

**当前未提供预编译包：** Intel Mac（`x86_64`）、Windows on ARM、Linux ARM（`aarch64`）。这些环境请从源码构建，或欢迎贡献对应打包支持。

> **给 AI / 自动化工具的选择规则：** 先询问系统和 CPU 架构。Apple M 系列 Mac 返回 DMG；常见 Intel/AMD Windows 返回 EXE；Debian/Ubuntu x64 返回 DEB；其它 x64 Linux 返回 AppImage。不要把 arm64 macOS 安装包推荐给 Intel Mac。

> **适配说明与贡献邀请：** 当前 **macOS 的适配和实测覆盖最好**，包含原生 AppKit GUI 与更完整的任务定位能力。Windows / Linux 安装包已支持，但会受不同桌面环境影响更多；若你发现 Windows 或 Linux 在显示、托盘、透明窗口、任务唤起或监控方面有问题，欢迎直接提交 PR，维护者会优先审查并合入可合并的修复。

### 安装包更新与最新源码的区别

**不是每次提交都必须重新发布安装包**，两种跟进方式不同：

- **`main` 分支 = 最新开发源码。** 能自行构建的用户可在修复合入后立即执行 `git pull --ff-only`，重新构建/重启即可跟进，不必等待下一个安装包。
- **`vX.Y.Z` 标签 / GitHub Release = 稳定预编译安装包。** 通过 DMG / EXE / AppImage / DEB 安装的用户，运行的是打包时包含的代码；后续提交不会自动进入已经安装的程序。
- **代码修复要让安装包用户生效，就必须再构建一个新版本。** 普通修复可合并积累后发布补丁版（例如 `v1.3.1`）；严重兼容性或安全问题应尽快单独打包。仅 README/说明文档变化不需要重新打包。
- **目前尚未启用应用内自动更新。** 安装包用户需要关注 [GitHub Releases](https://github.com/haverainlilili/all-pet/releases)，有新版本时重新下载安装。

需要直接跟进最新提交时，可[下载 `main` 源码 ZIP](https://github.com/haverainlilili/all-pet/archive/refs/heads/main.zip)，或在已有仓库中运行：

```bash
git pull --ff-only
./allpet restart          # macOS 原生 GUI / CLI：重新构建并重启
```

Windows / Linux / macOS 的 Electron 壳需要重新构建 Swift sidecar，再按 [`desktop/README.md`](./desktop/README.md) 运行或打包 `desktop/`。AI 助手对普通用户应优先推荐稳定 Release；只有用户明确需要最新源码且具备构建环境时，才推荐 `main`。

### 从源码构建

要求：原生 GUI 需 macOS 14+、Xcode Command Line Tools；`status`/`watch`/`help`/`pet list` 等 CLI 可在 Linux（Swift 5.10+）与 Windows 上构建运行（Linux 已用 Docker `swift:latest` 镜像验证）。

```bash
git clone git@github.com:haverainlilili/all-pet.git
cd all-pet
./allpet
```

第一次启动会自动构建，之后继续使用 `./allpet` 即可。

```bash
./allpet status       # 查看当前任务状态
./allpet restart      # 重新构建并重启
./allpet stop         # 停止宠物
./allpet logs         # 查看日志
./allpet self-test    # 运行内建检查
```

## 更换宠物

AllPet 内置 4 个开箱即用宠物（Boba、Tiko、团团和米粒、Hoops）；其余默认宠物首次点击时下载。

### 方法一：在菜单中选择（最简单）

1. 点击 macOS 菜单栏的 **🐾**。
2. 打开 **宠物**。
3. 每个已安装宠物都会显示缩略图；点击即可立即切换。

### 方法二：从 GitHub 一键安装

菜单栏选择 **🐾 → 宠物 → 从 GitHub 安装宠物…**，在输入框中填写预设名称或支持格式的 GitHub 仓库 URL。

也可以执行一条命令：

```bash
./allpet pet install cc-haha
./allpet pet install clawd-on-desk
./allpet pet install lingchat
```

查看全部可选项：

```bash
./allpet pet list
```

切换已安装宠物：

```bash
./allpet pet set "搭搭"
./allpet pet set cloudling
```

如果 GUI 已在运行，命令行更换后执行 `./allpet restart`。

### 方法三：导入本地宠物

菜单栏选择 **🐾 → 宠物 → 导入本地宠物…**，或执行：

```bash
./allpet pet import "/本地/宠物路径"
```

| 来源 | AllPet 读取方式 |
|---|---|
| Codex / OpenPets | `pet.json` + 8×9 或 8×11 PNG/WebP 图集 |
| cc-haha | 自动读取仓库中的 V2 `spritesheet.webp`，一次导入多个宠物 |
| clawd-on-desk | `theme.json` + GIF/SVG 状态素材 |
| LingChat | `settings.yml` + `avatar/` 表情素材 |
| 本地单图 | 兼容的 single-image `pet.json` |

GitHub 素材只会克隆到用户电脑的 `~/.config/all-pet/pet-sources/`，不会打包进 AllPet 仓库。第三方角色和素材仍遵守原项目许可。

### 方法四：Windows / Linux（Electron 壳）

macOS 之外，跨平台 Electron 壳提供同一套图形化宠物管理：

```bash
cd desktop
npm ci
npm start
```

在系统托盘中打开 **宠物管理…**，即可图形化地切换 / 安装 / 导入 / 删除宠物（含缩略图与默认宠物一键下载）。

## 制作你自己的宠物（宠物生成标准包）

[`宠物生成标准包/`](./宠物生成标准包/README.md) 是一套自包含的「自制宠物」工具包：从设计角色 → 用文生图 prompt 模板生成 9 个状态 + 16 个视线方向 → 用 Python 脚本拼成标准 1536×2288（8×11）精灵图并校验、打包，最终得到一个 `pet.json` + `spritesheet.webp` 文件夹，`./allpet pet import` 即可加载。

```bash
cd 宠物生成标准包/example
python3 make_demo.py        # 生成一只示例宠物并跑通整套脚本
```

完整流程见 [`宠物生成标准包/README.md`](./宠物生成标准包/README.md)（依赖：Python 3.9+ 与 Pillow）。

## 任务气泡

气泡有三层：

1. **收起**：显示平台概况；
2. **平台**：选择 Codex、Claude、DSH 或 Grok；
3. **会话**：选择具体会话并唤起原任务。

标题只显示稳定的**会话名称**，当前动作和进度显示在副标题中。

- 点击窗口外部回到收起状态；
- 每个任务气泡右上角可以关闭；
- 完成或失败任务在成功唤起后自动消失；
- 用户自己手动打开已完成任务时，对应气泡也会消失。

## 唤起与强唤起

- **唤起**：程序仍在运行，只聚焦此前打开的原任务。
- **强唤起**：程序已经关闭；经用户确认后重新打开程序，并定位到原任务。

Claude 强唤起会让用户选择 **Claude Desktop / Claude CLI / 取消**。Desktop 只打开已有 `/epitaxy/<local-id>` 原任务，不使用会创建副本的 `claude://resume`；打开失败后会回到选择界面。

终端类任务优先复用原 Terminal / iTerm 标签页；没有用户确认时不会新建终端或执行 resume。

## 状态从哪里来

AllPet 读取各平台已经保存在本机的会话日志，不需要账号密码或额外 API：

| 平台 | 默认数据位置 |
|---|---|
| Codex | `~/.codex/sessions` |
| Claude Code | `~/.claude/projects` |
| DSH | `~/.dsh/sessions` |
| Grok | `~/.grok/logs/unified.jsonl`、`active_sessions.json` |

日志中的任务事件优先决定状态；没有明确事件时，再根据最近写入时间判断运行、等待或空闲。扫描、缓存和 zstd 解压都在后台进行，不影响宠物动画。

## 配置

配置文件：`~/.config/all-pet/config.json`，示例见 [`config.example.json`](./config.example.json)。

```json
{
  "pet": {
    "enabled": true,
    "scale": 0.5833333333,
    "anchor": "bottom-right",
    "bundlePath": null
  }
}
```

- `scale`：宠物大小；
- `anchor`：`bottom-right`、`bottom-left`、`top-right` 或 `top-left`；
- `bundlePath`：当前宠物目录；通常不需要手动修改，菜单和 `pet set` 会自动保存。

## 打包安装包

打一个 `v*` tag 即会构建三平台安装包并发布到 GitHub Releases：

```bash
git tag -a v1.3.0 -m "AllPet v1.3.0"
git push origin v1.3.0
```

`Release` 工作流会先构建 Swift 核心、作为 Electron sidecar 内嵌，再在 macOS / Windows / Linux 上运行 electron-builder。也可以在 Actions 页面手动触发（只出产物、不发布 Release）。本地打包见 [`desktop/README.md`](./desktop/README.md)。

## 常见问题

### 点击任务无法定位

在“系统设置 → 隐私与安全性 → 辅助功能”中允许 AllPet / Terminal 控制窗口。浏览器还需要允许 Apple Events / JavaScript 自动化。

### DSH 只显示时间，没有任务内容

```bash
brew install zstd
```

### 查看问题

```bash
./allpet self-test
./allpet logs
```

日志位于 `~/.config/all-pet/allpet.log`。

## 许可

AllPet 使用 MIT License。开源参考与第三方许可说明见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

项目参考：[openpets](https://github.com/alterhq/openpets)、[codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet)。cc-haha、clawd-on-desk 和 LingChat 仅作为用户主动安装的格式来源，素材不随本仓库分发。
