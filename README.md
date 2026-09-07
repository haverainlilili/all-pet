# AllPet — 多平台 AI 编码助手桌面宠物

一个 Codex 宠物风格的 macOS 桌面宠物：用一只宠物统一监控多个 AI 编码平台，
根据真实任务、工具调用、进度、完成和错误状态驱动动画，并在宠物头顶显示任务气泡。

当前支持：

- ✅ **Codex / Claude Code / DSH (DeepSeek Harness) / Grok**
- ✅ Codex 宠物格式：8 列 × 9/11 行，`pet.json` + `spritesheet.webp/png`
- ✅ 本地复用 GitHub 热门宠物格式：cc-haha、clawd-on-desk、LingChat
- ✅ 自动发现 `~/.codex/pets`、openpets / DSH、AllPet 导入目录与 cc-haha 自定义宠物目录
- ✅ 透明悬浮窗、逐帧动画、拖拽、菜单栏、运行时换宠
- ✅ Codex 风格三阶段气泡：收起 → 平台 → 平台任务
- ✅ 任务状态、Todo 进度、平台品牌配色与多任务紧凑列表
- ✅ 点击任务精确唤起 Codex / Claude Code / DSH / Grok；平台关闭时先征得确认，再打开到对应任务位置
- ✅ 仓库根目录一个命令自动构建、后台启动、停止与重启

## 快速开始（推荐）

需要 macOS 14+ 和 Xcode Command Line Tools。克隆仓库后，在仓库根目录执行：

```bash
./allpet
```

第一次运行或源码变化时，脚本会自动执行 release 构建，然后在后台启动 GUI；以后仍然只需
`./allpet`。常用管理命令：

```bash
./allpet              # 自动构建（如有需要）并启动；已运行时不会重复启动
./allpet restart      # 停止、自动构建并重启
./allpet stop         # 停止桌面宠物
./allpet logs         # 查看 GUI 日志
./allpet status       # 查看四个平台的任务快照
./allpet watch        # 任务、工具或阶段变化时持续打印
./allpet pet import PATH # 导入并设为默认宠物（支持路径含空格）
./allpet self-test    # 检查四平台解析器、精确唤起与三种宠物适配器
./allpet help
```

GUI 日志和 PID 分别保存在：

- `~/.config/all-pet/allpet.log`
- `~/.config/all-pet/allpet.pid`

## 唤起术语

- **唤起状态**：任务程序仍在运行，只聚焦已经打开的原任务界面。
- **强唤起状态**：任务程序已经关闭；经用户确认后打开对应程序，并定位到原任务。未经确认不会启动程序。
- Claude 进入强唤起状态时，弹窗必须让用户选择 **Claude Desktop**、**Claude CLI** 或取消；Desktop 仅在能映射到既有原任务时打开，绝不通过 `claude://resume` 导入副本。Desktop 通过精确的 `/epitaxy/<local-id>` 深链定位，程序已运行或已成功接收深链即视为唤起成功，不再要求聚焦时间戳再次变化（避免"已经打开却误报失败"）。若某次 Desktop 或 CLI 打开失败，弹窗会回退到 Desktop / CLI / 取消的选择界面，而不是进入死胡同。

## 头顶任务气泡

气泡严格分为三个阶段：

1. **阶段 1（收起）**：已完成任务的平台气泡固定在上方；未完成平台每 3.2 秒轮转，主气泡前置、后两张缩进并像 Codex 一样重叠露出 20pt。
2. **阶段 2（平台）**：每个平台一个气泡；气泡内用紧凑行列出最多 5 个任务，更多任务显示 `+N`。
3. **阶段 3（任务）**：显示所选平台的任务气泡，标题格式如 `Codex - 会话名`。三个阶段的气泡都只显示平台自身的稳定会话名称，不把当前轮提示词/任务名称当作会话名。

