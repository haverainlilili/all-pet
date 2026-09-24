# AllPet · macOS 平台行为基准文档

> 本文档是 macOS 原生 GUI（`Sources/allpet`）的**权威行为记录**，作为其余平台（Electron 壳 / 后续客户端）对齐「展示 + 交互」的唯一基准。
> 所有数值、顺序、文案、阈值均与本文所在提交的源码逐行核对。后续若改 macOS 行为，**必须同步修改本文档**。

---

## 1. 概述

macOS 版是一个**菜单栏应用**（无 Dock 图标、无独立主窗口），由两部分组成：

| 组成 | 载体 | 职责 |
| --- | --- | --- |
| 宠物窗口 | `NSWindow`（borderless，透明悬浮） | 精灵动画 + 任务气泡 |
| 状态栏菜单 | `NSStatusItem`（菜单栏 🐾 图标） | 显示/隐藏、大小调节、宠物管理、平台状态、配置、退出 |

启动流程（`PetApp.run()`）：

```
NSApplication.setActivationPolicy(.accessory)  // 菜单栏应用
→ resolveBundle()  // 校验 fresh/stale bundlePath，回退并原子持久化
→ setupMenuBar()   // 建状态栏菜单（current 勾选读取已修复配置）
→ setupPet()       // 建宠物窗口；pet.enabled=false 时创建但保持隐藏
→ startPolling()   // 轮询多平台状态
→ app.run()
```

- 配置读取失败回退默认值；`bundlePath` 为空或失效时选择发现顺序中的第一只有效宠物并原子写回配置；没有可用 bundle 时状态栏标题变 `🐾(无宠物)`。
- `pet.enabled=false` 仍创建完整窗口但初始隐藏；用户“显示宠物”或之后安装/选择宠物均可在不重启的情况下恢复。若启动时完全没有宠物而 `window=nil`，后续发现/安装 bundle 后“显示宠物”会在同一进程创建并显示窗口。

---

## 2. 宠物窗口

### 2.1 窗口结构

宠物窗口 `contentView` 内垂直排布两个子视图：

```
┌──────────────┐
│  SpriteView  │  y = 0，精灵（动画帧）
├──────────────┤
│  (间距 6pt)   │
│ TaskTrayView │  y = sprite.height + 6，任务气泡
└──────────────┘
```

- 气泡隐藏时，窗口**只保留精灵**（contentView 缩到精灵尺寸）。
- 气泡显示时，窗口高度 = 精灵高 + 6 + 气泡高；宽度 = max(精灵宽, 气泡宽)。

### 2.2 窗口属性（`setupPet`）

| 属性 | 值 |
| --- | --- |
| 样式 | `.borderless`（无边框） |
| 背景 | `isOpaque=false`、`backgroundColor=.clear`（透明） |
| 阴影 | `hasShadow=false` |
| 层级 | `level=.floating`（浮动，常驻顶层） |
| 工作区 | `.canJoinAllSpaces` + `.stationary` + `.fullScreenAuxiliary`（所有 Space/全屏可见） |
| 拖动 | `isMovableByWindowBackground=false`（**只能拖精灵本体**，不能拖背景） |
| 鼠标 | `acceptsMouseMovedEvents=true` |

### 2.3 尺寸（`layoutMetrics`）

```
requestedWidth = atlas.cellWidth(192) × config.pet.scale
codexWidth    = clamp(requestedWidth, 80 … 224)      // 四舍五入
sprite.height = codexWidth × cellHeight(208) / cellWidth(192)   // 保持单帧比例
content.width  = max(sprite.width, tray.width)
content.height = sprite.height + tray.height + 6
```

- 默认 `scale = 112/192 ≈ 0.5833` → 精灵宽 112px、高 ≈121px。
- 精灵宽硬性范围 **80 … 224px**（即 scale 有效范围约 0.4167 … 1.1667）。

### 2.4 定位（`positionWindow`）

