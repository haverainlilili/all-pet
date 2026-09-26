# AllPet Electron 桌宠（开发版；稳定版 v1.4.1）

Electron 通过 `allpet watch --json` 复用 Swift AllPetCore，macOS/Windows/Linux 共用动画、气泡与宠物管理。九平台接入与用户点击行为见 [功能设计说明](../docs/功能设计说明.md)；手动查看能力见 [验收表](../docs/平台行为验收.md)。


## 开发版：统一菜单与终端定位（尚未发布）

三平台 Electron 共用 Mac 风格级联菜单。悬停或点击打开子菜单；平台开关、全部显示/隐藏、大小和宠物切换持续保持打开；Esc、点击外部或打开另一个窗口时关闭。macOS 的系统识别桥接在后台运行，不再额外创建菜单栏图标。

Electron 已接入运行期间的终端绑定、点击定位和每 500 ms 的查看检查。各终端的条件与限制见 [终端接入说明](integrations/README.md)：VS Code/Cursor 需要扩展，WezTerm 需要 Lua 接入，kitty 需要本地控制 socket，Linux 部分路径依赖辅助功能或 X11。接口存在不等于所有版本均已实测，也不构成无条件两秒内确认的保证。

下面 v1.4.1 的下载链接仍对应已发布的旧版本，不包含本节新增能力。


## 菜单与终端支持

三平台左/右键均打开同一套菜单，子菜单侧边展开、保留主菜单；连续平台开关、大小与宠物选择不会关闭。Esc/失焦关闭；对话框和外部动作先关闭菜单。macOS 后台 AppKit 桥接只负责系统接口。

原终端身份捕获与定位已接通；每种终端的接口要求、扩展安装及实际验收边界见 [终端接入说明](integrations/README.md)。

## 开发运行

在仓库根目录执行。需要 Swift（CI 为 6.2.4）和 Node.js 24；Node SQLite 用于 Z Code 验收，发布包内由 Electron 提供运行时。

```bash
swift build -c release --static-swift-stdlib
cd desktop
npm ci
npm start
```

开发启动优先发现仓库 release/debug sidecar；打包启动使用应用内 sidecar。应用数据位于 `~/.config/all-pet/`，隔离测试用 `ALLPET_HOME`。

## 结构

- `main.js`：窗口、托盘、监控、历史与 IPC。
- `src/renderer.*`、`style.css`：动画、三层气泡和平台分页。
- `src/platforms.js`、`task-history.js`：九平台定义、可见性与通知生命周期。
- `src/manual-view.js`、`menu-bridge.js`：每 500 ms 分平台查看检查与 Mac 原生协议。
- `src/tray-panel.*`、`tray-panel-model.js`、`tray-panel-preload.js`：三平台统一常驻菜单面板及受限 IPC。
- `src/terminal/`：进程身份、原窗口/tab/pane 适配器和带超时的私有 IPC。
- `integrations/`：VS Code/Cursor VSIX 源码、WezTerm Lua 和用户说明。
- `src/wake.js`：按来源尝试定位，缺少精确能力时提示限制。
- `scripts/sqlite-read.js`、`zstdcat.js`：随包只读数据解码器。

## 验证

在仓库根目录执行；`ALLPET_BINARY` 应指向已构建可执行文件，Windows 后缀为 `.exe`。

```bash
(cd desktop && npm test)
# 实际菜单窗口：隔离 HOME 连续点击、缩略图、Esc、切换到测试窗口后关闭
node desktop/scripts/verify-tray-panel.js
# Linux 无显示器时使用 xvfb-run -a；成品测试设置 ALLPET_APP_BINARY
ALLPET_BINARY="$PWD/.build/release/allpet" node desktop/scripts/verify-platform-integrations.js
# 以下仅 macOS
.build/release/allpet self-test
.build/release/allpet selection-self-test
ALLPET_BINARY="$PWD/.build/release/allpet" node desktop/scripts/verify-appkit-lifecycle.js
ALLPET_BINARY="$PWD/.build/release/allpet" node desktop/scripts/verify-manual-view-bridge.js
```

这些脚本使用临时数据。原生格式夹具通过不代表第三方客户端导航已经实测。

## 打包

```bash
# 仓库根目录
swift build -c release --static-swift-stdlib
node desktop/scripts/prepare-sidecar.js
task_verify_home=$(mktemp -d)
ALLPET_CLEAN_PATH=1 node desktop/scripts/verify-sidecar.js desktop/sidecar "$task_verify_home"
cd desktop
npm ci
# macOS：对新包执行 ad-hoc 签名，避免重命名 Electron 后签名失效
npx electron-builder --mac dmg zip --publish never --config.mac.identity=- --config.mac.hardenedRuntime=false
# Windows/Linux：在目标系统执行
# npx electron-builder --publish never
```

产物位于 `desktop/dist/`。sidecar 包含 Swift 可执行文件、SwiftPM 资源及 Windows 所需 runtime DLL；额外附带 SQLite/zstd 读取器和托盘图标。macOS ad-hoc 签名只证明代码完整性，不等于 Developer ID 签名或公证；更新后辅助功能可能需要用户重新确认。

macOS 可检查 `codesign --verify --deep --strict desktop/dist/mac-arm64/AllPet.app`，再运行隔离回执检查：

```bash
ALLPET_APP_BINARY="$PWD/dist/mac-arm64/AllPet.app/Contents/MacOS/AllPet" node scripts/verify-manual-view.js
```

Release 工作流在匹配版本号的 tag 上向 GitHub Release 草稿上传产物，手动触发只保存 Actions 产物。三平台 CI/打包全部通过、检查安装包与 SHA256SUMS 后才公开草稿。应用没有自动更新功能。