点击阶段 1 气泡或宠物进入阶段 2；阶段 2 的平台只有一个任务时直接唤起对应任务，
有多个任务时进入阶段 3；点击阶段 3 的任一任务也会唤起原平台中的对应会话。每个任务气泡右上角提供关闭按钮，点击窗口外部返回阶段 1。
平台名称使用各自品牌色，运行状态继续使用转圈，完成状态使用绿色勾。每个会话始终只保留一个任务气泡；
标题或状态更新会替换原气泡，不会新增重复项。已完成任务成功进入唤起状态后会立刻关闭对应气泡，
警告/失败气泡在成功唤起后也会关闭；同一份完成或失败快照不会把它重新加回，该会话再次运行时才重新出现。
用户自己手动打开并查看某个已完成任务时，对应完成气泡也会自动消失（Claude Desktop 依据该会话的 `lastFocusedAt` 前进、
终端类依据所选标签的 TTY、DSH 依据浏览器当前会话、Codex Desktop 依据聚焦窗口的会话标题）。

任务历史和已打开完成项保存在 `~/.config/all-pet/task-history.json`，每个平台最多保留 12 条。日志扫描与
zstd 解压均在后台队列执行，不阻塞宠物逐帧动画。Codex 扫描会识别首行来源并排除 DSH 的 Codex provider
转录，避免同一个 DSH 会话同时显示成 Codex 与 DSH 两个任务。

## 监控原理

| 平台 | 信号源 | 提取内容 |
|------|--------|----------|
| Codex | `~/.codex/sessions/**/*.jsonl` | 用户消息、reasoning、工具调用、`task_complete`、错误 |
| Claude Code | `~/.claude/projects/**/*.jsonl` | 人类提示词、thinking、`tool_use` / `tool_result`、`stop_reason` |
| DSH | `~/.dsh/sessions/**/session.jsonl.zstd` | `user/message`、`tool/call`、`todo/write`、`turn/end`、错误 |
| Grok | `~/.grok/logs/unified.jsonl` + `active_sessions.json` | phase transition、工具事件、完成/错误、项目目录；增量索引完整日志中的原始 PID |

AllPet 优先采用日志内明确状态；无法识别的新事件再使用 mtime 回退规则：

- 距最近写入 ≤ `activeWindowSeconds`（默认 8 秒）→ `运行中`
- 距最近写入 ≤ `waitingWindowSeconds`（默认 120 秒）→ `等待中`
- 更久 → `空闲`

聚合优先级：`出错` > `运行中/思考中` > `等待中` > `完成` > `空闲`，对应宠物动画
`failed` / `running` / `waiting` / `review` / `idle`。动画状态类型、图集行和逐帧时长与本机安装的
Codex 宠物实现一致，共九种标准状态：`idle`、`running-right`、`running-left`、`waving`、
`jumping`、`failed`、`waiting`、`running`、`review`。非 idle 动作播放三轮后进入 idle 循环；
悬停使用 `jumping`，水平拖拽使用对应方向的 running 动画。

DSH 会话是 zstd 文件。AllPet 自动寻找 PATH 以及常见 Homebrew / Miniconda 目录下的
`zstdcat` 或 `zstd`，并按文件 mtime 缓存解析结果。未安装 zstd 时仍可使用 mtime 监控，
但不会显示 DSH 的具体任务和工具。Homebrew 用户可执行：

```bash
brew install zstd
```

当 AllPet 从 DSH 会话中启动时，会优先显示环境变量 `DSH_SESSION_JSONL` 指向的当前会话；
没有该环境变量时，选择最近活跃的顶层 DSH 会话；子代理属于其父任务，不会另建无法独立唤起的任务气泡。

## GUI 操作

启动后：