- 依据 `config.pet.anchor`（默认 `"bottom-right"`）贴屏幕**主屏 visibleFrame 四角**，边距 **20pt**。
- `isLeft = anchor.hasSuffix("left")`，`isTop = anchor.hasPrefix("top")`。
- 支持四角：`top-left` / `top-right` / `bottom-left` / `bottom-right`。
- 窗口尺寸变化（切宠物 / 调大小 / 气泡展开收起）时，**精灵在屏幕上的原点保持不变**（`updateTaskTrayLayout` 里用精灵原点回推窗口原点，避免跳动）。

---

## 3. 宠物动画

### 3.1 图集与帧索引

- Codex 图集 **8 列**（`columns=8`）；单帧 **192×208**；v1=9 行、v2=11 行。
- 帧索引 = `row × 8 + column`（0-based）。

### 3.2 动画表（`PetAnimation`）

| 动画 | rawValue | 行 row | 帧时长序列（ms） |
| --- | --- | --- | --- |
| idle | `idle` | 0 | `[1680, 660, 660, 840, 840, 1920]` |
| running-right | `running-right` | 1 | `[120,120,120,120,120,120,120,220]` |
| running-left | `running-left` | 2 | `[120,120,120,120,120,120,120,220]` |
| waving | `waving` | 3 | `[140,140,140,280]` |
| jumping | `jumping` | 4 | `[140,140,140,140,280]` |
| failed | `failed` | 5 | `[140,140,140,140,140,140,140,240]` |
| waiting | `waiting` | 6 | `[150,150,150,150,150,260]` |
| running | `running` | 7 | `[120,120,120,120,120,220]` |
| review | `review` | 8 | `[150,150,150,150,150,280]` |

### 3.3 播放规则（`PetAnimation.playback`）

- `idle`：自身 6 帧**循环**（loopStart = 0）。
- 其余动画：**动作段连播 3 遍 + idle 尾巴**，循环起点 = 3 遍动作段之后（`loopStart = action×3.count`）。
- `reduceMotion`（系统「降低动态效果」开启时）：只播放首帧；任务 spinner 固定为 0°、Stage 1 多平台轮播固定第一项。运行中切换系统设置会立即重置精灵和任务托盘 timer。

### 3.4 动画优先级

```
交互动画 (interactionAnimation)   ← 最高，非 nil 时覆盖状态动画
状态动画 (statusAnimation)        ← 由快照映射
```

交互动画结束后（置 nil）回落到 `statusAnimation`。

### 3.5 状态动画映射（`Aggregator.snapshot`）

| 聚合阶段 phase | 动画 |
| --- | --- |
| failed | `failed` |
| running / thinking | `running` |
| waiting | `waiting` |
| done | `review` |
| idle | `idle` |

### 3.6 交互动画（`SpriteView`）

| 交互 | 行为 | 动画 |
| --- | --- | --- |
| 鼠标进入精灵 | — | `jumping` |
| 鼠标离开精灵 | — | 恢复状态动画 |
| 按住拖动（位移 ≥4pt） | 窗口随鼠标移动 | `running-right`（dx≥0）/ `running-left`（dx<0） |
| 拖动松手 | 仍在精灵上 | `jumping` |
| **点击（未拖动）** | 展开气泡到 Stage 2 | 触发 `showPlatformStage()` |

---

## 4. 阶段分类与快照

### 4.1 阶段枚举 `AgentPhase`

| 值 | label |
| --- | --- |
| idle | 空闲 |
| running | 运行中 |
| thinking | 思考中 |
| waiting | 等待中 |
| done | 完成 |
| failed | 出错 |

### 4.2 按「距最近修改时长」推断（`PhaseClassifier.phase`）

| 条件 | 结果 |
| --- | --- |
| age ≤ `activeWindowSeconds`(8s) | running；若检测到错误 → failed |
| age ≤ `waitingWindowSeconds`(120s) | waiting |
| 否则 | idle |

### 4.3 解析结果覆盖推断（`PhaseClassifier.resolved`）

| parsed | 保留条件 |
| --- | --- |
| running / thinking | age ≤ 8s 才保留，否则回落到推断 |
| waiting | age ≤ 120s 才保留，否则回落到推断 |
| **done / failed** | **终态，无条件永久保留**（直到日志出现新活动覆盖） |
| idle | idle |

