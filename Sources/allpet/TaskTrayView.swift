import AppKit
import AllPetCore

/// 阶段 3 中使用的单条任务通知。任务历史仅由 GUI 根据平台快照累积，不改变监控逻辑。
struct TrayTaskItem: Codable, Equatable, Sendable {
    var id: String
    var platform: PlatformKind
    /// Current-turn title is retained only for identity/history; bubbles render sessionDisplayName.
    var title: String
    var sessionName: String?
    var action: String
    var phase: AgentPhase
    var progress: String?
    var updatedAt: Date?
    var sessionID: String?
    var sourcePath: String?
    var workingDirectory: String?
    var processID: Int32?
    var terminalTTY: String?
    var terminalBinding: TerminalBinding?
    var launchOrigin: String?

    init(status: PlatformStatus) {
        let rawTitle = status.task?.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = status.task?.action ?? status.detail
        let readableTitle = rawTitle.flatMap { value -> String? in
            guard !value.isEmpty, !value.hasPrefix("<") else { return nil }
            return value
        } ?? fallback
        let taskIdentity = status.task?.sessionID.flatMap { $0.isEmpty ? nil : $0 }
            ?? rawTitle.flatMap { $0.isEmpty ? nil : $0 }
            ?? "current"
        self.id = "\(status.platform.rawValue)|\(taskIdentity)"
        self.platform = status.platform
        self.title = readableTitle
        self.sessionName = status.task?.sessionName
        self.action = status.task?.action ?? status.detail
        self.phase = status.phase
        self.progress = status.task?.progressLabel
        self.updatedAt = status.lastActivityAt
        self.sessionID = status.task?.sessionID
        self.sourcePath = status.task?.sourcePath
        self.workingDirectory = status.task?.workingDirectory
        self.processID = status.task?.processID
        self.terminalTTY = status.task?.terminalTTY
        self.terminalBinding = status.task?.terminalBinding
        self.launchOrigin = status.task?.launchOrigin
    }

    var sessionDisplayName: String {
        if let value = sessionName?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
            return value
        }
        if let sessionID, !sessionID.isEmpty {
            let value = sessionID.hasPrefix("session-") ? String(sessionID.dropFirst(8)) : sessionID
            return "会话 \(value.prefix(8))"
        }
        return "未命名会话"
    }

    var canonicalID: String {
        var identity = sessionID.flatMap { $0.isEmpty ? nil : $0 }
            ?? title.trimmingCharacters(in: .whitespacesAndNewlines)
        if platform == .dsh, UUID(uuidString: identity) != nil { identity = "session-\(identity)" }
        return "\(platform.rawValue)|\(identity.isEmpty ? "current" : identity)"
    }
}

/// Codex 浮动通知风格：阶段 1 收起、阶段 2 平台、阶段 3 单平台全部任务。
final class TaskTrayView: NSView {
    private enum Stage: Equatable {
        case collapsed
        case platforms
        case tasks(PlatformKind)
    }

    private enum HitTarget: Equatable {
        case openPlatforms
        case collapse
        case platform(PlatformKind)
        case task(String)
        case dismissTask(String)
        case dismissPlatform(PlatformKind)
        case back
    }

    private struct PlatformBubble {
        var platform: PlatformKind
        var taskTitle: String
        var phase: AgentPhase
        var action: String
        var taskID: String? = nil
    }

    private struct PlatformGroup {
        var status: PlatformStatus
        var tasks: [TrayTaskItem]

        var height: CGFloat {
            let rows = min(tasks.count, 5)
            return rows <= 1 ? 58 : max(58, 29 + CGFloat(rows) * 14)
        }
    }

    var onPreferredSizeChange: ((NSSize) -> Void)?
    var onWakeTask: ((TrayTaskItem) -> Void)?
    var onDismissTask: ((String) -> Void)?
    var onDismissPlatform: ((PlatformKind) -> Void)?

