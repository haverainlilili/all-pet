> [English](./README.md) · 中文

# AllPet 🐾

一只 AI 编码桌面宠物，同时查看 **Codex、Claude Code / Desktop、DeepSeek Harness（DSH）、Grok、Cursor、WorkBuddy、Qoder、pi 和 Z Code** 的任务状态。原生宠物 GUI 仅 macOS；跨平台 Electron 壳（`desktop/`）可在 macOS / Linux / Windows 显示宠物并提供图形化宠物管理。核心监控与 `status`/`watch` 等 CLI 支持全平台。

宠物根据运行、等待、完成和失败状态切换动画；点击任务气泡尝试返回原会话或打开对应应用，具体定位能力因平台而异。

[完整功能设计说明](./docs/功能设计说明.md)：记录当前实现、交互规则、平台差异与验收结果。

## v1.4.0 更新

新增 Cursor、WorkBuddy、Qoder、pi coding agent、智谱 Z Code；菜单中可逐个平台显示或隐藏气泡。macOS 勾选平台后菜单保持展开，可连续调整。

九个平台的完成/失败气泡现在点击即确认并保存，定位失败也不会恢复。macOS Electron 补齐手动查看检测，但各平台能力不同，见下表。

[版本记录](./CHANGELOG.md) · [平台接入说明](./docs/平台接入说明.md) · [平台行为与验收边界](./docs/平台行为验收.md)

多个编码工具同时运行时，AllPet 将它们的进度和完成通知放在同一个桌面入口。

## 快速开始

### 下载安装包（推荐）

