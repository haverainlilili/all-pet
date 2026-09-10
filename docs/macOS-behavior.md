# AllPet · macOS 平台行为基准文档

> 本文档是 macOS 原生 GUI（`Sources/allpet`）的**权威行为记录**，作为其余平台（Electron 壳 / 后续客户端）对齐「展示 + 交互」的唯一基准。
> 所有数值、顺序、文案、阈值均逐行核对源码（提交 `9614ac0` 时点）。后续若改 macOS 行为，**必须先改本文档**。

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
→ setupMenuBar()   // 建状态栏菜单
→ setupPet()       // 建宠物窗口
→ startPolling()   // 轮询多平台状态
→ app.run()
```

- 配置读取失败回退默认值；宠物 bundle 缺失时状态栏标题变 `🐾(无宠物)`。

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
- `reduceMotion`（系统「降低动态效果」开启时）：只播放首帧。

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

> 设计意图：done/failed 是终态，**不会因时间过期而从气泡消失**。

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
- **手动查看后复活**：`wakeTask` 后 15s 内（`manualViewGraceInterval=15`），非 done/failed 且曾被 dismiss 的任务会从隐藏名单移除；done/failed 仍保持 dismiss。

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

- **切换宠物**（`switchPet`）：加载 bundle + 切帧 → 保存 `config.pet.bundlePath` → 重排窗口 → 重置动画（从 idle 开始）。
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
| 3 | 动画播放 | 非 idle 连播 3 遍 + idle 尾巴；reduceMotion 首帧 | ✅ 已对齐（连播 3 遍 + reduceMotion） |
| 4 | 气泡内容 | 每平台 bubbleHeader + bubbleDetails | ✅ 已对齐（卡片：平台+会话名+动作） |
| 5 | 气泡布局 | 精灵上、气泡下、间距 6pt | ✅ 已对齐 |
| 6 | 锚点定位 | anchor 四角 + 20pt | ✅ 已对齐 |
| 7 | 气泡三阶段 | Stage1/2/3 + 点击展开收起 | ✅ 已对齐（Stage1/2/3 + 点击切换） |
| 8 | 完成卡片常驻 | done 终态卡片 + 轮播堆栈 + 「+N」 | ⚠️ 完成卡片 + 「+N」已对齐；轮播堆栈简化为平铺 |
| 9 | 任务删除/隐藏 | × 删除气泡 + dismissed 持久化 | ✅ 已对齐（× 删除 + dismissed 持久化） |
| 10 | 唤醒任务 | 点击任务唤醒原平台 | ⚠️ 点击任务打开平台（无终端/session 唤醒） |
| 11 | 交互动画 | 悬停 jumping / 拖动 running | ✅ 已对齐（悬停/拖动动画） |
| 12 | 点击宠物展开 | 点击精灵 → Stage 2 | ✅ 已对齐 |
| 13 | 窗口属性 | transparent / alwaysOnTop / 全空间 | ⚠️ 已 alwaysOnTop；全空间仅 darwin/linux（Windows 无此概念） |
| 14 | 菜单大小控件 | 点按钮不关菜单连续点击 | ⚠️ 在独立管理窗口（Electron 托盘菜单无自定义视图） |
| 15 | 任务历史持久化 | task-history.json + 去重 + 12 条上限 | ✅ 已对齐（共享 task-history.json，字段兼容） |

> 已知简化（平台限制 / 暂未实现）：
> - **#8 轮播堆栈**：Electron Stage 1 未完成平台平铺（最多 3 个），无 macOS 的轮播/露边动画。
> - **#10 唤醒**：Electron 无终端/session 唤起，点击任务仅「打开对应平台」。
> - **#13 全空间**：Windows 无「所有 Space 可见」概念。
> - **#14 大小控件位置**：Electron 大小调节在「宠物管理」窗口（原生托盘菜单不支持不关菜单的自定义视图）。
> - 等待态 spinner（macOS 转圈图标）在 Electron 简化为橙色圆点。
