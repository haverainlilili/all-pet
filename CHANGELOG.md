# Changelog

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
