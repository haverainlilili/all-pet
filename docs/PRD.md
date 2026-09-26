# AllPet 产品需求文档（现状版 PRD）

> 本文以 v1.4.1 为产品基线。完整点击、悬停、拖动及取消行为见 [功能设计说明](功能设计说明.md)，逐平台实测边界见 [平台行为验收](平台行为验收.md)。

当前开发分支已实现三系统统一的 Mac 风格级联菜单，以及 Electron 原终端绑定、点击定位和手动查看检测。此项尚未发布；下面的 v1.4.1 能力表保留为发布基线。新增交互、终端配置和未覆盖场景分别以 [功能设计说明的开发版补充](功能设计说明.md#当前开发版补充菜单交互与终端定位)、[终端接入矩阵](../desktop/integrations/README.md) 和 [实际验收记录](平台行为验收.md) 为准。

## 0. 文档信息

| 项目 | 内容 |
|---|---|
| 产品名称 | AllPet |
| PRD / 发布基线 | v1.4.1 |
| 日期 | 2026-09-26 |
| 安装包 | macOS arm64、Windows x64、Linux x64 |
| 产品阶段 | 开源桌面工具；macOS 覆盖最完整，其他系统与第三方客户端仍有能力差异 |

✅ 表示已实现并纳入本版本；⚠️ 表示部分实现或平台依赖；❌ 表示未实现。构建通过与真实平台操作验收分别记录，不互相替代。

### 0.1 本版变化

- v1.4.1 补齐 Windows/Linux 持续菜单面板：托盘左/右键打开，平台勾选、缩放、宠物选择和刷新不关闭；内嵌大小控件、缩略图与返回按钮。终端 CLI 能力边界见 [专门说明](终端CLI支持说明.md)。

v1.4.0 的功能基础：

- 新增 Cursor、WorkBuddy、Qoder、pi coding agent、智谱 Z Code，总计九平台。
- 平台气泡显示设置持久化；macOS 菜单支持连续勾选。
- 九平台 done/failed 点击即确认，定位失败不恢复；过滤有明确来源的内部子代理。
- macOS Electron 补齐分平台手动查看检测，但并非九平台全部支持。
- 包含 v1.3.0 之后的 DSH 多会话、资源完整性、宠物缩略图与唤起修复。

---

## 1. 产品概述

### 1.1 一句话定位

**AllPet 是一个常驻桌面的 AI 编码任务状态中心，用桌面宠物和任务气泡同时监控 Codex、Claude Code / Desktop、DeepSeek Harness（DSH）、Grok、Cursor、WorkBuddy、Qoder、pi 和 Z Code，并帮助用户快速返回原任务。**

### 1.2 核心价值

1. **一个入口看多个 AI 工具**：不必轮流打开九个平台确认任务是否仍在运行。
2. **把不可见的后台状态变成可感知动画**：运行、等待、完成、失败分别对应宠物动作。
3. **任务完成后可回到原会话**：macOS 尽可能定位到具体应用、终端标签或会话；其它平台至少打开对应平台。
4. **低打扰常驻**：宠物窗口透明、置顶、无传统主窗口；气泡仅在有任务或历史卡片时出现。
5. **可个性化**：支持内置宠物、远程宠物源及多种第三方宠物格式。

### 1.3 产品形态

| 形态 | 平台 | 作用 | 当前成熟度 |
| --- | --- | --- | --- |
| 原生 AppKit 桌宠 | macOS 14+，从源码运行 | 完整动画、三层气泡、菜单栏宠物管理、尽力精确唤起 | 最高；**不是当前 Release 安装包的 GUI** |
| Electron 桌宠 | macOS / Windows / Linux | 跨平台动画、三层气泡、托盘和宠物管理 | v1.4.1 三平台安装包实际提供的 GUI；存在平台差异 |
| Swift CLI / sidecar | macOS / Windows / Linux | `status`、`watch`、JSON sidecar、宠物命令 | 核心监控跨平台；`self-test` 仅 macOS |
| GitHub Releases | macOS arm64 / Windows x64 / Linux x64 | Electron GUI + 内嵌 Swift sidecar 的预编译安装包 | v1.4.1 发布目标 |

---

## 2. 背景与用户问题

AI 编码用户常同时使用多个 harness：例如 GPT/Codex 负责编码、Claude Code 处理重构、DSH 执行长任务、Grok 处理另一项目。每个平台有独立窗口、终端或网页，导致以下问题：

1. **状态分散**：用户需要反复切窗口查看是否完成、等待输入或失败。
2. **完成不可感知**：长任务在后台完成后，没有统一、持续可见的提醒。
3. **会话返回成本高**：平台打开后还要再次寻找原项目、原标签页或原会话。
4. **并发会话容易遗漏**：同一平台同时运行多个任务时，单一状态提示不够。
5. **传统通知过于瞬时**：系统通知消失后缺乏可回看的任务卡片。
6. **桌面工具缺少情感反馈**：纯状态栏/日志虽然准确，但不够直观和有陪伴感。

AllPet 用“本地日志监控 + 统一状态模型 + 桌宠动画 + 持久任务气泡”解决上述问题。

---

## 3. 产品目标与非目标

### 3.1 产品目标

| 编号 | 目标 | 验收口径 |
| --- | --- | --- |
| G1 | 同时监控九个平台 | Codex、Claude、DSH、Grok 均能产生统一快照 |
| G2 | 低延迟反映任务状态 | 默认 1 秒轮询；正常日志更新后约 1–2 秒反映到 UI |
| G3 | 不遗漏近期并发任务 | 支持的平台应输出 `tasks`，单平台最多取 5 个近期任务 |
| G4 | 完成任务可回看 | 完成/失败卡片持久化，24 小时内或手动处理前保留 |
| G5 | 尽量回到原任务 | macOS 在上游能力允许时定位到具体会话/终端/网页 |
| G6 | 数据本地处理 | 任务日志和标题不上传，不要求平台账号/API Key |
| G7 | 允许用户更换宠物 | 内置/标准图集宠物可切换；本地多格式转换明确限 macOS |
| G8 | 核心逻辑跨平台复用 | AllPetCore 与 JSON sidecar 在 macOS/Windows/Linux 构建通过 |

### 3.2 非目标

当前 AllPet **不负责**：

- 创建、编排或取消 AI 编码任务；
- 替代 Codex、Claude、DSH 或 Grok 自身界面；
- 云端同步任务、团队协作或跨设备历史；
- 修改模型、提示词或 harness 配置；
- 保证第三方平台未公开的会话深链能力；
- 远程上传用户日志用于分析；
- 在当前版本提供应用内自动更新。

---

## 4. 目标用户

### 4.1 核心用户

**多 Harness AI 开发者**

- 同时使用两个以上 AI 编码平台；
- 会让任务长时间在后台运行；
- 需要快速判断“运行/等待/完成/失败”；
- 愿意授予 macOS 辅助功能权限以获得更精确的任务唤起。

### 4.2 次级用户

1. **AI 工具重度用户**：同时开多个项目/会话，需要持久任务历史。
2. **桌宠爱好者**：重视外观、动画和自定义宠物导入。
3. **CLI/自动化用户**：希望消费 `status --json` / `watch --json` 统一状态。
4. **跨平台贡献者**：重点补齐 Windows/Linux 展示、托盘、窗口和唤起差异。

### 4.3 用户故事

- 作为多平台开发者，我希望一眼知道哪个 Agent 正在运行、等待或已失败。
- 作为长任务用户，我希望完成卡片不会像系统通知一样立即消失。
- 作为并发任务用户，我希望同一平台的多个会话都进入任务列表。
- 作为 macOS 用户，我希望点击气泡尽量回到原会话，而不是只打开应用首页。
- 作为 Windows/Linux 用户，我希望至少能打开对应平台，并获得与 macOS 接近的气泡展示。
- 作为宠物创作者，我希望把标准图集或兼容项目导入 AllPet。

---

## 5. 产品总体架构

```text
平台本地数据
├─ ~/.codex/sessions/**/*.jsonl
├─ ~/.claude/projects/**/*.jsonl
├─ ~/.dsh/sessions/**/session.jsonl.zstd
└─ ~/.grok/logs/unified.jsonl + active_sessions.json
        │
        ▼
AllPetCore 平台监控器
CodexMonitor / ClaudeMonitor / DSHMonitor / GrokMonitor
        │
        ▼
统一模型 PlatformStatus
phase + task + tasks + activeSessions + detail
        │
        ▼
Aggregator
全局优先级 + 宠物动画 + 摘要
        │
        ├─ macOS AppKit GUI
        ├─ allpet status/watch CLI
        └─ watch --json → Electron 主进程 → Windows/Linux/macOS Electron UI
```

### 5.1 设计原则

- **本地优先**：直接读取本地会话日志，不调用各模型云端 API。
- **共享核心**：解析、状态、宠物清单与 JSON 输出放在 `AllPetCore`。
- **平台增强**：macOS 使用 AppKit、Accessibility、Apple Events 做精确交互。
- **向后兼容**：`task` 保留主任务；`tasks` 为多会话扩展字段。
- **失败安全**：无法精确定位时保留气泡，不随意打开错误会话或创建副本。

---

## 6. 核心业务对象与状态模型

### 6.1 平台

固定支持：

- `codex` → Codex
- `claude` → Claude Code（含 Claude Desktop 来源）
- `dsh` → DeepSeek Harness
- `grok` → Grok
- `cursor` → Cursor
- `workbuddy` → WorkBuddy
- `qoder` → Qoder
- `pi` → pi coding agent
- `zcode` → 智谱 Z Code

### 6.2 任务字段

| 字段 | 用途 |
| --- | --- |
| `sessionName` | 用户可读会话名称，气泡主名称 |
| `title` | 当前轮用户任务标题，主要用于历史/身份回退 |
| `action` | 当前动作，如“正在思考”“运行命令”“任务已完成” |
| `toolName` | 当前调用工具 |
| `completedSteps/totalSteps` | Todo 进度 |
| `sessionID` | 唤起和去重的稳定会话 ID |
| `sourcePath` | 原始日志路径，用于身份与有效性校验 |
| `workingDirectory` | 原任务工作目录 |
| `terminalBinding/TTY/PID` | macOS 终端定位 |
| `launchOrigin` | 区分 Desktop / CLI 来源 |
| `scheduledTaskName` | Claude 定时任务归并标识 |
| `phase` | 每个任务自己的状态，支持多会话独立展示 |

### 6.3 状态

| 状态 | 含义 | 默认判断 |
| --- | --- | --- |
| `idle` | 无近期任务活动 | 超出等待窗口且无终态 |
| `running` | 正在执行工具或生成内容 | 近期日志活动/运行事件 |
| `thinking` | Agent 正在推理 | 平台显式 thinking/step start |
| `waiting` | 暂停、阻塞或等待下一步 | 8 秒后至 120 秒，或显式 blocked/interrupted |
| `done` | 正常完成 | 平台终止事件为 completed/end turn |
| `failed` | 工具、Agent 或任务失败 | error/max-tokens/API 错误等 |

默认时间参数：

- 轮询间隔：`1000ms`；
- 活跃窗口：`8s`；
- 等待窗口：`120s`；
- 原生 GUI 最低轮询：`400ms`；CLI 最低轮询：`200ms`。

### 6.4 全局状态优先级

```text
failed > running/thinking > waiting > done > idle
```

映射动画：

| 全局状态 | 宠物动画 |
| --- | --- |
| failed | `failed` |
| running / thinking | `running` |
| waiting | `waiting` |
| done | `review` |
| idle | `idle` |

---

## 7. 功能需求

### FR-01 九平台状态监控

#### FR-01.1 Codex

| 项目 | 当前实现 |
| --- | --- |
| 数据源 | `~/.codex/sessions/**/*.jsonl` |
| 识别内容 | 用户任务、工具调用、完成/错误、会话 ID、cwd、来源 |
| 会话名称 | session projection/index 查询 |
| 多会话 | ✅ 近期会话逐个解析，最多输出 5 个 |
| 过滤 | 排除 DSH 起源记录；排除 `thread_source=subagent` |
| 终态 | 完成/失败保留；僵尸进行中任务使用硬超时清理 |
| 来源区分 | Codex Desktop / Codex CLI |

**验收：** 同时运行两个 Codex 顶层会话时，`status --json` 的 Codex `tasks` 至少包含两个不同 `sessionID`。

#### FR-01.2 Claude Code / Desktop

| 项目 | 当前实现 |
| --- | --- |
| 数据源 | `~/.claude/projects/**/*.jsonl` |
| 识别内容 | 用户消息、工具调用、Todo、API 错误、结束原因、定时任务 |
| 多会话 | ✅ 近期会话逐个解析，最多输出 5 个 |
| 过滤 | 排除 `/subagents/`；过滤无会话名且非定时任务的临时/测试会话 |
| Desktop 补充数据 | macOS 读取 Claude Desktop `claude-code-sessions` 元数据，关联 `local_*` 与 CLI session |
| 定时任务 | 按 `scheduledTaskName` 归并为同一气泡 |

**验收：** 多个有名称 Claude 会话并发活动时分别展示；“reply with ok”一类无标题临时会话不占用气泡。

#### FR-01.3 DSH

| 项目 | 当前实现 |
| --- | --- |
| 数据源 | `~/.dsh/sessions/**/session.jsonl.zstd` |
| 解析依赖 | Core 支持外部 `zstdcat`/`zstd`；Electron 安装包通过自身 Node zlib 注入内置 decoder，无需系统另装 zstd |
| 识别内容 | 标题、用户任务、工具、Todo、turn 状态、错误、cwd |
| 会话名称 | `storages/session_projcache/sessions/<id>.json` 优先 |
| 过滤 | 只监控父目录名以 `session-` 开头的顶层会话，排除子代理日志 |
| 多会话 | ✅ 主会话 + 近期其它会话，最多 5 个；v1.4.0 已包含 |
| 主任务优先 | `DSH_SESSION_JSONL` 指定的当前 DSH 会话优先 |

**验收：** 当扫描器统计到 3 个近期顶层会话时，`activeSessions=3` 且 `tasks.count=3`；每项保留独立 phase。

#### FR-01.4 Grok

| 项目 | 当前实现 |
| --- | --- |
| 数据源 | `~/.grok/logs/unified.jsonl`、`~/.grok/active_sessions.json` |
| 识别内容 | 阶段迁移、完成/失败、活动会话、cwd、PID、终端绑定 |
| 会话名称 | 优先使用活动会话 cwd 的项目名 |
| 多会话 | ⚠️ `activeSessions` 可计数多个，但详细 `task/tasks` 当前只选择一个主会话 |
| 过滤 | 仅让全局错误归属到明确会话，避免 OIDC/daemon 错误冒充任务失败 |

**验收：** 有有效 active session 时展示选中会话；无任务活动时显示空闲而不是把后台认证错误显示为任务失败。

---

#### FR-01.5 新增五平台

Cursor/Qoder 读取本地 transcript 并可安装观察 hooks；WorkBuddy/pi 读取原生 JSONL；Z Code 只读 SQLite 并跟踪 WAL 更新。各平台进入相同状态、历史和展示开关流程。路径、安装命令、原生格式与定位限制见 [平台接入说明](平台接入说明.md)。

### FR-02 宠物动画与窗口

#### 7.2.1 动画规范

标准图集为 8 列：v1 为 9 行，v2 可为 11 行。核心提供 9 种动画：

`idle`、`running-right`、`running-left`、`waving`、`jumping`、`failed`、`waiting`、`running`、`review`。

- `idle` 自循环；
- 非 idle 动作播放 3 遍后回到 idle 尾段；
- 系统开启“降低动态效果”时只显示首帧，并冻结运行/思考 spinner 与 Stage 1 多平台轮播；运行中切换系统设置立即生效；
- 状态动画可被拖动、悬停等交互动画临时覆盖。

#### 7.2.2 macOS 原生窗口

- 无 Dock 图标的菜单栏应用；
- 透明、无边框、浮动窗口；
- 所有 Space/全屏辅助层可见；
- 默认右下角，边距 20pt；支持四角 anchor；
- 精灵显示宽度限制 80–224px；默认约 112px；
- 只能拖动精灵本体；窗口尺寸变化不应造成精灵位置跳动。

#### 7.2.3 Electron 窗口

- 透明、置顶、托盘常驻；
- 复用相同 scale、动画表和图集，并尝试读取同一 anchor 配置；
- Electron 已按左上坐标系修正 anchor 纵向映射，并在气泡阶段变化时保持宠物屏幕位置不跳动；
- Linux 透明效果依赖 compositor；GNOME 托盘依赖 AppIndicator；
- Windows 无 macOS Space 概念。

---

### FR-03 三层任务气泡

#### 7.3.1 Stage 1：收起态

- 展示最新完成任务，最多 3 个；超出显示 `+N 个已完成`；
- 未完成平台以轮播堆栈展示，macOS 每 3.2 秒轮换；
- 每条显示平台色、会话名、状态图标；
- 点击气泡或宠物进入 Stage 2；
- macOS 完成卡可直接点击返回任务或使用 `×` 关闭。

#### 7.3.2 Stage 2：平台态（macOS 原生基准）

- 最多展示 Codex、Claude、DSH、Grok 九个平台；
- 每个平台显示最多 5 条任务名称，超出显示 `+N`；
- 无任务平台显示“暂无会话 · 点击打开”；
- 一条任务时直接唤起；多条任务进入 Stage 3。

#### 7.3.3 Stage 3：任务态（macOS 原生基准）

- 标题为“<平台> 的任务”；
- 最多显示 6 条任务，超出显示 `+N 个任务`；
- 每条包含平台、会话名、动作、进度和状态；
- 支持点击唤起、`×` 删除、返回 Stage 2。

#### 7.3.4 Electron 气泡差异

- 三阶段尺寸、卡片高度、Stage 1 完成卡与轮播露边堆栈、Stage 2 最多 5 条任务、Stage 3 最多 6 条任务已按 AppKit 基准对齐；
- 运行/思考 spinner、等待时钟、完成勾、失败叹号、深浅色卡片和平台品牌色已对齐；
- 支持点击返回/收起、窗口失焦收起，窗口按 304/324/334px 动态缩放并保持宠物位置；
- 剩余差异：Codex Desktop 可发送 session 深链但无法验证最终页面；CLI/Claude/Grok 任务在无法验证目标时 fail-closed。DSH 任务卡改为向已认证的系统浏览器发送仅位于 URL fragment 的 session handoff；DSH 客户端等待该 session 出现在权威列表后执行 `sessions.open` 并清理 fragment，不再弹出“只打开基页”的降级提示。

#### 7.3.5 品牌与状态颜色

- Codex：绿色；
- Claude：棕橙色；
- DSH：蓝紫色；
- Grok：随深浅模式使用黑/白；
- 运行/思考：蓝；等待：橙；完成：绿；失败：红。

---

### FR-04 任务历史与生命周期

#### 7.4.1 持久化

- 文件：`~/.config/all-pet/task-history.json`；
- 每个平台最多 12 条；
- 以平台 + session ID/定时任务名形成 canonical ID 去重；
- `dismissedTaskIDs` 最多 100 条；
- macOS 与 Electron 共用兼容的数据结构；Electron 加载时执行 canonical ID migration、DSH UUID 归一化、非法 shape/未知平台/子代理/合成任务过滤、去重、12/100 上限和 TTL，已 dismiss 的终态不会复活；
- Electron 与 sidecar 共同尊重 `ALLPET_HOME`，config、history、宠物发现和监控根目录不会再分裂。

#### 7.4.2 完成/失败卡片

- 完成/失败任务进入持久历史；
- 自动保留 24 小时；Electron 使用独立 wall-clock timer，不依赖 sidecar 产生新快照；
- 用户可点击 `×` 提前删除；
- macOS 按平台检测手动查看：Codex、Claude、DSH、Grok、pi 需满足精确会话或有效原终端绑定条件；Cursor、WorkBuddy、Qoder、Z Code 尚无可靠识别，不能宣称九平台手动查看均可自动消泡。pi 默认日志缺少终端绑定时也不能自动确认。实际验收和权限限制见《平台行为验收》；
- 九个平台的完成/失败通知点击即确认并持久移除，与能否精确聚焦原会话独立；原生和 Electron 均适用，活动中的任务不因点击被确认。
- Electron macOS 已补齐 Codex：每 0.5 秒独立检查前台唯一任务标题，并识别本地同账号/主机的“未读→已读”变化；确认后持久化清除同一轮次的 done 通知。首次未读缺失不视为已读，隐藏平台与非 done 不清理；Claude、DSH、Grok、pi 也已接入独立检测通道，但需满足各自证据条件；另外四个平台及 Windows/Linux 尚无同等检测。

#### 7.4.3 活跃任务清理

- 平台变为空闲时清除 running/thinking/waiting 历史，只保留终态；
- 会话切换时清理不再活跃的旧进行中记录；
- 已隐藏的活跃任务重新出现活动时可解除隐藏；已隐藏终态保持隐藏；
- macOS 的 `done` 和 `failed` dismissed ID 均持久化；进行中的手动隐藏仍只保存在内存中。重新观察到同会话非终态活动时撤销旧终态确认，下一轮任务可再次展示。

---

### FR-05 任务唤起与强唤起

#### 7.5.1 macOS 唤起矩阵

| 平台/来源 | 应用仍运行 | 应用已关闭（强唤起） | 精确度/限制 |
| --- | --- | --- | --- |
| Codex Desktop | `codex://threads/<sessionID>` | 启动同一深链 | 可精确会话 |
| Codex CLI | 聚焦原终端/tab | `codex resume <sessionID>` | 依赖终端识别与辅助功能 |
| Claude CLI | 聚焦原终端/tab | `claude --resume <sessionID>` | 可按 CLI 会话恢复 |
| Claude Desktop | 激活应用；当前已是目标会话则视为查看 | 打开应用本体 | 上游没有安全的现有会话深链；用户可能需在侧栏手动选择 |
| DSH | 聚焦已有 DSH 浏览器页并选择 session | 打开 `127.0.0.1:3080` 后尝试选择 | 依赖本地 DSH 页面、浏览器自动化和会话仍存在 |
| Grok CLI | 聚焦原终端/tab | `grok --cwd ... --resume <sessionID>` | 依赖本地可执行文件和终端权限 |

安全原则：如果无法确认原会话，不应退回错误应用首页或创建会话副本；按真实结果向用户说明。九平台终态通知在点击时确认，不因唤起失败恢复；活跃任务保留。

#### 7.5.2 Electron 唤起

- 任务卡片与单任务平台卡只向主进程传 canonical task ID；路径、PID、终端绑定等 locator 不进入渲染层；
- 只有来源明确为 Codex Desktop 且带 session ID 的任务才发送 `codex://threads/<sessionID>`；系统接收深链不等于已验证目标会话显示，终态卡片已由点击确认，活跃卡片继续保留；
- Codex/Claude/Grok CLI 与未知来源在无法验证精确目标时不启动裸 CLI，避免创建重复会话；九平台 done/failed 点击后已确认移除，活跃卡片保留。来源经 metadata 确认的 macOS Claude Desktop 任务仅发送应用激活请求，不调用会导入/复制会话的 resume，用户可能仍需在侧栏选择；DSH 任务卡使用 `#allpet-session=<encoded ID>` 交给已认证的系统浏览器；fragment 不发送到服务器，DSH 客户端只在目标存在于权威 session 列表时选择并清理该 fragment，浏览器认证 cookie 不会复制给 AllPet；
- 无具体任务的 DSH 平台打开继续使用 Electron `shell.openExternal`；具体任务卡使用同一系统浏览器的精确 session fragment handoff，不再打开可能落在其它会话的基页；
- Windows/Linux 的显式 CLI 平台打开使用可见终端适配器；Linux 会依次探测多种终端，启动器非零退出/缺失时显示失败，成功也只标记 request accepted 而不宣称应用已显示；
- sidecar JSON 传递完整 locator 元数据，`watch --json` 变更 key 纳入全部任务与 `activeSessions`，次级会话变化可及时送达。

#### 7.5.3 权限

macOS 精确唤起可能需要：

- 辅助功能权限；
- Apple Events/浏览器自动化权限；
- 目标终端或浏览器允许脚本控制。

---

### FR-06 宠物管理

#### 7.6.1 内置宠物

当前源码的 SwiftPM 资源中内置 5 个离线宠物：

- Boba
- Tiko
- 团团和米粒（`cat-hamster-duo`）
- Hoops
- Watermelon

从源码运行时，首次发现宠物会物化到 `~/.config/all-pet/pets/`；写入标记后不再强制补回用户主动删除的内置宠物。

> ❌ **v1.3.0 Release 历史缺陷：** `AllPet-1.3.0-arm64-mac.zip` 的 sidecar 只有 `allpet`，遗漏承载内置宠物的 SwiftPM 资源。✅ main 已修复后续打包：按平台保留 `AllPet_AllPetCore.bundle`（macOS）或 `.resources`（Windows/Linux）的原名，sidecar 使用静态 Swift stdlib 构建（Windows 同时复制相邻 Swift/Foundation runtime DLL 闭包），并在空 HOME、无 Swift toolchain PATH 下验证资源发现；Linux CI 还会启动 electron-builder 的实际 unpacked 应用。该修复随 v1.4.0 发布，旧 v1.3.0 资产不会被修改。

#### 7.6.2 管理操作

- 查看已安装宠物及缩略图；Electron 优先在主进程裁剪为最大 72×72、96 KiB 的 PNG，nativeImage 不支持的格式通过仅映射已验证 catalog 路径的只读协议逐张裁剪，不再把完整 atlas base64 送过 IPC；
- 点击立即切换；
- 调整大小并即时保存；
- 删除宠物；
- 下载默认宠物；
- 从 Petdex / Awesome Codex Pet 远程安装；
- 输入预设 ID 或 GitHub URL 安装；
- 从本地文件/目录导入兼容宠物；
- Electron 的 set/delete/install/import/refresh 进入同一事务锁：操作中禁用冲突控件，完成后一次性刷新精灵、管理器和托盘；显式刷新会修复外部删除或失效的当前选择；精灵路径和 atlas 几何只采用 sidecar 已验证 catalog，不再次信任可能已被替换的原始 manifest；
- AppKit 在菜单创建前校验并持久化当前宠物：fresh/stale `bundlePath` 回退第一只有效宠物；disabled 时持有隐藏窗口，无宠物后首次安装/选择可立即挂载而无需重启；
- AppKit 的 install/import/select/delete/refresh 进入同一操作闸门：忙碌期间禁用冲突操作和大小调整，结束后统一恢复、重新发现目录和更新菜单；
- 切换/删除使用规范化 bundle 路径，避免重复 ID 或子串 ID 误操作另一只宠物；
- AppKit 与 Electron 在气泡、缩放、换宠物后均保持精灵左下角，并将完整窗口夹紧到当前显示器 work area 的 20px 边距；支持负坐标副屏。

#### 7.6.3 支持格式

- Codex / OpenPets `pet.json + spritesheet.webp`；
- 单图宠物；
- cc-haha；
- clawd-on-desk `theme.json`；
- LingChat `settings.yml` / avatar 资源。

#### 7.6.4 平台限制

- ✅ Petdex/Awesome Codex Pet 的标准图集下载逻辑为跨平台 Foundation 实现；
- ⚠️ 本地图片转换及第三方格式归一化依赖 AppKit/ImageIO，当前完整导入能力仅 macOS；
- Electron 在 Windows/Linux 将本地导入显示为禁用的“仅 macOS”入口，并给出原因，不再调用已知不支持的底层转换；
- GitHub 预设若需要格式转换，在 Windows/Linux 同样受限。

#### 7.6.5 宠物制作规范

仓库提供“宠物生成标准包”，包含：

- 角色设计和交付规范；
- 分状态文生图 Prompt；
- 图集拼装/校验脚本；
- 导入 AllPet 指南；
- 标准输出 `pet.json + spritesheet.webp`。

---

### FR-07 菜单、托盘与配置

#### 7.7.1 macOS 状态栏菜单

- 显示/隐藏宠物；
- 大小 `− / 百分比 / ＋`，连续点击不关闭菜单；
- 宠物子菜单：切换、删除、下载、GitHub 安装、本地导入；
- 九个平台当前状态摘要；
- 打开配置；
- 退出。

#### 7.7.2 Electron 托盘

- 显示/隐藏宠物；macOS 点击菜单栏图标只打开原生菜单，不再意外切换宠物可见性；Windows/Linux 左/右键托盘图标打开持续菜单面板；
- 打开宠物管理窗口、打开配置；
- 按 AppKit 顺序显示大小百分比、宠物子菜单、九个平台状态、配置与退出；平台状态包含最多 28 个字符的当前动作，禁用的平台明确显示“已禁用”而非永久“加载中…”；
- 宠物子菜单可直接切换/删除已安装宠物、安装未安装默认宠物、进入 GitHub 安装或本地导入入口，并进入完整管理器或刷新目录；删除确认显示规范化 bundle 路径；
- macOS 由 AppKit 原生菜单桥接承载状态栏菜单，使用 `NSMenuItem.view` 原位更新 − / 百分比 / ＋；点击 ±5% 时菜单保持打开、不再关闭重开，Windows/Linux v1.4.1 面板同样连续操作不关闭，管理窗口也提供大小调整；
- macOS 原生“宠物 ›”子菜单在每只宠物左侧显示小形象；图标按 sidecar 验证过的 cell 几何使用 `nativeImage.crop` 明确裁切 atlas 左上角 `(0,0)` 的完整 idle 首帧，`sips` 仅在 Electron 无法解码 WebP 等格式时负责转成临时 PNG、不参与裁切；最终仅把 `menu-v4` 的 ≤20×20 小 PNG 持久缓存交给菜单桥接，菜单打开时不读取或解码完整 atlas；
- Electron 使用单实例、托盘常驻生命周期；关闭窗口不会退出，退出时只清理一次 watcher 和重启计时器。

#### 7.7.3 配置

文件：`~/.config/all-pet/config.json`

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `pet.enabled` | `true` | 是否显示宠物 |
| `pet.scale` | `112/192` | 宠物缩放 |
| `pet.anchor` | `bottom-right` | 四角定位 |
| `pet.bundlePath` | 空 | 当前宠物目录 |
| `watch.pollIntervalMilliseconds` | `1000` | 轮询频率 |
| `watch.activeWindowSeconds` | `8` | 活跃窗口 |
| `watch.waitingWindowSeconds` | `120` | 等待/近期会话窗口 |
| `platforms.<kind>.enabled` | `true` | 平台开关 |
| `platforms.<kind>.paths` | 默认日志路径 | 自定义日志位置 |

配置缺失或损坏时回退默认值；缺失的平台键自动补齐默认路径。

---

气泡显示平台设置：顶层 `hiddenBubblePlatforms` 保存被隐藏平台；不停止监控或删除历史。macOS 原生菜单及 Windows/Linux v1.4.1 面板勾选、全部显示/隐藏后保持展开，Esc/外部点击关闭。

### FR-08 CLI 与自动化接口

#### 7.8.1 命令

| 命令 | 功能 |
| --- | --- |
| `allpet init` | 生成默认配置 |
| `allpet status` | 输出一次人类可读快照 |
| `allpet status --json` | 输出一次 JSON 快照 |
| `allpet watch` | 状态变化时持续输出人类可读快照 |
| `allpet watch --json` | 输出 NDJSON，供 Electron/自动化消费 |
| `allpet pet list [--json]` | 列出宠物 |
| `allpet pet install <source>` | 安装默认/远程/GitHub 宠物 |
| `allpet pet set <name>` | 切换宠物 |
| `allpet pet delete <name>` | 删除宠物 |
| `allpet pet import <path>` | 导入本地宠物 |
| `allpet self-test` | macOS 运行解析、状态、气泡、宠物等内建检查；Windows/Linux 当前明确不支持 |
| `allpet gui/run` | macOS 启动原生 GUI |

仓库根目录 `./allpet` 脚本还提供 build/start/stop/restart/logs 体验。

#### 7.8.2 JSON 契约

快照包含：

- 全局 `observedAt / animation / phase / summary`；
- 每平台 `phase / detail / activeSessions / task / tasks / bubbleHeader / bubbleDetails`；
- 每任务 `sessionName / title / action / toolName / progress / sessionID / cwd / scheduledTaskName / phase`。

兼容规则：消费方应优先使用 `tasks`；为空时退回 `task`。

---

### FR-09 安装、发布与更新

#### 7.9.1 当前预编译包

| 平台 | 架构 | 文件 |
| --- | --- | --- |
| macOS 14+ | Apple Silicon arm64（M1–M5） | DMG / ZIP |
| Windows 10/11 | x64（Intel/AMD） | NSIS EXE |
| Linux | x64（Intel/AMD） | AppImage / DEB |

当前未提供 Intel Mac、Windows ARM、Linux ARM 安装包。发布工作流未显式锁定所有目标架构，Release 文件名/CPU 支持应以实际产物和 CI 结果为准。

#### 7.9.2 版本策略

- `main`：最新开发源码；
- `vX.Y.Z`/GitHub Release：稳定预编译快照；
- 普通修复可积累后发布 patch；严重兼容/安全问题应立即发包；
- 文档变化无需重打包；
- ❌ 当前没有应用内自动更新；安装包用户需手动下载新版本；
- ⚠️ macOS 包当前未做 Developer ID 签名/公证。

---

## 8. 关键用户流程

### 8.1 首次启动

1. 从源码启动原生 AppKit GUI，或安装 Electron Release；
2. AppKit 与 Electron 首次发现宠物时都会物化内置宠物；打包版必须携带对应平台原名的 SwiftPM 资源目录；
3. AppKit 与 Electron 在无配置或 `bundlePath` 失效时选择发现顺序中的第一只有效宠物并原子写入配置；`~` 路径按 AppKit/CLI 语义展开；
4. 启动九平台监控；
5. 有可用宠物时显示 idle 动画；平台产生活动后切换动画并显示气泡；
6. macOS 原生用户按需授权辅助功能/自动化权限。

### 8.2 查看并返回任务

1. 用户看到完成或运行气泡；
2. 点击宠物/气泡进入平台列表；
3. 点击平台：一项直接唤起，多项进入任务列表；
4. 点击目标任务；
5. macOS 尝试精确定位，失败时给出原因和强唤起选择；
6. 成功唤起完成/失败任务后，Electron 与 macOS 都移除对应终态气泡；macOS Electron 优先复用 Chrome/Edge/Brave/Arc/Safari 中已有的 DSH 标签页并切换原会话，只有完全不存在 DSH 页面时才首次打开；自动化受阻或无法精确定位时保留卡片并禁止新开重复窗口。

### 8.3 更换宠物

1. 打开菜单/托盘宠物管理；
2. 选择已安装宠物或下载默认宠物；
3. 保存 `bundlePath`；
4. 窗口重排并从 idle 动画开始；
5. 删除当前宠物时回退到另一个已安装宠物。

### 8.4 跟进最新源码

1. `git pull --ff-only`；
2. macOS 执行 `./allpet restart`；
3. Electron 用户重建 Swift sidecar 并运行/打包 `desktop/`；
4. 普通安装包用户等待下一个 GitHub Release。

---

## 9. 非功能需求

### 9.1 性能

- 默认 1 秒轮询；同一轮询未完成时不并发发起下一轮；
- 日志只读取有界尾部并使用解析缓存；
- DSH zstd 流式解码只保留有限尾部/上下文，设置硬超时与 LRU 缓存；Electron 使用随包脚本和自身 Node zlib 解码，AppKit/CLI 仍可发现外部 `zstdcat`/`zstd`；
- 多会话默认最多解析/展示 5 个，避免无限扫描；
- Electron 监控子进程退出后 2 秒自动重启。

### 9.2 稳定性

- 配置损坏时使用默认值；
- 日志缺失时平台进入 idle，不应导致全局崩溃；
- 单个平台失败不影响其它平台快照；
- 定位失败不恢复已点击确认的 done/failed；活跃任务和缺少手动查看证据的通知保留；
- 发布验证包含 Swift 核心与选择契约、Electron Node 行为、九平台格式/只读 SQLite/WAL 集成、AppKit 生命周期、查看桥接、空 HOME sidecar 与 Linux xvfb；实际结果与计数见 [发布说明](releases/v1.4.0.md)。

### 9.3 隐私与安全

- 任务解析在本地完成；
- 不需要 Codex/Claude/DSH/Grok API Key；
- 当前代码没有任务遥测或日志上传；
- 网络只用于用户主动下载宠物、GitHub clone/LFS、默认宠物缩略图预取或下载 Release；
- ⚠️ `config.json` 和 `task-history.json` 是明文，历史包含标题、动作、会话 ID、源路径、cwd、PID/TTY 与来源信息；Electron 新写/迁移文件使用原子替换并收紧为 `0600`（适用平台），但当前仍未加密；
- 宠物导入限制文件大小、像素预算、路径深度、文件数并拒绝符号链接逃逸；
- Electron 启用 `contextIsolation`、关闭 `nodeIntegration`，通过 preload IPC 暴露有限能力；宠物缩略图 fallback 仅由主进程为 sidecar 验证过的 catalog 文件颁发临时 token，并受 CSP 限制；
- macOS 自动化权限由操作系统授权控制。

### 9.4 可访问性

- 支持系统减少动态效果；
- 支持浅色/深色模式；
- 任务卡片使用文字 + 颜色 + 图标表达状态，不能仅依赖颜色；
- 当前尚无完整键盘导航/屏幕阅读器验收，属于后续改进项。

---

## 10. 平台能力矩阵

| 能力 | macOS 原生 | macOS Electron | Windows Electron | Linux Electron |
| --- | --- | --- | --- | --- |
| 九平台监控 | ✅ | ✅ | ✅ | ✅ |
| 动画与三层气泡 | ✅ 完整 | ✅ 展示与交互对齐 | ✅ 展示与交互对齐 | ✅ 展示与交互对齐 |
| Codex/Claude/DSH 多会话展示 | ✅（v1.4.0 含 DSH 修复） | ✅ 全任务变更 key | ✅ 全任务变更 key | ✅ 全任务变更 key |
| 精确任务唤起 | ✅ 尽力实现 | ⚠️ Codex Desktop 深链尝试（未验证）；其余安全降级 | ⚠️ Codex 深链尝试；CLI/DSH 安全降级 | ⚠️ Codex 深链尝试；CLI/DSH 安全降级 |
| 完成任务“已查看”自动消失 | ⚠️ 按平台与定位证据，非九平台全支持 | ⚠️ Codex/Claude/DSH/Grok/pi 条件支持，见验收表 | ⚠️ 无精确检测 | ⚠️ 无精确检测 |
| 24h 完成卡 TTL | ✅ | ✅ | ✅ | ✅ |
| 拖动/悬停动画 | ✅ | ✅ | ✅ | ✅ |
| 所有工作区可见 | ✅ | ✅ | 不适用 | ⚠️ 依赖桌面环境 |
| 宠物大小/切换/删除 | ✅ | ✅ 原生菜单连续缩放、行缩略图、事务化精确 bundle | ✅ 事务化、精确 bundle | ✅ 事务化、精确 bundle |
| 标准远程宠物下载 | ✅ | ✅ | ✅ | ✅ |
| 本地多格式宠物转换 | ✅ | ✅（调用 Swift） | ❌ | ❌ |
| 系统托盘 | ✅ | ✅ | ✅ | ⚠️ GNOME 需扩展 |

> 当前产品明确以 macOS 作为体验基准。Windows/Linux 问题欢迎社区直接提交 PR，维护者审查后合入。

---

## 11. 已知问题与产品风险

### 11.1 P0/P1 已知差距

1. **手动查看检测覆盖不足**：Cursor/WorkBuddy/Qoder/Z Code 尚未实现；pi 缺少 TTY 时不能自动确认。
2. **Electron 精确唤起仍受平台限制**：Codex Desktop 可发送会话深链但无法验证最终页面；CLI 终端 tab、DSH 浏览器 session 仍缺少可移植的精确聚焦 API，因此按实际结果提示；点击已确认的终态不会恢复。
3. **Claude Desktop 无公开现有会话深链**：不能保证自动切到目标会话；禁止使用会 fork 副本的 resume 路径。
4. **Grok 详细多会话不足**：只输出一个选中任务，`activeSessions` 与气泡任务数可能不同。
5. **Windows/Linux 本地宠物转换尚未实现**：Electron 已禁用并解释该入口；标准宠物包远程安装仍可用。
6. **独立 AppKit/CLI 仍依赖外部 zstd**：Electron 优先使用系统 `zstdcat`/`zstd` 以兼容真实 DSH concatenated frames；仅在系统不存在时启用随包 Node fallback；脱离 Electron 启动的原生 AppKit/CLI 仍需外部解码器。
7. **旧安装包不会自动更新**：v1.4.0 修复资源遗漏；v1.3.0 用户需重新下载安装。
8. **发布签名和公证缺失**：macOS 为 ad-hoc 签名，无 Developer ID/公证；Windows 未配置代码签名，系统可能提示。
9. **上游日志格式风险**：九个平台升级后字段或目录变化可能使解析失效。

### 11.2 数据准确性风险

- mtime 是活动信号，不总等于真实任务状态；
- waiting 是时间窗口推断与显式事件的组合；
- 终端进程、TTY 和 tab 的映射依赖应用实现；
- 用户修改默认日志路径或使用非标准安装位置时需手工配置；
- 同名会话需要依赖 session ID 去重，缺少 ID 时可能回退为 `current`。

---

## 12. 建议路线图（未承诺）

### P0：可靠性与发布

1. ✅ main 已修复后续 Release 资源、自包含 sidecar、空 HOME 与 unpacked 应用校验；随 v1.4.0 纳入三平台打包验收；
2. ✅ v1.4.0 包含 DSH 多会话与本轮 Electron 对齐修复；
3. ✅ Electron show/hide、单实例与托盘常驻生命周期已对齐；
4. 补充 Grok 多会话详细任务输出；
5. ✅ Electron 安装包已内置 DSH zstd 解码并以 clean PATH 实际 transcript 验收；独立 AppKit/CLI 依赖检测仍可继续增强；
6. 修正 README 的内置宠物数量、全平台 `self-test`、会话级唤起和非 macOS 导入承诺；
7. 增加“监控诊断”命令，显示路径、依赖、最近候选、过滤原因。

### P1：跨平台体验

1. Windows/Linux 任务级唤起；
2. Windows/Linux 本地宠物导入/图集转换；
3. 继续补齐 Cursor/WorkBuddy/Qoder/Z Code、缺少终端绑定的 pi 及 Windows/Linux 的手动查看检测；
4. macOS 签名、公证；
5. 应用内版本检测与可控更新；
6. Intel Mac / Windows ARM / Linux ARM 打包支持；
7. Linux compositor、托盘能力的首次启动检测。

### P2：可扩展性

1. 平台监控器插件协议，允许社区增加新 harness；
2. 宠物商店/索引的可信来源与许可证展示；
3. 完整键盘操作和屏幕阅读器支持；
4. 用户可配置通知策略、保留时间和平台优先级；
5. 可选、匿名、明确授权的可靠性指标（默认关闭）。

---

## 13. 产品指标与验收建议

当前没有埋点系统。建议在不上传任务内容的前提下，通过本地诊断或可选匿名指标评估：

| 指标 | 建议目标 | 当前可观测方式 |
| --- | --- | --- |
| 状态检测延迟 | P95 ≤ 2 秒 | 本地日志时间 vs `observedAt` |
| 活跃任务漏识别率 | < 1% | 诊断快照与平台会话目录对比 |
| 任务唤起成功率 | macOS 支持场景 ≥ 90% | 本地成功/失败计数，不记录标题 |
| 监控进程自恢复 | 退出后 ≤ 3 秒恢复 | Electron 日志 |
| 崩溃率 | < 1% 会话 | Release/用户反馈 |
| 三平台构建通过率 | 100% | GitHub Actions |
| PR 响应 | Windows/Linux 修复优先审查 | GitHub PR 记录 |

### 13.1 发布验收清单

- [ ] Swift release 构建通过；
- [ ] macOS `allpet self-test` 全部通过；Windows/Linux 至少 `status --json` 冒烟通过；
- [ ] `status --json` 在九个平台字段完整；
- [ ] 并发 Codex/Claude/DSH 会话可进入 `tasks`；
- [ ] macOS 宠物动画、三层气泡、点击唤起手测通过；
- [ ] Electron macOS/Windows/Linux JS 语法和启动冒烟通过；
- [ ] Linux xvfb 主窗口和宠物管理截图通过；
- [ ] DMG/ZIP、EXE、AppImage/DEB 产物齐全；
- [ ] Release 标明操作系统、CPU 架构和限制；
- [ ] README 与安装包版本一致；
- [ ] 已知限制未被营销文案掩盖。

---

## 14. 待产品负责人确认的问题

1. 完成/失败气泡保留 24 小时是否是长期策略，还是未来应允许用户配置？
2. Electron 是否必须追求与 macOS 相同的“精确会话唤起”，还是平台级打开即可接受？
3. Grok 是否需要和 Codex/Claude/DSH 一样的多会话任务列表？
4. Windows/Linux 的本地宠物导入是否进入下一版本 P0？
5. 是否发布 v1.3.1，至少包含 DSH 多会话、Electron 次级任务事件、anchor、Release 资源 bundle 修复？
6. 是否接受增加可选版本检查，但仍不做静默自动更新？
7. 项目未来定位更偏“AI 状态中心”，还是更偏“桌宠生态/宠物制作平台”？两者会影响路线优先级。

---

## 15. 代码与文档索引

| 模块 | 位置 |
| --- | --- |
| 统一配置与路径 | `Sources/AllPetCore/Configuration.swift` |
| 九平台监控协调 | `Sources/AllPetCore/AllPetMonitor.swift` |
| 状态聚合 | `Sources/AllPetCore/Aggregator.swift` |
| 平台状态与任务模型 | `Sources/AllPetCore/PlatformState.swift` |
| Codex/Claude/DSH/Grok 监控 | `Sources/AllPetCore/*Monitor.swift` |
| 任务解析 | `Sources/AllPetCore/TaskExtractors.swift` |
| 动画规范 | `Sources/AllPetCore/PetAnimation.swift` |
| 宠物发现/安装/导入 | `PetDiscovery.swift`、`PetInstaller.swift`、`PetModelImporter.swift` |
| macOS 应用 | `Sources/allpet/PetApp.swift` |
| macOS 三层气泡 | `Sources/allpet/TaskTrayView.swift` |
| macOS 任务唤起 | `Sources/allpet/TaskLauncher.swift` |
| CLI / JSON sidecar | `Sources/allpet/main.swift` |
| Electron 主进程 | `desktop/main.js` |
| Electron 桌宠 UI | `desktop/src/renderer.js` |
| Electron 宠物管理 | `desktop/src/pets.html`、`desktop/src/pets.js` |
| macOS 行为基准 | `docs/macOS-behavior.md` |
| 宠物制作规范 | `宠物生成标准包/` |
