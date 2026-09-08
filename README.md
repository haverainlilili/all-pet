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
- **Wake & strong-wake** — click a bubble to focus the original task; if the app was closed, confirm and it reopens to the same task.
- **Cross-platform CLI** — `status` / `watch` / `self-test` build on macOS, Linux, and Windows.
- **Cross-platform desktop shell** — an Electron shell (`desktop/`) shows the pet and a graphical pet manager (switch / install / import / delete pets) on Windows, Linux, and macOS.
- **Bring your own pet** — one-command install from GitHub, or import local Codex / OpenPets / cc-haha / clawd-on-desk / LingChat / single-image pets.

## Quick start

### Download an installer (recommended)

Grab the latest from [GitHub Releases](https://github.com/haverainlilili/all-pet/releases):

- **macOS** — `AllPet-<version>-arm64.dmg`
- **Windows** — `AllPet-Setup-<version>.exe`
- **Linux** — `AllPet-<version>.AppImage` or `allpet-desktop_<version>_amd64.deb`

Installers bundle the Swift core and 4 built-in pets, so no Node.js, Swift, or extra pet downloads are needed. (macOS builds are currently unsigned — right-click → Open on first launch.)

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

Claude strong-wake asks you to choose **Claude Desktop / Claude CLI / Cancel**. Desktop opens only an existing `/epitaxy/<local-id>` task (never a duplicated `claude://resume`); on failure it returns to the picker.

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

Tag a release to build all three platforms and publish to GitHub Releases:

```bash
git tag -a v1.0.1 -m "AllPet v1.0.1"
git push origin v1.0.1
```

The `Release` workflow builds the Swift core, embeds it as the Electron sidecar, then runs `electron-builder` on macOS / Windows / Linux. You can also trigger it manually from the Actions tab (artifacts only, no Release). Local packaging: see [`desktop/README.md`](./desktop/README.md).

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