> 设计意图：done/failed 在阶段分类中是终态，不会因活跃窗口过期而降回 idle；但任务托盘会在 **24 小时 TTL** 后自动移除对应完成/失败卡片。

### 4.4 多平台聚合（`Aggregator.snapshot`）

- 聚合 phase 优先级：`failed` > `running/thinking` > `waiting` > `done` > `idle`。
- `summary` = 所有非空闲平台 `"<label> <phaseLabel>"` 用 `" · "` 连接；全空 → `"全部空闲"`。
- 平台顺序固定：Codex → Claude Code → DSH → Grok（`PlatformKind.allCases`）。

---

## 5. 气泡文案（`PlatformStatus`）

### 5.1 平台名 `PlatformKind.label`

| 平台 | label |
| --- | --- |
| codex | Codex |
| claude | Claude Code |
| dsh | DSH |
| grok | Grok |

### 5.2 `bubbleHeader`

```
"<platform.label> · <phase.label>"
```
例：`DSH · 运行中`、`Codex · 完成`。

### 5.3 `bubbleDetails`（最多 2 行）

1. 第 1 行（动作/标题优先）：
   - 有 `task.action`：`action`；若有进度 → `"进度 <c>/<t> · <action>"`。
   - 无 action 但 `detail` 非空且 ≠ phase.label 且 ≠ `"未检测到会话"`：用 `detail`。
2. 第 2 行：有 `sessionName` 且与第 1 行不重复 → `"会话：<sessionName>"`。

### 5.4 会话显示名（`TrayTaskItem.sessionDisplayName`）

- Claude 定时任务（有 `scheduledTaskName`）：`"定时任务 · <name>"`。
- 其余：`sessionName`（或标题）。

---

## 6. 气泡（任务托盘 `TaskTrayView`）三阶段

### 6.1 阶段定义

| 阶段 | 含义 |
| --- | --- |
| `collapsed`（Stage 1） | 收起：完成卡片 + 未完成平台轮播堆栈 |
| `platforms`（Stage 2） | 每平台一张卡片 |
| `tasks(platform)`（Stage 3） | 单平台全部任务逐条 |

### 6.2 Stage 1（收起）

- **已完成任务**（phase=done）卡片，最多 **3 个**（取最新 3 个），每条显示：
  `平台名(彩色) + 会话显示名 + 状态图标`，右上角「×」删除。
- 完成数 >3：左上角 `+N 个已完成`。
- **未完成平台**：轮播堆栈（`drawRotatingPlatformStack`），最多显示 3 张，主卡片在前、后两张缩进露边（露边 18pt/9pt，透明度递减）；`rotationIndex` 定时轮换顺序。
- 无完成、无未完成 → 回退显示第一个平台气泡。
- 尺寸：宽 **304**，高 = `行数×58 + (行数-1)×7 + 8`（未完成 >1 再加 20）。

### 6.3 Stage 2（平台）

- 每平台一张卡片，最多 **4 张**，每张显示：
  `平台名(彩色加粗) + 任务列表(最多 5 条：小圆点 + 会话显示名) + 状态图标`；超过 5 条 → `+N`。
- 空平台：`暂无会话 · 点击打开`。
- 尺寸：宽 **324**。

### 6.4 Stage 3（单平台任务）

- 头部：`<平台名> 的任务` + 返回按钮。
- 任务逐条（最多 **6 条**），每条：`平台名 + 会话显示名 + 动作 + 状态图标` + 「×」删除；超过 6 → `+N 个任务`。
- 尺寸：宽 **334**。

### 6.5 显示 / 隐藏（`PetApp`）

```
hasNotification = (任一平台 taskHistory 非空) 或 (任一平台 phase ≠ idle)
```
- `hasNotification == false` → 气泡隐藏、窗口缩到精灵。
- `hasNotification == true` → 气泡显示、窗口扩展。

---

## 7. 气泡交互（`TaskTrayView.mouseDown`）

