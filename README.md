# AllPet — 多平台 AI 编码助手桌面宠物

一个 Codex 宠物风格的 macOS 桌面宠物，用一只宠物统一监控多个 AI 编码平台的活动状态，
并驱动宠物动画（待机 / 奔跑 / 挥手 / 跳跃 / 失败 / 等待 / 审阅）。

当前已落地（v1，核心库 + CLI + macOS GUI）：

- ✅ 配置系统：`~/.config/all-pet/config.json`，每个平台可独立开关、自定义路径
- ✅ 多平台监控：**Codex** / **Claude Code** / **DSH (DeepSeek Harness)** / **Grok**
- ✅ Codex 宠物格式：8 列 × 9/11 行图集，`pet.json` + `spritesheet.webp`，动画状态机
- ✅ 宠物发现：自动扫描 `~/.codex/pets`、openpets / DSH 宠物目录
- ✅ macOS 桌面宠物：透明悬浮窗 + 精灵动画 + 拖拽 + 菜单栏（显示/隐藏、换宠、平台状态、打开配置、退出）

## 参考与复用

本项目参考并复用了两个开源项目（详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)）：

- [openpets](https://github.com/alterhq/openpets)（MIT）：Codex 宠物图集 / 动画状态机 / `pet.json` 规范
- [codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet)（MIT）：agent 活动状态 → 宠物姿势的映射、DSH 活动信号来源

## 监控原理

每个平台都有一处「会话 / 日志文件随运行而追加写入」的信号源，AllPet 轮询这些文件的
修改时间（mtime），再结合日志尾部文本判断阶段：

| 平台 | 信号源 | 判定 |
|------|--------|------|
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | mtime + 尾部 `type` + 错误标记 |
| Claude Code | `~/.claude/projects/**/*.jsonl` | mtime + 尾部 `type` + `is_error` |
| DSH | `~/.dsh/sessions/**/session.jsonl.zstd` | mtime（zstd 二进制，v1 只判运行） |
| Grok | `~/.grok/logs/unified.jsonl` + `active_sessions.json` | 两者较新的 mtime + `lvl`/`msg` |

阶段归类（可在配置里调整窗口）：

- 距最近写入 ≤ `activeWindowSeconds`（默认 8s）→ `运行中`（含尾部错误标记 → `出错`）
- 距最近写入 ≤ `waitingWindowSeconds`（默认 120s）→ `等待中`
- 更久 → `空闲`

聚合优先级：`出错` > `运行中` > `等待中` > `完成` > `空闲`，映射为宠物动画
`failed` / `running` / `waiting` / `review` / `idle`。

## 构建

需要 macOS 14+ 与 Xcode Command Line Tools（`swift build` 即可，无需 Xcode 工程）。

```bash
swift build -c release
```

## 运行桌面宠物（GUI）

```bash
.build/release/allpet
# 或 .build/release/allpet gui
```

启动后：

- 宠物以透明悬浮窗显示在屏幕角落（默认右下），随各平台活动切换动画；
- 气泡显示当前活跃平台（如「Codex 运行中 · DSH 运行中」）；
- 拖拽宠物可移动位置；
- 菜单栏 🐾 图标：显示/隐藏宠物、换宠、查看四平台状态、打开配置、退出。

## CLI 用法

```bash
# 生成默认配置（~/.config/all-pet/config.json）
.build/release/allpet init

# 打印四个平台的一次快照
.build/release/allpet status

# 持续监控，状态变化时打印
.build/release/allpet watch

# 列出发现的 Codex 宠物
.build/release/allpet pet list
```

示例输出：

```
AllPet · 2026-09-05 16:04:20 · 宠物 running · Codex 运行中 · DSH 运行中
  Codex        运行中   token_count  · 1 会话 · 刚刚
  Claude Code  空闲     -  · 0 会话 · 1h 前
  DSH          运行中   运行中  · 4 会话 · 刚刚
  Grok         空闲     -  · 1 会话 · 1d 前
```

## 配置

`~/.config/all-pet/config.json`（见 [config.example.json](./config.example.json)）：

```json
{
  "pet": { "enabled": true, "scale": 0.42, "anchor": "bottom-right", "bundlePath": null },
  "watch": { "pollIntervalMilliseconds": 1000, "activeWindowSeconds": 8, "waitingWindowSeconds": 120 },
  "platforms": {
    "codex":  { "enabled": true, "paths": ["~/.codex/sessions"] },
    "claude": { "enabled": true, "paths": ["~/.claude/projects"] },
    "dsh":    { "enabled": true, "paths": ["~/.dsh/sessions"] },
    "grok":   { "enabled": true, "paths": ["~/.grok/logs/unified.jsonl", "~/.grok/active_sessions.json"] }
  }
}
```

- `platforms.<id>.enabled`：关闭某个平台后不再监控（也不出现在快照里）
- `platforms.<id>.paths`：自定义信号源路径；留空数组则用默认路径
- `pet.bundlePath`：指定宠物目录（含 `pet.json` + `spritesheet.webp`）；`null` 表示自动发现

## 项目结构

```
Sources/
├── AllPetCore/              # 核心库（无 AppKit 依赖）
│   ├── PetAnimation.swift   # Codex 宠物动画状态机（行号 + 逐帧时长）
│   ├── PetManifest.swift    # pet.json 清单 + 图集几何
│   ├── PetBundle.swift      # 宠物包加载（ImageIO 读图集尺寸）
│   ├── PetDiscovery.swift   # 宠物发现
│   ├── Configuration.swift  # 全局配置（加载/保存/默认路径）
│   ├── PlatformState.swift  # 平台枚举 + 阶段枚举 + 快照结构
│   ├── ActivityScanner.swift# 递归扫描 + 尾部读取 + 错误识别
│   ├── PlatformMonitor.swift# 监控器协议 + 阶段归类
│   ├── CodexMonitor.swift / ClaudeMonitor.swift / DSHMonitor.swift / GrokMonitor.swift
│   ├── Aggregator.swift     # 多平台阶段 → 宠物动画 + 气泡文案
│   └── AllPetMonitor.swift  # 监控协调器
└── allpet/
    └── main.swift           # CLI 入口
```

## 许可

MIT。第三方引用见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
