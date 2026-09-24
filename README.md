# AllPet 🐾

**One desktop pet that watches all your AI coding agents — Codex, Claude Code / Desktop, DeepSeek Harness (DSH), and Grok — with a cross-platform status / watch CLI.**

> The native pet GUI is macOS; the cross-platform Electron shell (`desktop/`) shows the pet plus a graphical pet manager on macOS, Linux, and Windows. Core monitoring and the `status` / `watch` CLI build and run everywhere.

The pet switches animation based on what your agents are doing — idle, running, waiting, done, failed — and each task bubble lets you jump straight back into the originating session.

[中文文档](./README.zh-CN.md) · English

---

## Why one pet for all these platforms?

What you actually use every day is not "a model" — it's a **harness × model** combination. The harness decides what context the model sees, which tools it gets, and when it retries or wraps up. The same model behind a different harness can produce very different results:

- The same **Claude Sonnet 4.6** scores ~71% on SWE-bench Verified inside Claude Code, but only ~52% behind the Continue shell. ([TensorFeed](https://tensorfeed.ai/harnesses))
- The same **Claude Opus 4.5** scores 45.9% under the unified SEAL scaffold, and 55.4% back in its own Claude Code. ([arXiv 2605.23950](https://arxiv.org/html/2605.23950))
- The same **Grok 4** scores 58.6% under a generic SWE-agent, and 72–75% with xAI's own scaffold. ([arXiv 2605.23950](https://arxiv.org/html/2605.23950))

The pattern is consistent: **each model is strongest inside its own harness.** So "Claude in Claude Code, GPT in Codex, Grok in Grok" is the everyday reality — which is exactly why AllPet watches Codex, Claude Code, DSH, and Grok at the same time.

## Features

- **One pet, four platforms** — natively reads Codex, Claude Code / Desktop, DSH, and Grok task state from your local session logs (no accounts, no API keys).
- **Live state animation** — the pet switches between idle / running / waiting / done / failed as tasks progress.
- **Task bubbles** — three levels (summary → platform → session); each platform uses its own brand colors.
- **Safe task wake** — verified Codex Desktop sessions use a deep-link handoff; unsupported CLI/Claude/Grok targets fail closed instead of duplicating work, and DSH can explicitly open its base page.
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

Current-source packaging bundles the Swift core, runtime closure, and built-in pet resources, so no Node.js or Swift installation is needed. The published v1.3.0 macOS ZIP has a known missing-resource defect that is fixed on `main` but not retroactively; macOS builds are currently unsigned, so use right-click → Open on first launch.

### Choose the correct installer — humans and AI agents

**Latest stable release: v1.3.0.** Match both the operating system and CPU architecture exactly. These are direct asset URLs, so an AI assistant can return the one matching download link without asking users to browse the release page.

| User device | Architecture / supported models | Download | Choose this when |
| --- | --- | --- | --- |
| macOS 14+ | **Apple Silicon arm64** — M1 / M2 / M3 / M4 / M5 | [DMG — AllPet-1.3.0-arm64.dmg](https://github.com/haverainlilili/all-pet/releases/download/v1.3.0/AllPet-1.3.0-arm64.dmg) · [ZIP](https://github.com/haverainlilili/all-pet/releases/download/v1.3.0/AllPet-1.3.0-arm64-mac.zip) | Mac with an Apple M-series chip |
| Windows 10 / 11 | **x64** — Intel 64-bit / AMD 64-bit | [EXE — AllPet-Setup-1.3.0.exe](https://github.com/haverainlilili/all-pet/releases/download/v1.3.0/AllPet-Setup-1.3.0.exe) | Typical Intel / AMD Windows PC |
| Linux — most x64 distributions | **x64** — Intel 64-bit / AMD 64-bit | [AppImage — AllPet-1.3.0.AppImage](https://github.com/haverainlilili/all-pet/releases/download/v1.3.0/AllPet-1.3.0.AppImage) | Portable install on most x64 Linux distributions |
| Debian / Ubuntu Linux | **x64** — Intel 64-bit / AMD 64-bit | [DEB — allpet-desktop_1.3.0_amd64.deb](https://github.com/haverainlilili/all-pet/releases/download/v1.3.0/allpet-desktop_1.3.0_amd64.deb) | Debian / Ubuntu and compatible distributions |

**Not packaged yet:** Intel Mac (`x86_64`), Windows on ARM, and Linux ARM (`aarch64`) do not currently have ready-made installers. Build from source or contribute a package build.

> **AI / automation rule:** ask for OS and CPU architecture. For an Apple M-series Mac return the DMG link; for a typical Intel/AMD Windows PC return the EXE; for Debian/Ubuntu x64 return DEB; otherwise for x64 Linux return AppImage. Do not recommend the arm64 macOS package for an Intel Mac.

> **Platform maturity:** macOS currently has the best adaptation and test coverage, including the native AppKit GUI and richer task-focus behavior. Windows and Linux installers are supported, but they use the Electron shell and have more OS/desktop-environment differences. If you find a Windows or Linux display, tray, transparency, task-wake, or monitoring problem, please submit a PR — the maintainer welcomes and will review mergeable fixes.

### Releases vs. the newest source code

Not every commit needs a new installer release:

- **`main` branch = newest development source.** Source users can follow every merged fix immediately with `git pull --ff-only`, then rebuild/restart the app.
- **`vX.Y.Z` tag / GitHub Release = stable prebuilt installers.** People using DMG / EXE / AppImage / DEB keep running the code bundled in that installer; later commits do not enter an already-installed app automatically.
- **Code changes require a new build to affect installer users.** Routine fixes can be collected into a patch release such as `v1.3.1`; urgent compatibility/security fixes should be packaged promptly. README-only changes do not require repackaging.
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
- **任务唤醒**：仅来源明确的 Codex Desktop 会话尝试 `codex://` 深链；CLI、Claude 和 Grok 在没有安全精确定位能力时 fail-closed，DSH 只提供明确选择的基页打开，不宣称已聚焦原会话。
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

AllPet ships with 4 built-in pets out of the box (Boba, Tiko, 团团和米粒, Hoops). Other default pets download on first click.

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

## Task bubbles

A bubble has three levels:

1. **Collapsed** — platform overview;
2. **Platform** — choose Codex, Claude, DSH, or Grok;
3. **Session** — choose a specific session and wake the original task.

The title shows the stable **session name**; the current action and progress appear in the subtitle.

- Click outside the window to collapse;
- Close button in the top-right of every bubble;
- Done or failed tasks disappear after being woken;
- A bubble also disappears when you open a finished task manually.

## Wake & strong-wake

- **Wake** — the app is still running; just focus the already-open original task.
- **Strong-wake** — the app was closed; after you confirm, it reopens the app and navigates to the original task.

Claude Desktop has no public deep link for selecting an arbitrary existing conversation. A verified Desktop-owned task safely activates the existing Claude app without importing or duplicating a session; when the target is not already focused, choose its title in the sidebar. Claude CLI resume remains an explicit, validated strong-wake operation rather than an automatic fallback.

Terminal tasks prefer to reuse the original Terminal / iTerm tab; nothing new is opened or resumed without your confirmation.

## Where the state comes from

AllPet reads session logs already stored locally by each platform — no passwords or extra APIs:

| Platform | Default data location |
|---|---|
| Codex | `~/.codex/sessions` |
| Claude Code | `~/.claude/projects` |
| DSH | `~/.dsh/sessions` |
| Grok | `~/.grok/logs/unified.jsonl`, `active_sessions.json` |

Explicit task events in the logs win; when there is no clear event, AllPet falls back to recent-write time to infer running / waiting / idle. Scanning, caching, and zstd decompression all run in the background so the pet animation never stutters.

## Configuration

Config file: `~/.config/all-pet/config.json` (see [`config.example.json`](./config.example.json)).

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

- `scale` — pet size;
- `anchor` — `bottom-right`, `bottom-left`, `top-right`, or `top-left`;
- `bundlePath` — current pet directory; usually you don't need to set it — the menu and `pet set` save it automatically.

## Packaging installers

当前版本 **v1.3.0**。版本号记录在 [`desktop/package.json`](./desktop/package.json) 的 `version` 字段（`desktop/package-lock.json` 需同步）。

发新版时先 bump 版本号并提交，再打 tag 触发三平台打包并发布到 GitHub Releases：

```bash
# 1. 修改 desktop/package.json 与 desktop/package-lock.json 的 version
# 2. 提交后打 tag 并推送
git tag -a v1.3.0 -m "AllPet v1.3.0"
git push origin v1.3.0
```

`Release` workflow 会构建 Swift 核心、嵌入 Electron sidecar，再在 macOS / Windows / Linux 上运行 `electron-builder`，产出 `dmg`/`zip`、`exe`、`AppImage`/`deb`。打包完成后 Release 默认为草稿（draft），用 `gh release edit v1.3.0 --draft=false` 正式发布；也可在 Actions 页手动触发（仅出产物、不建 Release）。本地打包见 [`desktop/README.md`](./desktop/README.md)。

## FAQ

### Clicking a task doesn't focus it

Allow AllPet / Terminal to control windows in "System Settings → Privacy & Security → Accessibility". Browsers additionally need Apple Events / JavaScript automation.

### DSH only shows times, no task content

```bash
brew install zstd
```

### Debugging

```bash
./allpet self-test
./allpet logs
```

Logs live at `~/.config/all-pet/allpet.log`.

## License

MIT. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for open-source references and third-party notices.

Built with reference to [openpets](https://github.com/alterhq/openpets) and [codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet). cc-haha, clawd-on-desk, and LingChat are only install-time format sources; their assets are not distributed with this repository.