- 宠物默认位于屏幕右下角，并随聚合状态切换动画；
- 宠物采用 Codex 默认 112pt 宽度与 192×208 单帧比例，并保持高质量图像缩放；
- 拖拽宠物可以移动，点击宠物进入平台阶段；
- 点击阶段 3 任务气泡，或阶段 2 的单任务平台气泡，只会唤起对应会话；无法精确定位时明确报错，不会退回应用首页；
- DSH 会从 Safari、Chrome、Edge、Brave、Arc 中选择最近使用且已打开 DSH 的窗口/标签页，再写入该任务的会话 ID 并验证切换成功；
- CLI 任务会按 PID、会话 ID 或会话文件所有者确认任务归属，并持久化 TTY、登录 shell PID 与进程启动时间；点击时只唤起原 Terminal/iTerm 标签页；
- Claude Desktop 任务会把 transcript UUID 映射到 Claude 元数据中最早的原始 `local_*` 任务，再走已验证的 `/epitaxy/<local-id>` 内部路由；只有 `lastFocusedAt` 确认更新后才关闭完成气泡，绝不调用会导入副本的 `claude://resume`；
- Codex CLI、Grok 与真正的 Claude CLI 默认采用“仅唤起”模式：原 agent 仍在时按精确进程定位并复用此前终端；若平台已关闭则先弹窗询问，只有用户选择“打开原任务”后，才在已验证的原终端执行精确 resume，原标签不存在时才新建终端；新进程和会话 ID 连续验证成功后才算唤起成功；
- Codex Desktop、Claude Desktop 或 DSH 页面已关闭时进入强唤起：确认后走包含原 session ID 的会话深链或 DSH 会话选择；Codex 接受系统成功投递的精确 thread 深链，Claude 读回原任务 `lastFocusedAt`，DSH 读回会话 ID；
- Claude 强唤起弹窗提供 Desktop、CLI 和取消三种选择；选 Desktop 时只允许 `/epitaxy/<原 local-id>`，选 CLI 时使用原 `cliSessionId` 执行经过进程验证的 `--resume`；
- 菜单栏 🐾：显示/隐藏、切换或导入宠物、查看四平台状态、打开配置、退出；
- 换宠后会保存 `pet.bundlePath`，下次自动使用。

## CLI 示例

```bash
./allpet init
./allpet status
./allpet watch
./allpet pet list
./allpet pet import "/path/to/local/pet-or-project"
./allpet self-test
```

`status` 会同时打印当前动作、Todo 进度和稳定会话名称（不显示当前轮任务标题）：

```text
AllPet · 2026-09-05 19:11:40 · 宠物 running · DSH 运行中
  Codex        空闲     任务已完成 · 0 会话 · 2m 前
  Claude Code  空闲     任务已完成 · 0 会话 · 1h 前
  DSH          运行中   运行命令：构建 AllPet · 6 会话 · 刚刚
                  ↳ 进度 3/6 · 运行命令：构建 AllPet · 会话：我想要一个桌面宠物可以监控
  Grok         空闲     任务已完成 · 1 会话 · 4m 前
```


## GitHub 热门宠物模型复用接口

AllPet 提供一个**本地导入适配层**，对应 GitHub 以 `desktop pet` 搜索并按 Star 排序的前三个宠物项目（调研快照：2026-09-06）：

| 项目 | 快照 Star | 原生格式 | AllPet 复用方式 | 许可证边界 |
|---|---:|---|---|---|
| [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha) | 14,284 | `pet.json`；V2 atlas 或 V1 `single-image` | V2 图集原路径直接读取；单图在本机映射为 9 状态图集 | 项目 MIT；角色素材仍遵守作者授权 |
| [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) | 6,152 | `themes/<theme>/theme.json` + 状态 SVG/GIF | 读取原生状态表，优先抽取 GIF 动画帧，SVG 作为静态回退 | AGPL-3.0；只消费用户已有本地 checkout，不把代码/素材放入本仓库 |
| [SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat) | 2,108 | 角色 `settings.yml` + `avatar/`，可选 Live2D | 按表情名映射为 9 状态静态帧 | AGPL-3.0；角色版权、Live2D 模型和 Cubism 许可独立，因此当前明确使用 avatar 静态回退 |

两种入口：

1. 菜单栏 **🐾 → 宠物 → 导入热门项目宠物…**，选择 `pet.json`、clawd 项目/主题目录，或解压后的 LingChat 角色目录；导入成功后立即切换。
2. 命令行 `./allpet pet import PATH`；它会导入并写入默认 `pet.bundlePath`，GUI 已运行时再执行 `./allpet restart`。

