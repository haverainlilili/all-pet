# AllPet 终端接入

开发版的 macOS、Windows、Linux Electron 菜单使用同一套 Mac 风格级联界面。平台开关、宠物大小、换宠物保持菜单打开。这里说明终端定位所需条件；已发布的 v1.4.1 安装包不包含这些新增能力。

AllPet 先用会话 ID、日志文件的持有进程或带时间校验的进程记录绑定终端，再定位已有标签页/分屏。不会根据同名标题、同一项目目录随意选择窗口，不会为了跳转创建新终端或执行 resume。点击完成/失败气泡立即确认通知；手动查看只有拿到准确焦点证据才确认。

## 接入范围

| 终端 | 点击原终端 | 手动查看确认 | 条件 |
| --- | --- | --- | --- |
| macOS Terminal / iTerm2 | 原标签页 / iTerm2 session | 前台窗口且选中对应 TTY | 允许 AllPet 控制终端；运行期间完成绑定 |
| Windows Terminal | 原标签页和 TermControl 控件 | 控件确实获得键盘焦点 | 同一用户、相同权限级别，UI Automation 可用；程序允许更改终端标题 |
| PowerShell / CMD 的独立控制台 | 原 console HWND | 原窗口在前台且未最小化 | 使用可见 conhost 控制台；这些 shell 在 Windows Terminal 中按上一行处理 |
| kitty | 精确 window ID | OS window、tab、pane 同时处于焦点 | 本地 remote-control Unix socket，可执行 `ls` / `focus-window` |
| WezTerm | 原 pane 和 GUI window | window 焦点 + active pane | 下述 Lua 接入；400 ms 更新；本地进程 |
| VS Code / Cursor 内置终端 | 扩展按 terminal 对象定位 | 切换到该终端时的事件，或“已查看当前终端任务”命令 | 安装下述 VSIX；本地窗口 |
| Konsole | D-Bus session + 原 X11 窗口 | currentSession + 前台 X11 窗口 | qdbus/qdbus6、xdotool、X11 |
| GNOME Terminal / XFCE Terminal / MATE Terminal | AT-SPI 原终端控件 | terminal focused/showing + frame active | python3-pyatspi；X11 激活需要 xdotool |
| Terminator / Tilix / GNOME Console | 使用同一 AT-SPI 适配器 | 同上 | 只有标题标记能唯一对应终端控件时可用；有歧义保留气泡 |
| xterm / rxvt / urxvt / st / Alacritty | 原 X11 window | 原 X11 window 在前台 | WINDOWID、窗口所属进程链和 xdotool；一个窗口一个终端 |
| tmux | stable pane ID + 所属窗口 + 外层终端 | 选中 pane/window，且外层终端已查看 | tmux 在 PATH；默认 server；必须有可定位的本地客户端 |

这是适配器与条件清单，不表示所有版本均已实机验收。验收范围见仓库 `docs/平台行为验收.md`。Codex CLI、Claude Code CLI、Grok CLI、pi 共享上述路径；GUI 会话继续使用原有桌面会话识别。

## VS Code / Cursor

1. 在扩展面板的 `…` 中选择“从 VSIX 安装”。
2. 选择本目录的 `allpet-terminal-bridge.vsix`，重载编辑器窗口。
3. 保持 AllPet 运行。扩展通过当前用户目录下的私有 socket/命名管道连接；不读取终端输出。
4. 手动选择另一个终端再切回对应终端，会发送一次查看事件。若原终端早已是 activeTerminal，只隐藏/显示面板，VS Code 公共 API 不提供可靠的面板焦点状态；使用终端标题栏或命令面板的 **AllPet: 已查看当前终端任务** 确认。不能把 activeTerminal 属性常驻当成一直在查看。

远程 SSH/WSL/容器窗口不把远程 PID 当作本机 PID，不会误确认本地任务。远程端日志及跨主机映射尚未接入。

## WezTerm

将本目录 `wezterm.lua` 保存到自己稳定的配置目录，在现有配置的 `return config` **之前**加入：

```lua
dofile('/绝对路径/wezterm.lua').setup(config)
```

Windows 路径可以用 Lua 长字符串：`dofile([[C:\Users\你的用户名\wezterm-allpet.lua]]).setup(config)`。

接入保留已有事件处理器，并把 status 更新间隔限定在 400 ms 以内。只记录本地 pane 的 ID/TTY/PID、当前 pane 和窗口焦点，不记录标题、输入或滚动内容。请求只允许选择已存在的 pane。Wayland 可能拒绝程序主动抢焦点，拒绝时不会报告定位成功。

## kitty

在 kitty 中启用受本机 socket 权限保护的 remote control，允许 `ls` 和 `focus-window`。将该实例的真实 `KITTY_LISTEN_ON` Unix socket 地址写入 AllPet 配置（菜单“打开配置”）：

```json
{ "terminal": { "kittySocket": "unix:/实际的本机/kitty-socket" } }
```

这里只接受 Unix socket，不连接 TCP。kitty 可能给配置的 socket 文件追加进程号，要填运行实例的实际地址。多个实例需要明确选择对应 socket；当前配置仅支持一个实例。

## Linux

Debian/Ubuntu 的 VTE/AT-SPI 接入依赖可通过系统包安装：`python3-pyatspi xdotool`；Konsole 另需 `qdbus` 或 `qdbus6`。必须启用桌面的辅助功能总线。

VTE 控件和 Windows Terminal 的初次绑定会临时写入随机标题标记，准确找到原控件后恢复标题。不会写入 shell 输入。禁止修改标题、终端不支持标题栈、控件不可见或无法唯一识别时，定位可能失败。Wayland 限制前台激活；X11、AT-SPI 和应用自身 API 的实际能力不同。

## 生命周期与限制

- 运行中每秒尝试捕获绑定；手动查看循环每 500 ms 运行。接口正常且身份已绑定时目标是约 2 秒内移除完成气泡；不是跨所有权限/负载/终端版本的强制时限。
- 绑定包含 shell PID 和启动时间；Linux 加上 boot ID。CLI 子进程退出后 shell 尚在，仍可定位原终端。shell/窗口关闭、PID/TTY 复用会使绑定失效。
- 同一个终端已经承载更新任务时，旧任务不会因为这个终端获得焦点而被自动确认。
- 任务如果在 AllPet 启动前已经退出且没有已保存绑定，日志通常不足以恢复原终端位置。
- SSH、WSL、容器、tmux 自定义 server/socket、kitty 多实例、Windows 管理员与普通用户跨权限控制目前不保证；缺少证据时保留通知并给出定位失败说明。
- Ghostty、Warp 目前没有此版本接通并验证的专用终端定位适配器；本地任务日志仍可产生气泡。
