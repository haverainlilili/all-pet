# AllPet 跨平台桌宠（Electron 壳）

复用 Swift `AllPetCore` 的监控能力：Electron 主进程以子进程跑 `allpet watch --json`，把 NDJSON 快照转发给渲染层，驱动精灵动画与状态气泡。macOS / Windows / Linux 共用同一套 Web 前端。

## 运行

```bash
# 1. 先构建 Swift 核心（release 带 JSON 输出）
cd .. && ./allpet restart    # 或 swift build -c release

# 2. 安装并启动 Electron 壳
cd desktop
npm install
npm start
```

`main.js` 会自动定位 `../.build/release/allpet`（其次 debug、PATH），无需手动配置。

## 结构

- `main.js` —— 主进程：窗口/托盘/子进程监控/唤起
- `preload.js` —— contextBridge 暴露 `petAPI`（onPet/onSnapshot/onWatchError）
- `src/renderer.html` + `renderer.js` + `style.css` —— 宠物窗口：canvas 精灵动画 + 气泡
- `assets/icon.png` —— 托盘图标

## 说明

- 精灵动画的行号与帧时长与 `Sources/AllPetCore/PetAnimation.swift` 保持一致（8 列图集，cell 192×208）。
- 唤起（打开 Codex/Claude/Grok/DSH）目前是各平台尽力实现（macOS `open`、Windows `start`/CLI、Linux `xdg-open`/CLI），后续可细化。
- 调试截图：`ALLPET_SCREENSHOT=/tmp/shot.png npm start`，启动 5s 后截图退出。

## 打包安装包

打包会先把 Swift 核心（`allpet`）放进 `sidecar/`，再用 electron-builder 出对应平台安装包：

```bash
# 1. 构建 Swift 核心
cd .. && swift build -c release --disable-sandbox

# 2. 复制 sidecar 二进制
mkdir -p desktop/sidecar
cp .build/release/allpet desktop/sidecar/allpet   # Windows 复制 allpet.exe

# 3. 打包（macOS 出 dmg+zip / Linux 出 AppImage+deb / Windows 出 nsis exe）
cd desktop && npm ci && npx electron-builder --publish never
```

产物在 `desktop/dist/`。应用图标来自 `desktop/build/icon.png`（1024×1024，打包时自动转 icns/ico）。

CI 里打 tag（`v*`）会自动触发三平台打包并发布 GitHub Release；也可在 Actions 手动触发 `Release` 工作流只出产物不发布。
