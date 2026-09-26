# Changelog

## Unreleased

- 三平台 Electron 统一 Mac 风格级联菜单；连续平台切换、缩放与换宠物保持打开。
- 接通原终端身份捕获、持久化、点击定位与 500 ms 查看检查；Mac 桥接无额外菜单图标。
- 增加 Windows 控制台/UI Automation、Linux AT-SPI/X11、kitty、Konsole、tmux 适配器；随包提供编辑器 VSIX 和 WezTerm Lua 接入。
- 拒绝失效进程、复用的 PID/TTY、新任务占用终端和延迟回复。配置与剩余限制见终端接入说明。

## v1.4.1 — 2026-09-26

- 修复 Windows/Linux 点击菜单设置后立即关闭：托盘左/右键打开持续操作的菜单面板。平台勾选、全部显示/隐藏、大小调节、宠物切换和刷新保持打开。
- 补齐行内大小控件、宠物缩略图、删除按钮和子页返回；外部失焦、Esc、关闭按钮关闭，需弹窗或外部程序的操作先关闭面板。
- 新增实际 Electron 菜单回归，并在 macOS/Windows/Linux CI 运行；Windows 发布成品再次执行连续操作与失焦测试。
- 文档区分 CLI 日志监控、原终端定位和手动查看识别；本版没有新增原终端聚焦能力。

见 [v1.4.1 发布说明](docs/releases/v1.4.1.md)。

## v1.4.0 — 2026-09-26

### 新增

- Cursor、WorkBuddy、Qoder、pi coding agent、智谱 Z Code，总计九个平台。
- Cursor/Qoder 可选观察 hooks；WorkBuddy/pi JSONL、Z Code 只读 SQLite/WAL 接入。
- 菜单中的逐平台气泡显示设置，支持全部显示/隐藏、重启保留；macOS 连续勾选不关闭菜单。
- 完整功能设计、逐项点击行为、平台接入和验收边界文档。

### 修复

- 九平台完成/失败气泡点击即确认并持久化，导航失败或迟到回调不恢复旧通知、不误删新轮次。
- macOS Electron 独立检测手动查看；Codex 支持未读→已读回执，Claude/DSH/Grok/pi 按精确会话或有效终端绑定判断。
- 根据来源过滤 Codex 内部守护/子代理，清理旧历史中的内部任务；不以短 ID 作为过滤理由。
- 包含 v1.3.0 后的 DSH 多会话、原浏览器标签页复用、菜单缩略图裁切与 Claude 安全激活修复。
- 修复 Windows 路径分隔符导致的 WorkBuddy/Qoder 子任务误收录与 Cursor transcript 漏读；Hook 同步过滤子任务目录。
- 安装包保留 SwiftPM 内置资源，补齐 SQLite 解码器；macOS 执行有效 ad-hoc 签名。

### 限制

- Cursor/WorkBuddy/Qoder/Z Code 尚无可靠手动查看检测；pi 无 TTY 绑定时无法自动确认。Windows/Linux 尚无同等检测。
- 500 ms 为检测调度周期，不承诺所有真实客户端都在 2 秒内消泡。具体条件与实测边界见 [验收记录](docs/平台行为验收.md)。
- macOS 无 Developer ID/公证，Windows 无代码签名；无应用内自动更新。
- 独立开发中的会话索引/逐字内容导出不随本版发行。

安装、构建与校验信息见 [v1.4.0 发布说明](docs/releases/v1.4.0.md)。

## v1.3.0 及更早版本

历史说明见 [GitHub Releases](https://github.com/haverainlilili/all-pet/releases)。旧资产保持原样；v1.3.0 的 macOS ZIP 资源遗漏由 v1.4.0 安装包修复。