| 目标 | 行为 |
| --- | --- |
| 点击精灵 / 收起态气泡 | 进入 Stage 2（`showPlatformStage`） |
| 点击窗口外部 | 收起回 Stage 1（`collapseToStage1`） |
| 点平台卡片（Stage 2） | 无任务 → 打开平台并收起；1 条任务 → 唤醒该任务；≥2 条 → 进入 Stage 3 |
| 点任务（Stage 1 完成卡 / Stage 3） | 唤醒该任务（`wakeTask`） |
| 「×」删除任务 | 移除气泡：done → 记入 `dismissedTaskIDs`；非 done → 记入 `manuallyHiddenTaskTitles` |
| 「×」删除平台 | 清空该平台历史并收起 |
| 返回（Stage 3） | 回 Stage 2 |

- 悬停卡片/按钮：高亮 + 手型光标。
- 等待态（waiting）有 spinner 转动图标。

---

## 8. 任务历史与持久化

- 存储：`~/.config/all-pet/task-history.json`。
- 每平台历史**去重**（按 `canonicalID`），最多保留 **12 条**。
- `dismissedTaskIDs` 最多保留 **100 条**。
- 过滤规则：合成/占位任务、DSH 子代理任务、DSH 背书的 Codex 任务不入历史。
- **手动隐藏后的复活**：非终态任务保持隐藏，直到同一 canonical ID 的标题发生变化；新的非终态活动也会移除历史 dismissed ID。
- `manualViewGraceInterval=15` 只用于完成任务的“已手动查看”检测：刚唤起任务后的保护窗口避免误判其他完成任务，刚点中的 pending wake 仍可被识别。
- 完成/失败卡片最长保留 24 小时，过期后从历史移除并写入 dismissed。

---

## 9. 状态栏菜单

### 9.1 菜单结构（自上而下）

| 项 | 说明 |
| --- | --- |
| 显示/隐藏宠物 | 切换窗口可见性 |
| **宠物大小** `− 百分比 ＋` | 自定义视图，点按钮**不关菜单**、可连续点击 |
| 宠物 ▸ | 子菜单（见 9.3） |
| （分隔符） | |
| `<平台>：<阶段> · <action 前28字>` | 每平台一行，随快照刷新 |
| （分隔符） | |
| 打开配置 | 用默认编辑器打开 `config.json` |
| 退出 | `NSApp.terminate` |

- 状态栏图标标题：`🐾`（正常）/ `🐾(无宠物)`（无宠物）/ `🐾 安装中…`（安装中）。

### 9.2 宠物大小调节

- 步进 `±0.05`（≈9.6px）。
- scale 设置值夹取范围 `0.4 … 1.2`。
- 百分比显示 = `scale / (112/192) × 100`（默认 100%）。
- 调节后**立即保存 `config.json`** 并重排窗口；菜单保持打开。

> 注意：`scale` 可设 `0.4…1.2`，但**显示宽度**在 `layoutMetrics` 里硬性 clamp 到 `80…224px`（对应 scale 线性区间 `0.4167…1.1667`）；超出该区间的 scale 值会显示为 80px 或 224px。

### 9.3 宠物子菜单（`makePetsMenu`）

1. **已安装宠物**（缩略图 + 名称 + 「当前」勾选 + 「×」删除）。
2. **未安装的默认宠物**（缩略图 + 名称，点一下自动下载并设为当前）。
3. 从 GitHub 安装宠物…（弹输入框）。
4. 导入本地宠物…（弹文件选择）。
5. 格式提示：`cc-haha · clawd-on-desk · LingChat`（不可点）。

### 9.4 菜单打开/关闭行为

| 操作 | 菜单行为 |
| --- | --- |
| 切换宠物、调大小 | **菜单保持打开**（不 cancelTracking）；切换宠物后等菜单关闭再重建子菜单刷新勾选 |
| 删除宠物、下载/安装/导入 | **关闭菜单**（需弹确认框/输入框） |

---

## 10. 宠物管理