归一化后的用户本地包写入 `~/.config/all-pet/pets/<safe-id>/`，清单会保留 `sourceProject`、`sourceLicense`、`sourcePath` 和适配模式。导入器不联网、不自动克隆、不内置上述项目代码或素材；绝对路径、目录穿越、符号链接和过大输入会被拒绝。cc-haha 自定义目录 `${CLAUDE_CONFIG_DIR:-~/.claude}/cc-haha/pets` 中的 V2 atlas 会被直接发现；V1 single-image 需从菜单或 CLI 导入一次。兼容但没有可靠 cc-haha 来源标记的单图清单会按“本地单图宠物”处理，不会被误标为 MIT/cc-haha。

## 配置

配置文件：`~/.config/all-pet/config.json`（见 [config.example.json](./config.example.json)）：

```json
{
  "pet": { "enabled": true, "scale": 0.5833333333, "anchor": "bottom-right", "bundlePath": null },
  "watch": { "pollIntervalMilliseconds": 1000, "activeWindowSeconds": 8, "waitingWindowSeconds": 120 },
  "platforms": {
    "codex":  { "enabled": true, "paths": ["~/.codex/sessions"] },
    "claude": { "enabled": true, "paths": ["~/.claude/projects"] },
    "dsh":    { "enabled": true, "paths": ["~/.dsh/sessions"] },
    "grok":   { "enabled": true, "paths": ["~/.grok/logs/unified.jsonl", "~/.grok/active_sessions.json"] }
  }
}
```

- `platforms.<id>.enabled`：关闭某个平台后不再监控；
- `platforms.<id>.paths`：自定义信号源路径，空数组使用默认路径；
- `pet.bundlePath`：包含 `pet.json` 与其 `spritesheetPath` 指向的 PNG/WebP 图集的宠物目录；`null` 自动发现；
- `pet.scale`：宠物缩放比例；默认 `112/192`，即 Codex 原生 112pt 宽度；
- `pet.anchor`：`bottom-right` / `bottom-left` / `top-right` / `top-left`。

## 手动构建（可选）

通常无需手动构建，`./allpet` 已处理 SwiftPM 在本机的缓存与 sandbox 参数。需要手动构建时：

```bash
SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.swiftpm/module-cache" \
  swift build -c release --scratch-path "$PWD/.build" --disable-sandbox
```

## 项目结构

```text
allpet                          # 一键构建/启动/停止/重启脚本
Sources/
├── AllPetCore/
│   ├── PlatformState.swift     # 平台阶段、TaskInfo、气泡展示模型
│   ├── ActivityScanner.swift   # 会话发现、尾部读取、会话选择
│   ├── TaskExtractors.swift    # Codex / Claude / DSH / Grok JSONL 任务解析
│   ├── DSHTranscriptDecoder.swift # zstd 解压与上下文缓存
│   ├── *Monitor.swift          # 四个平台监控器
│   ├── Aggregator.swift        # 多平台状态 → 宠物动画
│   ├── SelfTest.swift          # 无 XCTest 依赖的内建回归检查
│   ├── PetModelImporter.swift  # 三个热门项目格式的本地适配层
│   ├── ClaudeDesktopSessionLookup.swift # CLI UUID → 原 Claude Desktop 任务
│   └── Pet*.swift / Configuration.swift
└── allpet/
    ├── PetApp.swift            # AppKit 悬浮窗、动画、任务历史、菜单栏
    ├── TaskTrayView.swift      # 三阶段 Codex 风格气泡与平台品牌配色
    ├── TaskLauncher.swift      # 对应平台会话唤起
    └── main.swift              # GUI / CLI 入口
```

## 参考与复用

本项目核心实现参考并复用了两个 MIT 开源项目（详见
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)）：

- [openpets](https://github.com/alterhq/openpets)：Codex 宠物图集、动画状态机、`pet.json` 规范
- [codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet)：agent 活动状态到宠物姿势的映射、DSH 活动信号来源

cc-haha、clawd-on-desk、LingChat 是格式适配目标，不是 vendored 依赖；AllPet 仓库未复制它们的实现或宠物素材。

## 许可

MIT。第三方引用见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
