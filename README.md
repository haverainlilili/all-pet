# AllPet 🐾

**One desktop pet that watches all your AI coding agents — Codex, Claude Code / Desktop, DeepSeek Harness (DSH), Grok, Cursor, WorkBuddy, Qoder, pi and Z Code — with a cross-platform status / watch CLI.**

> The native pet GUI is macOS; the cross-platform Electron shell (`desktop/`) shows the pet plus a graphical pet manager on macOS, Linux, and Windows. Core monitoring and the `status` / `watch` CLI build and run everywhere.

The pet switches animation based on what your agents are doing — idle, running, waiting, done, failed — and task bubbles attempt to open the originating session or application, with platform-specific navigation limits.

[中文文档](./README.zh-CN.md) · English

[Detailed functional design (中文)](./docs/功能设计说明.md) — current implementation, interaction rules, platform differences, and verification record.

---


## 开发版：统一菜单与终端定位（尚未发布）

三平台 Electron 共用 Mac 风格级联菜单。悬停或点击打开子菜单；平台开关、全部显示/隐藏、大小和宠物切换持续保持打开；Esc、点击外部或打开另一个窗口时关闭。macOS 的系统识别桥接在后台运行，不再额外创建菜单栏图标。

Electron 已接入运行期间的终端绑定、点击定位和每 500 ms 的查看检查。各终端的条件与限制见 [终端接入说明](desktop/integrations/README.md)：VS Code/Cursor 需要扩展，WezTerm 需要 Lua 接入，kitty 需要本地控制 socket，Linux 部分路径依赖辅助功能或 X11。接口存在不等于所有版本均已实测，也不构成无条件两秒内确认的保证。

下面 v1.4.1 的下载链接仍对应已发布的旧版本，不包含本节新增能力。


## What's new in v1.4.1

Windows/Linux now use a persistent tray panel: left or right click opens it; provider checkboxes, inline size controls, and pet selection stay open for repeated clicks. Pet rows include thumbnails. Outside focus or Escape closes the panel. macOS keeps its native menu.

Local CLI logs, including Codex CLI, can produce task bubbles. The Electron app does not yet fully support returning to the original terminal tab or automatically acknowledging a CLI task when that tab is viewed. See [terminal support and limits](docs/终端CLI支持说明.md).

### v1.4.0 foundation

Five new providers, persistent per-platform bubble visibility, immediate acknowledgement of completed notifications, and macOS manual-view detection improvements.

[Changelog](./CHANGELOG.md) · [Provider setup](./docs/平台接入说明.md) · [Behavior and validation limits](./docs/平台行为验收.md)

AllPet brings progress and completion notifications from several coding tools into one desktop view.

## Features

- **One pet, nine platforms** — reads local state for Codex, Claude, DSH, Grok, Cursor, WorkBuddy, Qoder, pi and Z Code. Cursor/Qoder include opt-in observer hooks for complete lifecycle events.
- **Live state animation** — the pet switches between idle / running / waiting / done / failed as tasks progress.
- **Task bubbles** — three levels (summary → platform → session); each platform uses its own brand colors.
- **Safe task wake** — verified Codex Desktop sessions use a deep-link handoff; unsupported CLI/Claude/Grok targets fail closed instead of duplicating work, and DSH task links carry the exact session ID.
- **Cross-platform CLI** — `status` / `watch` build on macOS, Linux, and Windows; the AppKit-dependent full `self-test` currently runs on macOS.
- **Cross-platform desktop shell** — an Electron shell (`desktop/`) shows the pet and a graphical pet manager on Windows, Linux, and macOS; local multi-format conversion is currently macOS-only, while standard package install/switch/delete works across platforms.
- **Bring your own pet** — install standard packages from GitHub on every supported OS; macOS can additionally import and normalize local Codex / OpenPets / cc-haha / clawd-on-desk / LingChat / single-image pets.
- **Pet Authoring Kit** — a guided kit ([`宠物生成标准包/`](./宠物生成标准包/README.md)) to make a pet from scratch: a character design guide, per-state text-to-image prompt templates, and Python scripts that assemble / validate / package a standard 8×11 spritesheet into an importable `pet.json` + `spritesheet.webp`.

## Quick start

### Download an installer (recommended)