- **切换宠物**（`switchPet`）：加载 bundle + 切帧 → 保存 `config.pet.bundlePath` → 重排窗口 → 重置动画（从 idle 开始）；若 disabled/无宠物启动时尚无窗口，会立即创建对应隐藏/可见窗口，无需重启。
- **宠物操作闸门**：install/import/select/delete/refresh 同一时刻只能执行一个；忙碌时大小控件和标准菜单操作禁用、状态栏显示“安装中/导入中/…”，结束后统一恢复并安全重建子菜单。
- **刷新宠物目录**：菜单提供显式刷新；外部删除当前宠物时回退到第一个有效候选，无候选则清空当前宠物。
- **删除宠物**：弹确认框，删除后重排菜单。
- **下载默认宠物**：后台安装，成功自动设为当前并弹完成框。
- **从 GitHub / 导入**：支持预设 ID、远程源命令、GitHub URL、本地文件/目录。

---

## 11. 配置（`~/.config/all-pet/config.json`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `pet.enabled` | `true` | 是否显示宠物 |
| `pet.scale` | `0.5833`（112/192） | 缩放（设置 0.4…1.2；显示 80…224px） |
| `pet.anchor` | `"bottom-right"` | 四角定位 |
| `pet.bundlePath` | — | 当前宠物目录 |
| `watch.pollIntervalMilliseconds` | `1000` | 轮询间隔 |
| `watch.activeWindowSeconds` | `8` | running/thinking 保留窗口 |
| `watch.waitingWindowSeconds` | `120` | waiting 保留窗口 |
| `platforms.<kind>.enabled` | `true` | 平台开关 |
| `platforms.<kind>.paths` | 见下 | 日志/会话路径 |

默认路径：
- codex：`~/.codex/sessions`
- claude：`~/.claude/projects`
- dsh：`~/.dsh/sessions`
- grok：`~/.grok/logs/unified.jsonl` + `~/.grok/active_sessions.json`

---

## 12. 跨平台对齐差距清单（Electron 壳待办）

> 本节记录 Electron 壳（`desktop/`）相对本基准的**已知差距**，用于后续逐项对齐。✅=已对齐。

| # | 维度 | macOS 基准 | Electron 现状 |
| --- | --- | --- | --- |
| 1 | 宠物大小 | scale 共享；显示宽 clamp 80…224px | ✅ 已对齐（80–224px clamp） |
| 2 | 动画帧表 | 9 组行号+帧时长 | ✅ 已对齐 |
| 3 | 动画播放 | 非 idle 连播 3 遍 + idle 尾巴；reduceMotion 冻结精灵、spinner、轮播 | ✅ 已对齐（含运行时系统设置变更） |
| 4 | 气泡内容 | 每平台 bubbleHeader + bubbleDetails | ✅ 已对齐（卡片：平台+会话名+动作） |
| 5 | 气泡布局 | 气泡在精灵上方、间距 6pt | ✅ 已对齐（按 AppKit 实际坐标修正） |
| 6 | 锚点定位 | anchor 四角 + 20pt | ✅ 已对齐（修正 Electron 上下方向反转） |
| 7 | 气泡三阶段 | Stage1/2/3 + 点击展开收起 | ✅ 已对齐（含返回、收起、失焦收起） |
| 8 | 完成卡片常驻 | done 终态卡片 + 轮播堆栈 + 「+N」 | ✅ 已对齐（3.2s 轮播、18/9pt 露边、最多 3 张完成卡） |
| 9 | 任务删除/隐藏 | × 删除气泡 + dismissed 持久化 | ✅ 已对齐（× 删除 + dismissed 持久化） |
| 10 | 唤醒任务 | 点击任务唤醒原平台 | ⚠️ Codex Desktop 深链尝试但不宣称已验证；CLI/Claude/Grok fail-closed；DSH 通过已认证浏览器的 fragment handoff 精确选择 session |
| 11 | 交互动画 | 悬停 jumping / 拖动 running | ✅ 已对齐（悬停/拖动动画） |
| 12 | 点击宠物展开 | 点击精灵 → Stage 2 | ✅ 已对齐 |
| 13 | 窗口属性 | transparent / alwaysOnTop / 全空间 | ⚠️ 已 alwaysOnTop；全空间仅 darwin/linux（Windows 无此概念） |
| 14 | 菜单大小控件 | 点按钮不关菜单连续点击；禁用平台显示“已禁用” | ✅ 保留 Electron 原生菜单样式；±5% 后自动以新百分比重开，可连续点击；Windows/Linux 原生托盘不变 |
| 15 | 任务历史持久化 | canonical migration + 去重/过滤 + 12/100 上限 + 终态 24h TTL | ✅ 已对齐（共享字段；加载时迁移旧 DSH UUID/清理损坏 shape；Electron 独立 wall-clock timer） |
| 16 | 托盘生命周期 | 点击状态图标打开菜单；显示/隐藏、打开配置、常驻、退出清理 | ✅ 已对齐（macOS 点击图标只打开原生菜单、不误隐藏宠物；单实例；关闭窗口不退出；Windows/Linux 托盘点击仍切换） |
| 17 | 宠物选择与删除 | 行首缩略图；按 bundle URL 精确操作，删除/外部失效后回退 | ✅ 已对齐（macOS 原生子菜单逐行显示小形象，近空 idle 首帧会选更清晰候选帧；规范路径；refresh 同闸门；只消费 sidecar 验证后的 catalog） |
| 18 | 首启与图集 | 首只发现宠物；按实际 atlas cell 排版 | ✅ 已对齐（失效配置回退；动态 8×9/11 图集；元数据/图片不一致则占位） |
| 19 | 本地导入能力 | AppKit/ImageIO 多格式导入 | ⚠️ macOS 可用；Windows/Linux 明示禁用，标准包安装可用 |