从 [GitHub Releases](https://github.com/haverainlilili/all-pet/releases) 下载最新版本：

- **macOS** — `AllPet-<版本>-arm64.dmg`
- **Windows** — `AllPet-Setup-<版本>.exe`
- **Linux** — `AllPet-<版本>.AppImage` 或 `allpet-desktop_<版本>_amd64.deb`

安装包包含 Swift 核心、运行时与 5 个内置宠物，无需安装 Node.js / Swift。v1.4.0 修复旧版 macOS ZIP 遗漏资源的问题。macOS 包使用 ad-hoc 签名，尚无 Developer ID 签名或 Apple 公证，首次启动可能被 Gatekeeper 阻止；请从可信的 Release 下载，并按系统“隐私与安全性”中的提示确认打开。

### 选择正确安装包（供用户与 AI 直接判断）

**当前稳定版：v1.4.0。** 请同时按“系统 + CPU 架构”选择；下表是可直接下载的产物链接，AI 助手可直接返回对应链接，不需要让用户自行翻找 Release 页面。

| 设备 | 架构 / 适用型号 | 直接下载 | 适用场景 |
| --- | --- | --- | --- |
| macOS 14+ | **Apple Silicon arm64**：M1 / M2 / M3 / M4 / M5 | [DMG：AllPet-1.4.0-arm64.dmg](https://github.com/haverainlilili/all-pet/releases/download/v1.4.0/AllPet-1.4.0-arm64.dmg) · [ZIP](https://github.com/haverainlilili/all-pet/releases/download/v1.4.0/AllPet-1.4.0-arm64-mac.zip) | Apple M 系列芯片的 Mac |
| Windows 10 / 11 | **x64**：64 位 Intel / AMD | [EXE：AllPet-Setup-1.4.0.exe](https://github.com/haverainlilili/all-pet/releases/download/v1.4.0/AllPet-Setup-1.4.0.exe) | 常见 Intel / AMD Windows 电脑 |
| Linux（大多数 x64 发行版） | **x64**：64 位 Intel / AMD | [AppImage：AllPet-1.4.0.AppImage](https://github.com/haverainlilili/all-pet/releases/download/v1.4.0/AllPet-1.4.0.AppImage) | 大多数 x64 Linux，免安装便携使用 |
| Debian / Ubuntu Linux | **x64**：64 位 Intel / AMD | [DEB：allpet-desktop_1.4.0_amd64.deb](https://github.com/haverainlilili/all-pet/releases/download/v1.4.0/allpet-desktop_1.4.0_amd64.deb) | Debian / Ubuntu 及其兼容发行版 |

**当前未提供预编译包：** Intel Mac（`x86_64`）、Windows on ARM、Linux ARM（`aarch64`）。这些环境请从源码构建，或欢迎贡献对应打包支持。

> **给 AI / 自动化工具的选择规则：** 先询问系统和 CPU 架构。Apple M 系列 Mac 返回 DMG；常见 Intel/AMD Windows 返回 EXE；Debian/Ubuntu x64 返回 DEB；其它 x64 Linux 返回 AppImage。不要把 arm64 macOS 安装包推荐给 Intel Mac。

> **适配说明与贡献邀请：** 当前 **macOS 的适配和实测覆盖最好**，包含原生 AppKit GUI 与更完整的任务定位能力。Windows / Linux 安装包已支持，但会受不同桌面环境影响更多；若你发现 Windows 或 Linux 在显示、托盘、透明窗口、任务唤起或监控方面有问题，欢迎直接提交 PR，维护者会优先审查并合入可合并的修复。

### 安装包更新与最新源码的区别

**不是每次提交都必须重新发布安装包**，两种跟进方式不同：

- **`main` 分支 = 最新开发源码。** 能自行构建的用户可在修复合入后立即执行 `git pull --ff-only`，重新构建/重启即可跟进，不必等待下一个安装包。
- **`vX.Y.Z` 标签 / GitHub Release = 稳定预编译安装包。** 通过 DMG / EXE / AppImage / DEB 安装的用户，运行的是打包时包含的代码；后续提交不会自动进入已经安装的程序。
- **代码修复要让安装包用户生效，就必须再构建一个新版本。** 普通修复可合并积累后发布补丁版（例如 `v1.4.1`）；严重兼容性或安全问题应尽快单独打包。仅 README/说明文档变化不需要重新打包。
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

AllPet 内置 5 个开箱即用宠物（Boba、Tiko、团团和米粒、Hoops、西瓜）；其余默认宠物首次点击时下载。

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

在系统托盘中打开 **宠物管理…**，即可图形化地切换 / 安装 / 删除标准宠物包（本地多格式导入仅 macOS）（含缩略图与默认宠物一键下载）。

## 制作你自己的宠物（宠物生成标准包）

[`宠物生成标准包/`](./宠物生成标准包/README.md) 是一套自包含的「自制宠物」工具包：从设计角色 → 用文生图 prompt 模板生成 9 个状态 + 16 个视线方向 → 用 Python 脚本拼成标准 1536×2288（8×11）精灵图并校验、打包，最终得到一个 `pet.json` + `spritesheet.webp` 文件夹，`./allpet pet import` 即可加载。

```bash
cd 宠物生成标准包/example
python3 make_demo.py        # 生成一只示例宠物并跑通整套脚本
```

完整流程见 [`宠物生成标准包/README.md`](./宠物生成标准包/README.md)（依赖：Python 3.9+ 与 Pillow）。

## 任务气泡与点击表现

1. 收起态显示概况；点击后显示平台列表。
2. 选择九个平台之一；有多个任务时进入会话列表，单任务时直接尝试唤起。
3. 点击具体任务：完成/失败卡片立即移除并保存确认状态，然后尝试定位；正在运行、思考或等待的卡片继续保留。

标题显示稳定会话名，副标题显示当前动作与进度。点击 × 可关闭通知；未确认的终态最多保留 24 小时。新一轮真实活动会重新显示。仅凭短 ID 不判断是假任务；有明确来源证据的内部子代理会被过滤。

菜单 **气泡显示平台** 支持逐个平台、全部显示和全部隐藏；只改变气泡可见性，保留后台监控和历史。macOS 菜单在勾选后保持展开，Esc 或点击外部关闭。Windows/Linux 采用系统托盘菜单行为。

| 手动进入原任务后的自动消泡 | macOS Electron 能力 |
|---|---|
| Codex | 同账号/本地主机的未读→已读回执，或前台唯一任务标题匹配；标题检测需要辅助功能权限 |
| Claude | Desktop 前台精确会话地址/焦点时间；CLI 需原终端绑定 |
| DSH | 前台浏览器当前标签页的精确 sessionId；需要浏览器自动化权限 |
| Grok、pi | 前台 Terminal/iTerm 的有效原 TTY；pi 默认日志缺少 TTY 时无法自动确认 |
| Cursor、WorkBuddy、Qoder、Z Code | 尚未实现可靠的手动查看识别；可点击气泡或 × 确认 |

macOS 每 500 ms 独立调度各平台检测，权限、定位证据或前台身份不确定时保留通知。该间隔不是所有环境下“2 秒内消泡”的保证；Windows/Linux 尚无同等手动查看检测。详见 [验收记录](./docs/平台行为验收.md)。

## 返回原任务

- Codex Desktop 尝试任务深链；系统接受深链不代表已验证页面显示。
- Claude Desktop 激活已有应用，必要时由用户在侧栏选择；不会通过导入/恢复创建副本。
- DSH 尝试定位原会话；终端任务在能力与绑定允许时复用原标签页。原生 macOS 的 CLI 强唤起需用户确认。
- Cursor、WorkBuddy、Qoder、Z Code 目前主要打开应用，由用户选择会话；pi 不会自动启动重复任务。

气泡消失表示这条通知已确认，不表示任务定位一定成功。具体差异见 [平台接入说明](./docs/平台接入说明.md)。

## 状态从哪里来

AllPet 读取各平台已经保存在本机的会话日志，不需要账号密码或额外 API：

| 平台 | 默认数据位置 |
|---|---|
| Codex | `~/.codex/sessions` |
| Claude Code | `~/.claude/projects` |
| DSH | `~/.dsh/sessions` |
| Grok | `~/.grok/logs/unified.jsonl`、`~/.grok/active_sessions.json` |
| Cursor | `~/.cursor/projects` |
| WorkBuddy | `~/.workbuddy/projects` |
| Qoder | `~/.qoder/projects` |
| pi | `~/.pi/agent/sessions` |
| Z Code | `~/.zcode/cli/db/db.sqlite` |

日志中的任务事件优先决定状态；没有明确事件时，再根据最近写入时间判断运行、等待或空闲。扫描、缓存和 zstd 解压都在后台进行，不影响宠物动画。

Cursor/Qoder 可通过菜单安装观察 hooks，以补充完整生命周期；安装时合并、备份原有配置，不保存提示词正文。接入命令见 [平台接入说明](./docs/平台接入说明.md)。

## 配置

配置文件：`~/.config/all-pet/config.json`，示例见 [`config.example.json`](./config.example.json)。

```json
{
  "pet": {
    "enabled": true,
    "scale": 0.5833333333,
    "anchor": "bottom-right",
    "bundlePath": null
  },
  "hiddenBubblePlatforms": []
}
```

- `scale`：宠物大小；
- `anchor`：`bottom-right`、`bottom-left`、`top-right` 或 `top-left`；
- `bundlePath`：当前宠物目录；通常不需要手动修改，菜单和 `pet set` 会自动保存。

- `hiddenBubblePlatforms`：隐藏的气泡平台键，例如 `["grok", "pi"]`；位于配置顶层。

## 打包安装包

版本号位于 `desktop/package.json` 与 `desktop/package-lock.json`。先更新版本、文档并通过 CI，再推送对应的 `vX.Y.Z` tag（本版为 `v1.4.0`）。

Release 工作流验证版本号，构建 Swift 核心和资源，运行行为/接入测试，再生成 macOS arm64 DMG/ZIP、Windows x64 EXE、Linux x64 AppImage/DEB。tag 构建上传到 Release 草稿；确认三平台成功、校验安装包与 SHA256SUMS 后再公开。手动触发只生成 Actions 产物。

本地构建与签名命令见 [desktop/README.md](./desktop/README.md)。当前没有自动更新，升级需下载新安装包。

## 常见问题

### 点击任务无法定位，或手动查看后通知仍在

先核对上方能力表。需要窗口识别时，在“系统设置 → 隐私与安全性 → 辅助功能”中添加并开启当前安装的 AllPet；浏览器可能还需要 Apple Events / JavaScript 自动化。权限无法由应用代替用户授予。

如果升级后开关开启但仍无效，确认列表中的 AllPet 是当前安装路径；必要时移除旧条目再添加新包。诊断文件 `~/.config/all-pet/manual-view-status.json` 的 `updatedAt` 必须是新回执，`hostAccessibilityTrusted` 与 `accessibilityTrusted` 才能反映本次授权。无完成候选时旧诊断不会持续刷新。

### DSH 只显示时间，没有内容

Electron 包含 zstd 解码器；独立 AppKit/CLI 在缺少系统解码器时可安装 `zstd`（macOS：`brew install zstd`）。

### 查看问题

```bash
./allpet self-test
./allpet logs
```

日志位于 `~/.config/all-pet/allpet.log`。

## 许可

AllPet 使用 MIT License。开源参考与第三方许可说明见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

项目参考：[openpets](https://github.com/alterhq/openpets)、[codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet)。cc-haha、clawd-on-desk 和 LingChat 仅作为用户主动安装的格式来源，素材不随本仓库分发。