Grab the latest from [GitHub Releases](https://github.com/haverainlilili/all-pet/releases):

- **macOS** — `AllPet-<version>-arm64.dmg`
- **Windows** — `AllPet-Setup-<version>.exe`
- **Linux** — `AllPet-<version>.AppImage` or `allpet-desktop_<version>_amd64.deb`

Installers bundle the Swift core, runtime and five built-in pets; no Node.js or Swift installation is required. v1.4.0 fixes the missing resources in the old macOS ZIP. macOS packages are ad-hoc signed, without Developer ID signing or Apple notarization. Gatekeeper may block the first launch; use a trusted Release download and follow macOS Privacy & Security prompts.

### Choose the correct installer — humans and AI agents

**Latest stable release: v1.4.1.** Match both the operating system and CPU architecture exactly. These are direct asset URLs, so an AI assistant can return the one matching download link without asking users to browse the release page.

| User device | Architecture / supported models | Download | Choose this when |
| --- | --- | --- | --- |
| macOS 14+ | **Apple Silicon arm64** — M1 / M2 / M3 / M4 / M5 | [DMG — AllPet-1.4.1-arm64.dmg](https://github.com/haverainlilili/all-pet/releases/download/v1.4.1/AllPet-1.4.1-arm64.dmg) · [ZIP](https://github.com/haverainlilili/all-pet/releases/download/v1.4.1/AllPet-1.4.1-arm64-mac.zip) | Mac with an Apple M-series chip |
| Windows 10 / 11 | **x64** — Intel 64-bit / AMD 64-bit | [EXE — AllPet-Setup-1.4.1.exe](https://github.com/haverainlilili/all-pet/releases/download/v1.4.1/AllPet-Setup-1.4.1.exe) | Typical Intel / AMD Windows PC |
| Linux — most x64 distributions | **x64** — Intel 64-bit / AMD 64-bit | [AppImage — AllPet-1.4.1.AppImage](https://github.com/haverainlilili/all-pet/releases/download/v1.4.1/AllPet-1.4.1.AppImage) | Portable install on most x64 Linux distributions |
| Debian / Ubuntu Linux | **x64** — Intel 64-bit / AMD 64-bit | [DEB — allpet-desktop_1.4.1_amd64.deb](https://github.com/haverainlilili/all-pet/releases/download/v1.4.1/allpet-desktop_1.4.1_amd64.deb) | Debian / Ubuntu and compatible distributions |

**Not packaged yet:** Intel Mac (`x86_64`), Windows on ARM, and Linux ARM (`aarch64`) do not currently have ready-made installers. Build from source or contribute a package build.

> **AI / automation rule:** ask for OS and CPU architecture. For an Apple M-series Mac return the DMG link; for a typical Intel/AMD Windows PC return the EXE; for Debian/Ubuntu x64 return DEB; otherwise for x64 Linux return AppImage. Do not recommend the arm64 macOS package for an Intel Mac.

> **Platform maturity:** macOS currently has the best adaptation and test coverage, including the native AppKit GUI and richer task-focus behavior. Windows and Linux installers are supported, but they use the Electron shell and have more OS/desktop-environment differences. If you find a Windows or Linux display, tray, transparency, task-wake, or monitoring problem, please submit a PR — the maintainer welcomes and will review mergeable fixes.

### Releases vs. the newest source code

Not every commit needs a new installer release:

- **`main` branch = newest development source.** Source users can follow every merged fix immediately with `git pull --ff-only`, then rebuild/restart the app.
- **`vX.Y.Z` tag / GitHub Release = stable prebuilt installers.** People using DMG / EXE / AppImage / DEB keep running the code bundled in that installer; later commits do not enter an already-installed app automatically.
- **Code changes require a new build to affect installer users.** Routine fixes can be collected into a patch release such as `v1.4.1`; urgent compatibility/security fixes should be packaged promptly. README-only changes do not require repackaging.
- **No automatic updater is enabled yet.** Installer users should watch [GitHub Releases](https://github.com/haverainlilili/all-pet/releases) and download the next version when published.

Latest source: [download `main` as ZIP](https://github.com/haverainlilili/all-pet/archive/refs/heads/main.zip), or update a clone:

```bash
git pull --ff-only
./allpet restart          # macOS native GUI / CLI: rebuild and restart
```

For the cross-platform Electron shell, rebuild the Swift sidecar and run/package `desktop/` as documented in [`desktop/README.md`](./desktop/README.md). AI assistants should recommend a stable Release to normal users and `main` only to users who explicitly want the newest source and can build it.

### 平台说明（Windows / Linux）

Electron 壳在三个平台共享气泡、拖拽、缩放和标准宠物包管理代码，但仍受操作系统、桌面环境和底层导入能力限制：

- **透明窗口**：Windows / macOS 原生支持；Linux 需要桌面合成器（compositor，Wayland 或带合成器的 X11），无合成器时宠物背景会显示为黑色。
- **托盘图标**：Windows / macOS 原生支持；Linux 的 GNOME 默认无系统托盘，需安装 AppIndicator 扩展（KDE / XFCE 等桌面自带）。
- **全空间置顶**：仅 macOS / Linux 支持「所有工作区可见」，Windows 无此概念（自动跳过）。
- **任务唤醒**：仅来源明确的 Codex Desktop 会话尝试 `codex://` 深链；CLI、Claude 和 Grok 在没有安全精确定位能力时 fail-closed，DSH 任务链接携带精确 session ID，但不把浏览器接受链接当作页面已定位的证明。
- **本地导入**：AppKit/ImageIO 多格式转换目前仅 macOS 可用；Windows/Linux 入口会明确禁用，但仍可安装标准宠物包。
- **原生 GUI**：仅 macOS 提供 AppKit GUI；Windows/Linux 使用 Electron 壳 + Swift core sidecar。两者的可移植行为对齐，原生托盘自定义视图、Spaces 和精确终端会话聚焦仍按平台降级（见 `docs/macOS-behavior.md`）。

### Build from source

Requirements: the native GUI needs macOS 14+ with Xcode Command Line Tools. The `status` / `watch` / `help` / `pet list` CLI builds and runs on Linux (Swift 5.10+) and Windows (verified with the `swift:latest` Docker image on Linux).

```bash
git clone git@github.com:haverainlilili/all-pet.git
cd all-pet
./allpet
```

The first launch builds automatically; afterwards just run `./allpet` again.

```bash
./allpet status       # current task state
./allpet restart      # rebuild and restart
./allpet stop         # stop the pet
./allpet logs         # view logs
./allpet self-test    # run built-in checks
```

## Changing the pet

AllPet ships with 5 built-in pets (Boba, Tiko, 团团和米粒, Hoops, 西瓜). Other default pets download on first click.

### Option 1: menu (easiest)

1. Click the **🐾** in the macOS menu bar.
2. Open **Pet**.
3. Every installed pet shows a thumbnail; click to switch instantly.

### Option 2: install from GitHub

Choose **🐾 → Pet → Install pet from GitHub…** and enter a preset name or a compatible repository URL. Or run:

```bash
./allpet pet install cc-haha
./allpet pet install clawd-on-desk
./allpet pet install lingchat
```

List everything available:

```bash
./allpet pet list
```

Switch an installed pet:

```bash
./allpet pet set "搭搭"
./allpet pet set cloudling
```

If the GUI is already running, run `./allpet restart` after switching.

### Option 3: import a local pet

Choose **🐾 → Pet → Import local pet…**, or run:

```bash
./allpet pet import "/path/to/pet"
```

| Source | How AllPet reads it |
|---|---|
| Codex / OpenPets | `pet.json` + 8×9 or 8×11 PNG/WebP atlas |
| cc-haha | reads the repo's V2 `spritesheet.webp`, imports multiple pets at once |
| clawd-on-desk | `theme.json` + GIF/SVG state assets |
| LingChat | `settings.yml` + `avatar/` expression assets |
| Local single image | a compatible single-image `pet.json` |

GitHub assets are cloned only into your local `~/.config/all-pet/pet-sources/` — never bundled into the AllPet repo. Third-party characters and assets remain under their original licenses.

## Make your own pet (Pet Authoring Kit)

[`宠物生成标准包/`](./宠物生成标准包/README.md) is a self-contained kit for creating a pet from scratch (currently documented in Chinese). It guides you through: designing a character → generating the 9 states + 16 look directions with text-to-image prompt templates → assembling, validating, and packaging a standard 1536×2288 (8×11) spritesheet with Python scripts — ending in a `pet.json` + `spritesheet.webp` folder you import with `./allpet pet import`.

```bash
cd 宠物生成标准包/example
python3 make_demo.py        # 生成一只示例宠物并跑通整套脚本
```

See [`宠物生成标准包/README.md`](./宠物生成标准包/README.md) for the full workflow (requirements: Python 3.9+ with Pillow).

## Task bubbles and click behavior

1. Click the collapsed summary to view platforms.
2. Select one of nine platforms; multiple tasks open a session list, while a single task attempts navigation directly.
3. Click a completed/failed task to acknowledge it immediately and persist that decision, then attempt navigation. Running/thinking/waiting tasks remain visible.

Titles show stable session names; subtitles show current actions and progress. The × button closes a notification. Unacknowledged terminal tasks expire after 24 hours; new task activity can appear again. Internal subagents are filtered using explicit source evidence, not merely short IDs.

The tray's platform visibility controls hide individual or all platforms while preserving monitoring and history. On macOS, checkboxes keep the menu open for consecutive changes; Esc or an outside click closes it. The development Electron build uses the same persistent cascading menu on all three systems.

| Manual viewing of a completed task | macOS Electron support |
|---|---|
| Codex | Same-account/local-host unread→read receipt, or a unique foreground task title; title detection needs Accessibility |
| Claude | Exact foreground Desktop conversation address/focus timestamp, or a valid original CLI terminal binding |
| DSH | Exact sessionId in the frontmost browser tab; browser automation permission required |
| Grok / pi | Development build: captured terminal identity and exact foreground tab/pane; see the terminal adapter matrix |
| Cursor / WorkBuddy / Qoder / Z Code | Reliable detection not implemented; acknowledge with a bubble click or × |

Checks run independently every 500 ms on macOS. Missing permissions or uncertain identity retain notifications; this is not an unconditional two-second guarantee. The development build also detects supported CLI terminals on Windows/Linux; GUI conversation detection remains platform-specific. See the [validation record](./docs/平台行为验收.md).

## Returning to a task

Codex Desktop uses a task deep link, but acceptance does not prove the target page is visible. Claude Desktop activates the existing app; select the task in its sidebar when needed. DSH attempts the original session. Terminal targets reuse existing tabs where supported; native macOS CLI resume requires confirmation.

Cursor, WorkBuddy, Qoder and Z Code currently open the application for manual session selection. pi never automatically starts a duplicate task. A dismissed bubble means the notification was acknowledged, not that navigation succeeded. See [provider-specific limits](./docs/平台接入说明.md).

## Where the state comes from

AllPet reads session logs already stored locally by each platform — no passwords or extra APIs:

| Platform | Default data location |
|---|---|
| Codex | `~/.codex/sessions` |
| Claude Code | `~/.claude/projects` |
| DSH | `~/.dsh/sessions` |
| Grok | `~/.grok/logs/unified.jsonl`, `~/.grok/active_sessions.json` |
| Cursor | `~/.cursor/projects` |
| WorkBuddy | `~/.workbuddy/projects` |
| Qoder | `~/.qoder/projects` |
| pi | `~/.pi/agent/sessions` |
| Z Code | `~/.zcode/cli/db/db.sqlite` |

Explicit task events in the logs win; when there is no clear event, AllPet falls back to recent-write time to infer running / waiting / idle. Scanning, caching, and zstd decompression all run in the background so the pet animation never stutters.

Cursor/Qoder provide opt-in observer hooks for lifecycle events. Installation merges and backs up existing configuration without storing prompt text. See [setup commands](./docs/平台接入说明.md).

## Configuration

Config file: `~/.config/all-pet/config.json` (see [`config.example.json`](./config.example.json)).

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

- `scale` — pet size;
- `anchor` — `bottom-right`, `bottom-left`, `top-right`, or `top-left`;
- `bundlePath` — current pet directory; usually you don't need to set it — the menu and `pet set` save it automatically.

- `hiddenBubblePlatforms` — top-level list of hidden provider keys, e.g. `["grok", "pi"]`.

## Packaging installers

Update the version in `desktop/package.json` and `desktop/package-lock.json`, update documentation, and pass CI before pushing a matching `vX.Y.Z` tag (`v1.4.0` for this release).

The Release workflow checks the tag, builds the Swift core and resources, runs behavior/provider checks, and packages macOS arm64 DMG/ZIP, Windows x64 EXE, and Linux x64 AppImage/DEB. Tag builds upload to a draft Release. Verify all three builds, installer contents and SHA256SUMS before publishing. Manual workflow runs only produce Actions artifacts.

See [desktop build instructions](./desktop/README.md). Automatic updates are not enabled.

## FAQ

### Navigation or manual acknowledgement does not work

Check the support table first. For window detection, add the currently installed AllPet in macOS System Settings → Privacy & Security → Accessibility. Browsers may also require Apple Events / JavaScript automation.

After an upgrade, a stale permission entry may reference an older app. Remove that entry and add the current installation if needed. In `~/.config/all-pet/manual-view-status.json`, check a fresh `updatedAt` together with `hostAccessibilityTrusted` and `accessibilityTrusted`; an old diagnostic is not evidence of current authorization. Without completed candidates, diagnostics may not refresh continuously.

### DSH has no task content

Electron includes a zstd decoder. Standalone AppKit/CLI users may need a system decoder (`brew install zstd` on macOS).

### Debugging

```bash
./allpet self-test
./allpet logs
```

Logs live at `~/.config/all-pet/allpet.log`.

## License

MIT. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for open-source references and third-party notices.

Built with reference to [openpets](https://github.com/alterhq/openpets) and [codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet). cc-haha, clawd-on-desk, and LingChat are only install-time format sources; their assets are not distributed with this repository.