> 已知简化（平台限制 / 暂未实现）：
> - **#10 唤醒**：Electron 已按 canonical task ID 规划唤醒；来源明确的 Codex Desktop 任务可发送 `codex://threads/<id>`，但系统接收深链无法证明目标会话已显示，因此仍保留卡片。CLI 终端 tab 暂无可移植的精确聚焦 API，CLI/Claude/Grok fail-closed。DSH 任务卡改用 `#allpet-session=<encoded ID>` 交给已认证的系统浏览器；DSH 客户端仅在权威列表中找到该 session 后执行选择并清理 fragment，认证 cookie 始终留在浏览器中，因此不再出现“只打开基页”提示。Claude Desktop 上游未提供「聚焦现有会话」的安全深链，`resume` 可能 fork 副本，因此继续采用手动侧栏选择。
> - **#13 全空间**：Windows 无「所有 Space 可见」概念。
> - **#14 大小控件位置**：macOS Electron 保留原生菜单及 AppKit 同口径百分比和 ±5%；原生菜单选择命令后会关闭，因此在缩放回调后立即以新百分比重开，实现连续调节。Windows/Linux 保留原生托盘菜单，管理窗口也可调节。
> - 等待态时钟、运行/思考 spinner、完成勾、失败叹号与深浅色卡片已按 AppKit 绘制逻辑对齐。
> - 任务生命周期：Electron 与 AppKit 都会在典型 idle/no-task 快照清空活跃记录、会话切换时清空非当前活跃记录，只保留 done/failed 与当前/并发任务；隐藏最后一条活跃任务后，两端都从可见状态重算宠物动画。Electron 合并时保留 sourcePath/terminalBinding，并用独立 wall-clock timer 执行 24 小时 TTL；三平台 Node 测试覆盖 canonical ID、12/100 上限、时间戳保持、隐藏复活和定位字段继承。

> - **共享 HOME**：Electron config/history、宠物发现与继承环境的 sidecar 统一使用 `ALLPET_HOME`；加载历史后以原子 `0600` 文件（适用平台）重写规范化结果。
> - **DSH zstd**：Windows 外部命令发现按 `;` 拆分 PATH 并查找 `.exe`；Electron 安装包还会把自身 Node zlib decoder 注入 sidecar，已用 clean PATH 的实际 `.zstd` transcript 验收，不要求用户安装 zstd。独立 AppKit/CLI 启动仍采用外部命令。
> - **宠物缩略图**：Electron 管理器不再同步 base64 传输每张完整 atlas；macOS 原生宠物子菜单则由独立 `/usr/bin/sips` 子进程按 canonical path + mtime + cell 几何优先裁 idle 首帧，首帧过淡/近空时在 sidecar 验证几何内选取更清晰的候选帧，最终只把 ≤20×20 PNG 持久缓存并交给主进程，打开菜单不读取/解码完整 atlas。