    private var statuses: [PlatformStatus] = []
    private var tasksByPlatform: [PlatformKind: [TrayTaskItem]] = [:]
    private var stage: Stage = .collapsed
    private var hitRegions: [(rect: NSRect, target: HitTarget)] = []
    private var hoveredTarget: HitTarget?
    private var tracking: NSTrackingArea?
    private var spinnerTimer: Timer?
    private var rotationTimer: Timer?
    private var spinnerAngle: CGFloat = 0
    private var rotationIndex = 0

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    var preferredSize: NSSize {
        switch stage {
        case .collapsed:
            let completed = min(3, completedTasks.count)
            let unfinishedCount = unfinishedPlatformBubbles.count
            let rotating = unfinishedCount == 0 ? 0 : 1
            let rows = max(1, completed + rotating)
            let collapsedStackReveal: CGFloat = unfinishedCount > 1 ? 20 : 0
            return NSSize(
                width: 304,
                height: CGFloat(rows) * 58 + CGFloat(max(0, rows - 1)) * 7 + 8 + collapsedStackReveal
            )
        case .platforms:
            let groups = Array(stage2PlatformGroups.prefix(4))
            let cardsHeight = groups.reduce(CGFloat.zero) { $0 + $1.height }
            let gaps = CGFloat(max(0, groups.count - 1)) * 7
            return NSSize(width: 324, height: 34 + max(58, cardsHeight) + gaps + 8)
        case let .tasks(platform):
            let count = max(1, min(tasksByPlatform[platform]?.count ?? 0, 6))
            return NSSize(width: 334, height: 38 + CGFloat(count) * 58 + CGFloat(max(0, count - 1)) * 7 + 8)
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.masksToBounds = false
        toolTip = "点击查看平台任务"
    }

    required init?(coder: NSCoder) {
        nil
    }

    deinit {
        spinnerTimer?.invalidate()
        rotationTimer?.invalidate()
    }

    func update(statuses: [PlatformStatus], tasksByPlatform: [PlatformKind: [TrayTaskItem]]) {
        let oldSize = preferredSize
        self.statuses = statuses.sorted { platformOrder($0.platform) < platformOrder($1.platform) }
        self.tasksByPlatform = tasksByPlatform
        if case let .tasks(platform) = stage,
           !self.statuses.contains(where: { $0.platform == platform }) {
            stage = .platforms
        }
        let unfinishedCount = unfinishedPlatformBubbles.count
        if unfinishedCount == 0 {
            rotationIndex = 0
        } else {
            rotationIndex %= unfinishedCount
        }
        updateTimers()
        needsDisplay = true
        notifySizeChange(from: oldSize)
    }

    /// 点击宠物或阶段 1 气泡时进入阶段 2。
    func showPlatformStage() {
        setStage(.platforms)
    }

    /// 默认状态；点击窗口外部时调用。
    func collapseToStage1() {
        setStage(.collapsed)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let next = NSTrackingArea(
            rect: bounds,
            options: [.activeAlways, .mouseMoved, .mouseEnteredAndExited, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(next)
        tracking = next
        window?.acceptsMouseMovedEvents = true
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let target = hitRegions.last(where: { $0.rect.contains(point) })?.target
        if target != hoveredTarget {
            hoveredTarget = target
            needsDisplay = true
        }
        (target == nil ? NSCursor.arrow : NSCursor.pointingHand).set()
    }

    override func mouseExited(with event: NSEvent) {
        hoveredTarget = nil
        NSCursor.arrow.set()
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard let target = hitRegions.last(where: { $0.rect.contains(point) })?.target else { return }
        switch target {
        case .openPlatforms:
            setStage(.platforms)
        case .collapse:
            setStage(.collapsed)
        case let .platform(platform):
            let tasks = orderedTasks(for: platform)
            if tasks.count == 1, let task = tasks.first {
                wake(task)
            } else {
                setStage(.tasks(platform))
            }
        case let .task(id):
            if let task = tasksByPlatform.values.flatMap({ $0 }).first(where: { $0.id == id }) {
                wake(task)
            }
        case let .dismissTask(id):
            onDismissTask?(id)
        case let .dismissPlatform(platform):
            onDismissPlatform?(platform)
            setStage(.collapsed)
        case .back:
            setStage(.platforms)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        hitRegions.removeAll(keepingCapacity: true)
        switch stage {
        case .collapsed:
            drawStage1()
        case .platforms:
            drawStage2()
        case let .tasks(platform):
            drawStage3(platform)
        }
    }

    // MARK: - Three stages

    /// 阶段 1：已完成任务常驻在上方；未完成平台在最下方轮播。
    private func drawStage1() {
        let visibleCompleted = Array(completedTasks.suffix(3))
        var y: CGFloat = 4
        for task in visibleCompleted {
            let bubble = PlatformBubble(
                platform: task.platform,
                taskTitle: task.sessionDisplayName,
                phase: .done,
                action: "任务已完成",
                taskID: task.id
            )
            let rect = NSRect(x: 4, y: y, width: bounds.width - 8, height: 58)
            drawPlatformBubble(bubble, in: rect, interactive: true)
            hitRegions.append((rect, .task(task.id)))
            drawDismissButton(in: rect, target: .dismissTask(task.id))
            y += 65
        }

        if completedTasks.count > visibleCompleted.count {
            let extra = completedTasks.count - visibleCompleted.count
            drawCountPill("+\(extra) 个已完成", at: NSPoint(x: 13, y: 1))
        }

        let unfinished = unfinishedPlatformBubbles
        if !unfinished.isEmpty {
            drawRotatingPlatformStack(unfinished, atY: y)
        } else if visibleCompleted.isEmpty, let fallback = stage2PlatformBubbles.first {
            let rect = NSRect(x: 4, y: y, width: bounds.width - 8, height: 58)
            drawPlatformBubble(fallback, in: rect, interactive: true)
            hitRegions.append((rect, .openPlatforms))
        }
    }

    /// Codex 收起态的通知堆栈：主气泡在前，后两张缩进并露出 20pt。
    private func drawRotatingPlatformStack(_ bubbles: [PlatformBubble], atY y: CGFloat) {
        let visibleCount = min(3, bubbles.count)
        var front: (bubble: PlatformBubble, rect: NSRect)?
        for depth in stride(from: visibleCount - 1, through: 0, by: -1) {
            let index = (rotationIndex + depth) % bubbles.count
            let reveal: CGFloat
            if depth == 0 {
                reveal = 0
            } else if visibleCount == 2 {
                reveal = 18
            } else {
                reveal = CGFloat(depth) * 9
            }
            let inset = CGFloat(depth) * 5
            let rect = NSRect(
                x: 4 + inset,
                y: y + reveal,
                width: bounds.width - 8 - inset * 2,
                height: 58
            )
            let opacity: CGFloat = depth == 0 ? 1 : max(0.70, 0.88 - CGFloat(depth) * 0.09)
            drawPlatformBubble(bubbles[index], in: rect, interactive: depth == 0, opacity: opacity)
            if depth == 0 { front = (bubbles[index], rect) }
        }
        let stackHeight: CGFloat = bubbles.count > 1 ? 78 : 58
        hitRegions.append((NSRect(x: 4, y: y, width: bounds.width - 8, height: stackHeight), .openPlatforms))
        if let front, let taskID = front.bubble.taskID {
            drawDismissButton(in: front.rect, target: .dismissTask(taskID))
        }
    }

    /// 阶段 2：每个平台一个紧凑平台气泡；气泡内最多列出五条任务。
    private func drawStage2() {
        drawHeader(title: "平台任务", showsBack: false)
        var y: CGFloat = 34
        for group in stage2PlatformGroups.prefix(4) {
            let rect = NSRect(x: 4, y: y, width: bounds.width - 8, height: group.height)
            drawPlatformGroup(group, in: rect)
            hitRegions.append((rect, .platform(group.status.platform)))
            if !group.tasks.isEmpty {
                drawDismissButton(in: rect, target: .dismissPlatform(group.status.platform))
            }
            y += group.height + 7
        }
    }

    /// 阶段 3：只展示所选平台，并逐条显示该平台的全部任务气泡。
    private func drawStage3(_ platform: PlatformKind) {
        drawHeader(title: "的任务", showsBack: true, platform: platform)
        let tasks = Array(orderedTasks(for: platform).prefix(6))
        var y: CGFloat = 38
        if tasks.isEmpty {
            let placeholder = TrayTaskItem(status: placeholderStatus(for: platform))
            drawTaskBubble(placeholder, in: NSRect(x: 4, y: y, width: bounds.width - 8, height: 58))
            return
        }
        for task in tasks {
            let rect = NSRect(x: 4, y: y, width: bounds.width - 8, height: 58)
            drawTaskBubble(task, in: rect, interactive: true)
            hitRegions.append((rect, .task(task.id)))
            drawDismissButton(in: rect, target: .dismissTask(task.id))
            y += 65
        }
        if (tasksByPlatform[platform]?.count ?? 0) > tasks.count {
            drawCountPill(
                "+\((tasksByPlatform[platform]?.count ?? 0) - tasks.count) 个任务",
                at: NSPoint(x: 14, y: bounds.height - 22)
            )
        }
    }

    // MARK: - Bubble data

    private var completedTasks: [TrayTaskItem] {
        tasksByPlatform.values
            .flatMap { $0 }
            .filter { $0.phase == .done }
            .sorted { ($0.updatedAt ?? .distantPast) < ($1.updatedAt ?? .distantPast) }
    }

    private var unfinishedPlatformBubbles: [PlatformBubble] {
        var bubbles: [PlatformBubble] = []
        for status in statuses {
            let unfinished = (tasksByPlatform[status.platform] ?? [])
                .filter { $0.phase != .done }
                .sorted(by: taskComesFirst)
            if let task = unfinished.first {
                bubbles.append(PlatformBubble(
                    platform: status.platform,
                    taskTitle: task.sessionDisplayName,
                    phase: task.phase,
                    action: task.action,
                    taskID: task.id
                ))
            }
        }
        if bubbles.isEmpty, completedTasks.isEmpty {
            return stage2PlatformBubbles
        }
        return bubbles
    }

    private var stage2PlatformGroups: [PlatformGroup] {
        statuses.map { status in
            PlatformGroup(status: status, tasks: orderedTasks(for: status.platform))
        }
    }

    private func orderedTasks(for platform: PlatformKind) -> [TrayTaskItem] {
        (tasksByPlatform[platform] ?? []).sorted(by: taskComesFirst)
    }

    private var stage2PlatformBubbles: [PlatformBubble] {
        statuses.map { status in
            let tasks = tasksByPlatform[status.platform] ?? []
            if let task = tasks.sorted(by: taskComesFirst).first {
                return PlatformBubble(
                    platform: status.platform,
                    taskTitle: task.sessionDisplayName,
                    phase: task.phase,
                    action: task.action,
                    taskID: task.id
                )
            }
            return PlatformBubble(
                platform: status.platform,
                taskTitle: "暂无会话",
                phase: status.phase,
                action: status.detail
            )
        }
    }

    private func taskComesFirst(_ left: TrayTaskItem, _ right: TrayTaskItem) -> Bool {
        let leftRank = taskPhasePriority(left.phase)
        let rightRank = taskPhasePriority(right.phase)
        if leftRank != rightRank { return leftRank < rightRank }
        return (left.updatedAt ?? .distantPast) > (right.updatedAt ?? .distantPast)
    }

    private func taskPhasePriority(_ phase: AgentPhase) -> Int {
        switch phase {
        case .failed: 0
        case .running, .thinking: 1
        case .waiting: 2
        case .idle: 3
        case .done: 4
        }
    }

    private func placeholderStatus(for platform: PlatformKind) -> PlatformStatus {
        PlatformStatus(
            platform: platform,
            phase: .idle,
            detail: "暂无任务",
            lastActivityAt: nil,
            activeSessions: 0,
            enabled: true,
            task: TaskInfo(sessionName: "暂无会话", action: "等待新会话")
        )
    }

    // MARK: - Drawing

    private func drawHeader(title: String, showsBack: Bool, platform: PlatformKind? = nil) {
        if showsBack {
            let back = NSRect(x: 5, y: 2, width: 28, height: 26)
            drawRoundButton("‹", in: back, target: .back)
        }
        let rect = NSRect(x: showsBack ? 40 : 10, y: 6, width: 190, height: 18)
        if let platform {
            drawPlatformPrefixedText(platform: platform, suffix: " \(title)", in: rect, font: .systemFont(ofSize: 12.5, weight: .semibold))
        } else {
            drawText(title, in: rect, font: .systemFont(ofSize: 12.5, weight: .semibold), color: palette.text)
        }
        let collapse = NSRect(x: bounds.width - 66, y: 2, width: 56, height: 25)
        drawSmallButton("收起", in: collapse, target: .collapse)
    }

    private func drawPlatformBubble(
        _ bubble: PlatformBubble,
        in rect: NSRect,
        interactive: Bool,
        opacity: CGFloat = 1
    ) {
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current?.cgContext.setAlpha(opacity)
        defer { NSGraphicsContext.restoreGraphicsState() }
        let target: HitTarget = .platform(bubble.platform)
        let emphasized = interactive && (hoveredTarget == target || hoveredTarget == .openPlatforms)
        drawMaterialCard(rect, emphasized: emphasized)

        drawText(
            bubble.platform.label,
            in: NSRect(x: rect.minX + 18, y: rect.minY + 8, width: 112, height: 15),
            font: .systemFont(ofSize: 10.5, weight: .semibold),
            color: platformColor(bubble.platform)
        )
        drawText(
            bubble.taskTitle,
            in: NSRect(x: rect.minX + 18, y: rect.minY + 27, width: rect.width - 78, height: 19),
            font: .systemFont(ofSize: 13, weight: .semibold),
            color: palette.text
        )
        drawStatusIndicator(bubble.phase, in: NSRect(x: rect.maxX - 55, y: rect.minY + 19, width: 21, height: 21))
    }

    private func drawPlatformGroup(_ group: PlatformGroup, in rect: NSRect) {
        let target: HitTarget = .platform(group.status.platform)
        drawMaterialCard(rect, emphasized: hoveredTarget == target)
        let tasks = group.tasks
        let aggregatePhase = tasks.first?.phase ?? group.status.phase
        drawText(
            group.status.platform.label,
            in: NSRect(x: rect.minX + 18, y: rect.minY + 7, width: 130, height: 15),
            font: .systemFont(ofSize: 10.5, weight: .bold),
            color: platformColor(group.status.platform)
        )
        if tasks.count > 5 {
            drawText(
                "+\(tasks.count - 5)",
                in: NSRect(x: rect.minX + 145, y: rect.minY + 7, width: 34, height: 15),
                font: .systemFont(ofSize: 9.5, weight: .semibold),
                color: palette.tertiary
            )
        }
        let visible = Array(tasks.prefix(5))
        if visible.isEmpty {
            drawText("暂无会话", in: NSRect(x: rect.minX + 18, y: rect.minY + 28, width: rect.width - 62, height: 17), font: .systemFont(ofSize: 12, weight: .medium), color: palette.secondary)
        } else {
            var y = rect.minY + 26
            for task in visible {
                statusColor(task.phase).setFill()
                NSBezierPath(ovalIn: NSRect(x: rect.minX + 19, y: y + 4, width: 5, height: 5)).fill()
                drawText(task.sessionDisplayName, in: NSRect(x: rect.minX + 30, y: y, width: rect.width - 91, height: 14), font: .systemFont(ofSize: 11, weight: .medium), color: palette.text)
                y += 14
            }
        }
        drawStatusIndicator(aggregatePhase, in: NSRect(x: rect.maxX - 55, y: rect.midY - 11, width: 21, height: 21))
    }

    private func drawTaskBubble(_ task: TrayTaskItem, in rect: NSRect, interactive: Bool = false) {
        let target: HitTarget = .task(task.id)
        drawMaterialCard(rect, emphasized: interactive && hoveredTarget == target)
        drawPlatformPrefixedText(
            platform: task.platform,
            suffix: " - \(task.sessionDisplayName)",
            in: NSRect(x: rect.minX + 18, y: rect.minY + 9, width: rect.width - 84, height: 18),
            font: .systemFont(ofSize: 13, weight: .semibold)
        )
        let subtitle = task.progress.map { "\($0) · \(task.action)" } ?? task.action
        drawText(
            subtitle,
            in: NSRect(x: rect.minX + 18, y: rect.minY + 31, width: rect.width - 84, height: 16),
            font: .systemFont(ofSize: 11.5, weight: .regular),
            color: palette.secondary
        )
        drawStatusIndicator(task.phase, in: NSRect(x: rect.maxX - 58, y: rect.minY + 19, width: 21, height: 21))
        if interactive {
            drawText("›", in: NSRect(x: rect.maxX - 21, y: rect.minY + 36, width: 10, height: 15), font: .systemFont(ofSize: 15, weight: .medium), color: palette.tertiary, alignment: .center)
        }
    }

    private func drawPlatformPrefixedText(platform: PlatformKind, suffix: String, in rect: NSRect, font: NSFont) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let value = NSMutableAttributedString(
            string: platform.label,
            attributes: [.font: font, .foregroundColor: platformColor(platform), .paragraphStyle: paragraph]
        )
        value.append(NSAttributedString(
            string: suffix,
            attributes: [.font: font, .foregroundColor: palette.text, .paragraphStyle: paragraph]
        ))
        value.draw(with: rect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    private func drawStatusIndicator(_ phase: AgentPhase, in rect: NSRect) {
        let color = statusColor(phase)
        switch phase {
        case .running, .thinking:
            let path = NSBezierPath()
            path.appendArc(
                withCenter: NSPoint(x: rect.midX, y: rect.midY),
                radius: 8,
                startAngle: spinnerAngle,
                endAngle: spinnerAngle + 255
            )
            path.lineWidth = 2.5
            color.setStroke()
            path.stroke()
        case .done:
            color.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 2, dy: 2)).fill()
            let check = NSBezierPath()
            check.move(to: NSPoint(x: rect.minX + 7, y: rect.midY))
            check.line(to: NSPoint(x: rect.minX + 11, y: rect.maxY - 7))
            check.line(to: NSPoint(x: rect.maxX - 6, y: rect.minY + 7))
            check.lineWidth = 2
            NSColor.white.setStroke()
            check.stroke()
        case .waiting:
            color.setStroke()
            let ring = NSBezierPath(ovalIn: rect.insetBy(dx: 3, dy: 3))
            ring.lineWidth = 2
            ring.stroke()
            let hands = NSBezierPath()
            hands.move(to: NSPoint(x: rect.midX, y: rect.midY))
            hands.line(to: NSPoint(x: rect.midX, y: rect.minY + 7))
            hands.move(to: NSPoint(x: rect.midX, y: rect.midY))
            hands.line(to: NSPoint(x: rect.maxX - 7, y: rect.midY))
            hands.lineWidth = 1.7
            hands.stroke()
        case .failed:
            color.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 2, dy: 2)).fill()
            drawText("!", in: NSRect(x: rect.minX, y: rect.minY + 2, width: rect.width, height: rect.height), font: .systemFont(ofSize: 14, weight: .bold), color: .white, alignment: .center)
        case .idle:
            color.setStroke()
            let ring = NSBezierPath(ovalIn: rect.insetBy(dx: 4, dy: 4))
            ring.lineWidth = 1.5
            ring.stroke()
        }
    }

    private func drawMaterialCard(_ rect: NSRect, emphasized: Bool) {
        let path = NSBezierPath(roundedRect: rect, xRadius: 21, yRadius: 21)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(emphasized ? 0.22 : 0.14)
        shadow.shadowBlurRadius = emphasized ? 12 : 7
        shadow.shadowOffset = NSSize(width: 0, height: -2)
        shadow.set()
        (emphasized ? palette.cardHover : palette.card).setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
        palette.border.setStroke()
        path.lineWidth = 1
        path.stroke()
    }

    private func drawCountPill(_ text: String, at point: NSPoint) {
        let width = max(54, CGFloat(text.count) * 7 + 14)
        let rect = NSRect(x: point.x, y: point.y, width: width, height: 20)
        palette.subtle.setFill()
        NSBezierPath(roundedRect: rect, xRadius: 10, yRadius: 10).fill()
        drawText(text, in: rect.insetBy(dx: 5, dy: 4), font: .systemFont(ofSize: 9.5, weight: .semibold), color: palette.secondary, alignment: .center)
    }

    private func drawDismissButton(in card: NSRect, target: HitTarget) {
        let rect = NSRect(x: card.maxX - 27, y: card.minY + 5, width: 19, height: 19)
        (hoveredTarget == target ? NSColor.systemRed.withAlphaComponent(0.18) : palette.subtle).setFill()
        NSBezierPath(ovalIn: rect).fill()
        drawText("×", in: NSRect(x: rect.minX, y: rect.minY - 1, width: rect.width, height: rect.height),
                 font: .systemFont(ofSize: 14, weight: .medium),
                 color: hoveredTarget == target ? .systemRed : palette.tertiary, alignment: .center)
        hitRegions.append((rect.insetBy(dx: -3, dy: -3), target))
    }

    private func drawSmallButton(_ text: String, in rect: NSRect, target: HitTarget) {
        (hoveredTarget == target ? palette.hover : palette.subtle).setFill()
        NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2).fill()
        drawText(text, in: rect.insetBy(dx: 6, dy: 5), font: .systemFont(ofSize: 10.5, weight: .medium), color: palette.secondary, alignment: .center)
        hitRegions.append((rect, target))
    }

    private func drawRoundButton(_ text: String, in rect: NSRect, target: HitTarget) {
        (hoveredTarget == target ? palette.hover : palette.subtle).setFill()
        NSBezierPath(ovalIn: rect).fill()
        drawText(text, in: NSRect(x: rect.minX, y: rect.minY - 3, width: rect.width, height: rect.height), font: .systemFont(ofSize: 24, weight: .regular), color: palette.text, alignment: .center)
        hitRegions.append((rect, target))
    }

    private func drawText(
        _ text: String,
        in rect: NSRect,
        font: NSFont,
        color: NSColor,
        alignment: NSTextAlignment = .left
    ) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = .byTruncatingTail
        (text as NSString).draw(
            with: rect,
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
            attributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]
        )
    }

    // MARK: - Timers

    private func wake(_ task: TrayTaskItem) {
        onWakeTask?(task)
        setStage(.collapsed)
    }

    private func setStage(_ next: Stage) {
        guard next != stage else { return }
        let oldSize = preferredSize
        stage = next
        hoveredTarget = nil
        updateTimers()
        needsDisplay = true
        notifySizeChange(from: oldSize)
    }

    private func updateTimers() {
        let allTasks = tasksByPlatform.values.flatMap { $0 }
        let needsSpinner = allTasks.contains { $0.phase == .running || $0.phase == .thinking }
            || statuses.contains { $0.phase == .running || $0.phase == .thinking }
        if needsSpinner, spinnerTimer == nil {
            spinnerTimer = Timer.scheduledTimer(withTimeInterval: 0.09, repeats: true) { [weak self] _ in
                guard let self else { return }
                self.spinnerAngle = (self.spinnerAngle + 18).truncatingRemainder(dividingBy: 360)
                self.needsDisplay = true
            }
        } else if !needsSpinner {
            spinnerTimer?.invalidate()
            spinnerTimer = nil
        }

        let needsRotation = stage == .collapsed && unfinishedPlatformBubbles.count > 1
        if needsRotation, rotationTimer == nil {
            rotationTimer = Timer.scheduledTimer(withTimeInterval: 3.2, repeats: true) { [weak self] _ in
                guard let self else { return }
                let count = self.unfinishedPlatformBubbles.count
                guard count > 0 else { return }
                self.rotationIndex = (self.rotationIndex + 1) % count
                self.needsDisplay = true
            }
        } else if !needsRotation {
            rotationTimer?.invalidate()
            rotationTimer = nil
        }
    }

    private func notifySizeChange(from oldSize: NSSize) {
        let newSize = preferredSize
        guard oldSize != newSize else { return }
        onPreferredSizeChange?(newSize)
    }

    private func platformOrder(_ platform: PlatformKind) -> Int {
        PlatformKind.allCases.firstIndex(of: platform) ?? .max
    }

    private func platformColor(_ platform: PlatformKind) -> NSColor {
        switch platform {
        case .codex:
            return NSColor(calibratedRed: 0.06, green: 0.64, blue: 0.50, alpha: 1)
        case .claude:
            return NSColor(calibratedRed: 0.80, green: 0.42, blue: 0.30, alpha: 1)
        case .dsh:
            return NSColor(calibratedRed: 0.30, green: 0.42, blue: 0.98, alpha: 1)
        case .grok:
            let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return dark ? NSColor(white: 0.92, alpha: 1) : NSColor(white: 0.12, alpha: 1)
        }
    }

    private func statusColor(_ phase: AgentPhase) -> NSColor {
        switch phase {
        case .failed: .systemRed
        case .running, .thinking: .systemBlue
        case .waiting: .systemOrange
        case .done: .systemGreen
        case .idle: palette.tertiary
        }
    }

    private var palette: (
        card: NSColor,
        cardHover: NSColor,
        border: NSColor,
        text: NSColor,
        secondary: NSColor,
        tertiary: NSColor,
        subtle: NSColor,
        hover: NSColor
    ) {
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if dark {
            return (
                NSColor(calibratedWhite: 0.12, alpha: 0.94),
                NSColor(calibratedWhite: 0.17, alpha: 0.97),
                NSColor.white.withAlphaComponent(0.12),
                NSColor.white.withAlphaComponent(0.94),
                NSColor.white.withAlphaComponent(0.68),
                NSColor.white.withAlphaComponent(0.46),
                NSColor.white.withAlphaComponent(0.08),
                NSColor.white.withAlphaComponent(0.13)
            )
        }
        return (
            NSColor.white.withAlphaComponent(0.94),
            NSColor.white.withAlphaComponent(0.99),
            NSColor.black.withAlphaComponent(0.10),
            NSColor.black.withAlphaComponent(0.88),
            NSColor.black.withAlphaComponent(0.62),
            NSColor.black.withAlphaComponent(0.42),
            NSColor.black.withAlphaComponent(0.05),
            NSColor.black.withAlphaComponent(0.08)
        )
    }
}
