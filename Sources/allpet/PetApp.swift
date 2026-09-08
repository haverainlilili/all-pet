#if os(macOS)
import AppKit
import ImageIO
import AllPetCore

/// 绘制当前帧的视图（把切好的 CGImage 帧铺满 bounds）。
final class SpriteView: NSView {
    var onClick: (() -> Void)?
    var onInteractionAnimation: ((PetAnimation?) -> Void)?

    var frameImage: CGImage? {
        didSet { needsDisplay = true }
    }

    private var tracking: NSTrackingArea?
    private var mouseDownScreenPoint: NSPoint?
    private var mouseDownWindowOrigin: NSPoint?
    private var didDrag = false
    private var isHovered = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let image = frameImage, let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: bounds)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let next = NSTrackingArea(
            rect: bounds,
            options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(next)
        tracking = next
    }

    override func mouseEntered(with event: NSEvent) {
        isHovered = true
        if !didDrag { onInteractionAnimation?(.jumping) }
    }

    override func mouseExited(with event: NSEvent) {
        isHovered = false
        if !didDrag { onInteractionAnimation?(nil) }
    }

    override func mouseDown(with event: NSEvent) {
        mouseDownScreenPoint = NSEvent.mouseLocation
        mouseDownWindowOrigin = window?.frame.origin
        didDrag = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = mouseDownScreenPoint, let origin = mouseDownWindowOrigin, let window else { return }
        let current = NSEvent.mouseLocation
        let dx = current.x - start.x
        let dy = current.y - start.y
        guard didDrag || hypot(dx, dy) >= 4 else { return }
        didDrag = true
        window.setFrameOrigin(NSPoint(x: origin.x + dx, y: origin.y + dy))
        onInteractionAnimation?(dx >= 0 ? .runningRight : .runningLeft)
    }

    override func mouseUp(with event: NSEvent) {
        if didDrag {
            onInteractionAnimation?(isHovered ? .jumping : nil)
        } else {
            onClick?()
        }
        mouseDownScreenPoint = nil
        mouseDownWindowOrigin = nil
        didDrag = false
    }
}

/// macOS 桌面宠物应用：透明悬浮窗 + 精灵动画 + 菜单栏 + 多平台任务状态。
final class PetApp: NSObject, @unchecked Sendable {
    private var config: AllPetConfiguration
    private let monitor: AllPetMonitor
    private let taskLauncher: TaskLauncher
    private let taskWakeQueue = DispatchQueue(label: "allpet.task-wake", qos: .userInitiated)
    private let home: URL
    private let monitorQueue = DispatchQueue(label: "allpet.monitor", qos: .utility)

    private var bundle: PetBundle?
    private var frames: [CGImage] = []

    private var window: NSWindow?
    private var spriteView: SpriteView?
    private var taskTrayView: TaskTrayView?
    private var statusItem: NSStatusItem?
    private var petImportInProgress = false
    private var statusMenuItems: [PlatformKind: NSMenuItem] = [:]

    private var animation: PetAnimation = .idle
    private var statusAnimation: PetAnimation = .idle
    private var interactionAnimation: PetAnimation?
    private var playbackFrames: [PetAnimationFrame] = []
    private var playbackLoopStartIndex: Int?
    private var frameIndex = 0
    private var frameTimer: Timer?
    private var pollTimer: Timer?
    private var pollInFlight = false
    private var taskHistory: [PlatformKind: [TrayTaskItem]] = [:]
    private var dismissedTaskIDs: [String] = []
    private var manuallyHiddenTaskTitles: [String: String] = [:]
    private var latestStatuses: [PlatformStatus] = []
    private var taskTrayIsVisible = false
    private var globalClickMonitor: Any?
    private var localClickMonitor: Any?
    private var lastInternalMouseDownTimestamp: TimeInterval = -.infinity
    private var lastManualViewCheckAt: Date = .distantPast

    init(config: AllPetConfiguration, home: URL) {
        let loadedHistory = Self.loadTaskHistory(home: home)
        self.config = config
        self.home = home
        self.monitor = AllPetMonitor(configuration: config, home: home)
        self.taskLauncher = TaskLauncher(home: home)
        self.taskHistory = loadedHistory.platforms
        self.dismissedTaskIDs = loadedHistory.dismissedTaskIDs
        super.init()
    }

    func run() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        setupMenuBar()
        setupPet()
        startPolling()
        app.run()
    }

    // MARK: - Pet

    private func resolveBundle() -> PetBundle? {
        if let p = config.pet.bundlePath, !p.isEmpty {
            return try? PetBundle.load(from: URL(fileURLWithPath: PathExpander.expand(p)))
        }
        return PetDiscovery.discover(home: home).first
    }

    private func loadFrames(_ bundle: PetBundle) -> [CGImage]? {
        guard let src = CGImageSourceCreateWithURL(bundle.spritesheetURL as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        let atlas = bundle.atlas
        var out: [CGImage] = []
        for row in 0..<atlas.rows {
            for col in 0..<atlas.columns {
                let rect = CGRect(
                    x: col * atlas.cellWidth,
                    y: row * atlas.cellHeight,
                    width: atlas.cellWidth,
                    height: atlas.cellHeight
                )
                if let cropped = image.cropping(to: rect) { out.append(cropped) }
            }
        }
        return out.isEmpty ? nil : out
    }

    /// 从图集第 0 行第 0 列（idle 首帧）裁出小图，用作菜单缩略图。
    private func petThumbnail(for bundle: PetBundle, maxDimension: CGFloat = 22) -> NSImage? {
        guard let src = CGImageSourceCreateWithURL(bundle.spritesheetURL as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        let atlas = bundle.atlas
        let rect = CGRect(x: 0, y: 0, width: atlas.cellWidth, height: atlas.cellHeight)
        guard let cropped = image.cropping(to: rect) else { return nil }
        let scale = min(maxDimension / CGFloat(atlas.cellWidth), maxDimension / CGFloat(atlas.cellHeight))
        let size = NSSize(width: CGFloat(atlas.cellWidth) * scale, height: CGFloat(atlas.cellHeight) * scale)
        let result = NSImage(size: size)
        result.lockFocus()
        NSImage(cgImage: cropped, size: size).draw(in: NSRect(origin: .zero, size: size),
            from: .zero, operation: .sourceOver, fraction: 1)
        result.unlockFocus()
        return result
    }

    private func layoutMetrics(
        for bundle: PetBundle,
        traySize: NSSize? = nil
    ) -> (sprite: NSSize, content: NSSize, tray: NSSize) {
        // Codex 桌宠源码：宽度默认 112px，并限制在 80...224px；高度保持 192×208 单帧比例。
        let requestedWidth = CGFloat(bundle.atlas.cellWidth) * CGFloat(config.pet.scale)
        let codexWidth = min(224, max(80, requestedWidth.rounded()))
        let sprite = NSSize(
            width: codexWidth,
            height: codexWidth * CGFloat(bundle.atlas.cellHeight) / CGFloat(bundle.atlas.cellWidth)
        )
        let tray = traySize ?? taskTrayView?.preferredSize ?? NSSize(width: 304, height: 72)
        let content = NSSize(
            width: max(sprite.width, tray.width),
            height: sprite.height + tray.height + 6
        )
        return (sprite, content, tray)
    }

    private func setupPet() {
        guard config.pet.enabled else { return }
        guard let bundle = resolveBundle() else {
            statusItem?.button?.title = "🐾(无宠物)"
            return
        }
        guard let frames = loadFrames(bundle) else { return }
        self.bundle = bundle
        self.frames = frames

        let metrics = layoutMetrics(for: bundle)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: metrics.sprite),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        window.isMovableByWindowBackground = false
        window.acceptsMouseMovedEvents = true

        let content = NSView(frame: NSRect(origin: .zero, size: metrics.sprite))
        let tray = TaskTrayView(frame: NSRect(
            x: (metrics.content.width - metrics.tray.width) / 2,
            y: metrics.sprite.height + 6,
            width: metrics.tray.width,
            height: metrics.tray.height
        ))
        tray.isHidden = true
        tray.onPreferredSizeChange = { [weak self] size in
            self?.resizeTaskTray(to: size)
        }
        tray.onWakeTask = { [weak self] task in
            self?.wakeTask(task)
        }
        tray.onDismissTask = { [weak self] id in
            self?.dismissTaskBubble(id: id)
        }
        tray.onDismissPlatform = { [weak self] platform in
            self?.dismissPlatformBubbles(platform)
        }
        tray.onOpenPlatform = { [weak self] platform in
            self?.openPlatform(platform)
        }
        content.addSubview(tray)
        self.taskTrayView = tray

        let sprite = SpriteView(frame: NSRect(
            x: 0,
            y: 0,
            width: metrics.sprite.width,
            height: metrics.sprite.height
        ))
        sprite.onClick = { [weak self] in
            self?.taskTrayView?.showPlatformStage()
        }
        sprite.onInteractionAnimation = { [weak self] animation in
            self?.setInteractionAnimation(animation)
        }
        content.addSubview(sprite)
        self.spriteView = sprite

        window.contentView = content
        positionWindow(window, metrics: metrics)
        window.orderFrontRegardless()
        self.window = window
        installOutsideClickHandling()
        setAnimation(.idle)
    }

    private func positionWindow(
        _ window: NSWindow,
        metrics: (sprite: NSSize, content: NSSize, tray: NSSize)
    ) {
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        let margin: CGFloat = 20
        let isLeft = config.pet.anchor.hasSuffix("left")
        let isTop = config.pet.anchor.hasPrefix("top")
        let fullOriginX = isLeft
            ? visible.minX + margin
            : visible.maxX - metrics.content.width - margin
        let spriteOriginX = fullOriginX + (metrics.content.width - metrics.sprite.width) / 2
        let spriteOriginY = isTop
            ? visible.maxY - metrics.content.height - margin
            : visible.minY + margin
        window.setFrameOrigin(NSPoint(x: spriteOriginX, y: spriteOriginY))
    }

    // MARK: - Animation

    private func setStatusAnimation(_ anim: PetAnimation) {
        statusAnimation = anim
        if interactionAnimation == nil { setAnimation(anim) }
    }

    private func setInteractionAnimation(_ anim: PetAnimation?) {
        interactionAnimation = anim
        setAnimation(anim ?? statusAnimation)
    }

    private func setAnimation(_ anim: PetAnimation) {
        if anim == animation, !playbackFrames.isEmpty { return }
        animation = anim
        let playback = anim.playback(reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        playbackFrames = playback.frames
        playbackLoopStartIndex = playback.loopStartIndex
        frameIndex = 0
        showFrame()
        scheduleNextFrame()
    }

    private func showFrame() {
        guard let spriteView, !frames.isEmpty, playbackFrames.indices.contains(frameIndex) else { return }
        let columns = bundle?.atlas.columns ?? PetAtlas.codexColumns
        let step = playbackFrames[frameIndex]
        let index = step.row * columns + step.column
        if index < frames.count { spriteView.frameImage = frames[index] }
    }

    private func scheduleNextFrame() {
        frameTimer?.invalidate()
        frameTimer = nil
        guard playbackFrames.indices.contains(frameIndex), playbackFrames.count > 1 else { return }
        let duration = playbackFrames[frameIndex].durationMilliseconds
        frameTimer = Timer.scheduledTimer(withTimeInterval: Double(duration) / 1000.0, repeats: false) { [weak self] _ in
            guard let self else { return }
            let next = self.frameIndex + 1
            if next < self.playbackFrames.count {
                self.frameIndex = next
            } else if let loopStart = self.playbackLoopStartIndex {
                self.frameIndex = loopStart
            } else {
                return
            }
            self.showFrame()
            self.scheduleNextFrame()
        }
    }

    // MARK: - Polling and task bubbles

    private func startPolling() {
        let interval = max(0.4, Double(config.watch.pollIntervalMilliseconds) / 1000.0)
        pollTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.requestSnapshot()
        }
        requestSnapshot()
    }

    private func requestSnapshot() {
        guard !pollInFlight else { return }
        pollInFlight = true
        monitorQueue.async { [weak self] in
            guard let self else { return }
            let snapshot = self.monitor.snapshot()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.pollInFlight = false
                self.apply(snapshot)
            }
        }
    }

    private func apply(_ snapshot: PetSnapshot) {
        let displayedStatuses = updateTaskTray(snapshot.platforms)
        let displayedSnapshot = Aggregator.snapshot(statuses: displayedStatuses, now: snapshot.observedAt)
        setStatusAnimation(displayedSnapshot.animation)
        updateMenu(snapshot)
        performManualViewCheckIfNeeded()
    }

    /// 用户自己手动打开/查看已完成任务时，让该完成气泡自动消失。
    private func performManualViewCheckIfNeeded() {
        let now = Date()
        guard now.timeIntervalSince(lastManualViewCheckAt) >= 3 else { return }
        lastManualViewCheckAt = now
        let doneTasks = taskHistory.values.flatMap { $0 }.filter { $0.phase == .done }
        guard !doneTasks.isEmpty else { return }
        taskWakeQueue.async { [weak self] in
            guard let self else { return }
            let viewedIDs = doneTasks.filter { self.taskLauncher.isManuallyViewed($0) }.map(\.canonicalID)
            guard !viewedIDs.isEmpty else { return }
            DispatchQueue.main.async { [weak self] in
                self?.dismissManuallyViewedDoneTasks(ids: viewedIDs)
            }
        }
    }

    private func dismissManuallyViewedDoneTasks(ids: [String]) {
        var changed = false
        for id in ids {
            for platform in PlatformKind.allCases {
                guard var tasks = taskHistory[platform], tasks.contains(where: { $0.canonicalID == id }) else { continue }
                tasks.removeAll { $0.canonicalID == id }
                taskHistory[platform] = tasks
                dismissedTaskIDs.removeAll { $0 == id }
                dismissedTaskIDs.append(id)
                changed = true
            }
        }
        guard changed else { return }
        saveTaskHistory()
        let displayed = updateTaskTray(latestStatuses)
        setStatusAnimation(Aggregator.snapshot(statuses: displayed, now: Date()).animation)
    }

    @discardableResult
    private func updateTaskTray(_ statuses: [PlatformStatus]) -> [PlatformStatus] {
        latestStatuses = statuses
        var displayStatuses: [PlatformStatus] = []
        var shouldPersistHistory = false
        for status in statuses where status.enabled {
            var display = inferredTerminalStatus(from: status) ?? status

            guard display.task?.isEmpty == false else {
                displayStatuses.append(display)
                continue
            }
            var item = TrayTaskItem(status: display)
            guard item.sessionID?.isEmpty == false else {
                display.task = nil
                displayStatuses.append(display)
                continue
            }
            if let hiddenTitle = manuallyHiddenTaskTitles[item.id] {
                if hiddenTitle == item.title {
                    taskHistory[display.platform]?.removeAll { $0.canonicalID == item.id }
                    display.phase = .idle
                    display.detail = AgentPhase.idle.label
                    display.task = nil
                    displayStatuses.append(display)
                    continue
                }
                manuallyHiddenTaskTitles.removeValue(forKey: item.id)
            }
            if item.phase != .done && item.phase != .failed, dismissedTaskIDs.contains(item.id) {
                dismissedTaskIDs.removeAll { $0 == item.id }
                shouldPersistHistory = true
            }
            if (item.phase == .done || item.phase == .failed), dismissedTaskIDs.contains(item.id) {
                display.phase = .idle
                display.detail = AgentPhase.idle.label
                display.task = nil
                displayStatuses.append(display)
                continue
            }
            displayStatuses.append(display)

            var history = taskHistory[display.platform] ?? []
            let existingIndex = history.firstIndex(where: { $0.canonicalID == item.id })
                ?? item.sessionID.flatMap { sessionID in
                    history.firstIndex(where: { $0.sessionID == sessionID })
                }
                ?? history.firstIndex(where: { $0.sessionID == nil && $0.title == item.title })
            if let index = existingIndex {
                if !(history[index].phase == .done && item.phase == .idle) {
                    if let previousBinding = history[index].terminalBinding {
                        item.terminalBinding = previousBinding
                        item.terminalTTY = previousBinding.tty
                    } else if item.terminalTTY == nil {
                        item.terminalTTY = history[index].terminalTTY
                    }
                    if item.processID == nil { item.processID = history[index].processID }
                    if item.workingDirectory == nil { item.workingDirectory = history[index].workingDirectory }
                    if item.launchOrigin == nil { item.launchOrigin = history[index].launchOrigin }
                    if item.sessionName == nil { item.sessionName = history[index].sessionName }
                    if history[index] != item { shouldPersistHistory = true }
                    history[index] = item
                }
            } else {
                history.append(item)
                shouldPersistHistory = true
            }
            history = Self.deduplicatedTasks(history)
            if history.count > 12 { history.removeLast(history.count - 12) }
            taskHistory[display.platform] = history
        }
        if shouldPersistHistory { saveTaskHistory() }

        displayStatuses.sort {
            platformOrder($0.platform) < platformOrder($1.platform)
        }
        let hasNotification = !taskHistory.values.allSatisfy(\.isEmpty)
            || displayStatuses.contains { $0.phase != .idle }
        taskTrayView?.update(statuses: displayStatuses, tasksByPlatform: taskHistory)
        if !hasNotification { taskTrayView?.collapseToStage1() }
        taskTrayView?.isHidden = !hasNotification
        setTaskTrayVisible(hasNotification)
        return displayStatuses
    }

    private func dismissTaskBubble(id: String) {
        guard let task = taskHistory.values.flatMap({ $0 }).first(where: { $0.canonicalID == id }) else { return }
        if task.phase == .done {
            if !dismissedTaskIDs.contains(task.id) { dismissedTaskIDs.append(task.id) }
        } else {
            manuallyHiddenTaskTitles[task.id] = task.title
        }
        taskHistory[task.platform]?.removeAll { $0.canonicalID == task.id }
        saveTaskHistory()
        let displayedStatuses = updateTaskTray(latestStatuses)
        setStatusAnimation(Aggregator.snapshot(statuses: displayedStatuses, now: Date()).animation)
    }

    private func dismissPlatformBubbles(_ platform: PlatformKind) {
        for task in taskHistory[platform] ?? [] {
            if task.phase == .done {
                if !dismissedTaskIDs.contains(task.id) { dismissedTaskIDs.append(task.id) }
            } else {
                manuallyHiddenTaskTitles[task.id] = task.title
            }
        }
        taskHistory[platform] = []
        saveTaskHistory()
        let displayedStatuses = updateTaskTray(latestStatuses)
        setStatusAnimation(Aggregator.snapshot(statuses: displayedStatuses, now: Date()).animation)
    }

    private func wakeTask(_ task: TrayTaskItem) {
        taskWakeQueue.async { [weak self] in
            guard let self else { return }
            let result = self.taskLauncher.wake(task)
            DispatchQueue.main.async { [weak self] in
                self?.handleWakeResult(result, task: task)
            }
        }
    }

    private func strongWakeTask(
        _ task: TrayTaskItem,
        target: TaskLauncher.StrongWakeTarget = .automatic
    ) {
        taskWakeQueue.async { [weak self] in
            guard let self else { return }
            let result = self.taskLauncher.strongWake(task, target: target)
            DispatchQueue.main.async { [weak self] in
                self?.handleWakeResult(result, task: task, strongWakeTarget: target)
            }
        }
    }

    private func handleWakeResult(
        _ result: TaskLauncher.Result,
        task: TrayTaskItem,
        strongWakeTarget: TaskLauncher.StrongWakeTarget? = nil
    ) {
        if result.requiresStrongWake {
            if task.platform == .claude {
                presentClaudeStrongWakeChooser(task, failureMessage: nil)
            } else {
                let alert = NSAlert()
                alert.alertStyle = .warning
                alert.messageText = "\(task.platform.label) 已关闭 · 强唤起"
                alert.informativeText = result.message ?? "任务程序已经关闭。是否打开对应程序并定位到原任务？"
                alert.addButton(withTitle: "打开原任务")
                alert.addButton(withTitle: "取消")
                NSApp.activate(ignoringOtherApps: true)
                if alert.runModal() == .alertFirstButtonReturn { strongWakeTask(task) }
            }
            return
        }
        if result.succeeded {
            if task.phase != .done,
               let index = taskHistory[task.platform]?.firstIndex(where: { $0.canonicalID == task.id }) {
                if let binding = result.terminalBinding {
                    taskHistory[task.platform]?[index].terminalBinding = binding
                    taskHistory[task.platform]?[index].terminalTTY = binding.tty
                    saveTaskHistory()
                } else if let tty = result.terminalTTY {
                    taskHistory[task.platform]?[index].terminalTTY = tty
                    saveTaskHistory()
                }
            }
            if task.phase == .done || task.phase == .failed {
                dismissedTaskIDs.removeAll { $0 == task.id }
                dismissedTaskIDs.append(task.id)
                taskHistory[task.platform]?.removeAll { $0.canonicalID == task.id }
                saveTaskHistory()
                let displayedStatuses = updateTaskTray(latestStatuses)
                setStatusAnimation(Aggregator.snapshot(statuses: displayedStatuses, now: Date()).animation)
            }
            return
        }
        if task.platform == .claude, strongWakeTarget != nil {
            presentClaudeStrongWakeChooser(task, failureMessage: result.message)
            return
        }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "无法唤起\(task.platform.label)任务"
        alert.informativeText = result.message ?? "没有找到对应任务界面"
        alert.addButton(withTitle: "好")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    private func presentClaudeStrongWakeChooser(_ task: TrayTaskItem, failureMessage: String?) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Claude 已关闭 · 强唤起"
        alert.informativeText = failureMessage.map { "\($0)\n请重新选择打开方式。" }
            ?? "任务程序已经关闭。请选择用 Claude Desktop 还是 Claude CLI 打开并定位到原任务。Desktop 仅打开已存在的原任务，不会导入副本。"
        alert.addButton(withTitle: "Claude Desktop")
        alert.addButton(withTitle: "Claude CLI")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            strongWakeTask(task, target: .claudeDesktop)
        case .alertSecondButtonReturn:
            strongWakeTask(task, target: .claudeCLI)
        default:
            break
        }
    }

    private func openPlatform(_ platform: PlatformKind) {
        taskWakeQueue.async { [weak self] in
            guard let self else { return }
            if self.taskLauncher.platformAppIsRunning(platform) {
                let evoked = self.taskLauncher.evokePlatform(platform)
                if !evoked {
                    DispatchQueue.main.async { [weak self] in
                        self?.presentPlatformOpenFailure(platform)
                    }
                }
            } else {
                DispatchQueue.main.async { [weak self] in
                    self?.presentPlatformOpenPrompt(platform)
                }
            }
        }
    }

    private func presentPlatformOpenPrompt(_ platform: PlatformKind) {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "\(platform.label) 未在运行"
        alert.informativeText = "是否打开 \(platform.label)？"
        alert.addButton(withTitle: "打开")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        taskWakeQueue.async { [weak self] in
            guard let self else { return }
            let launched = self.taskLauncher.launchPlatform(platform)
            if !launched {
                DispatchQueue.main.async { [weak self] in
                    self?.presentPlatformOpenFailure(platform)
                }
            }
        }
    }

    private func presentPlatformOpenFailure(_ platform: PlatformKind) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "无法打开 \(platform.label)"
        alert.informativeText = "未找到 \(platform.label) 的可打开程序，或唤起失败。"
        alert.addButton(withTitle: "好")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    private struct PersistedTaskHistory: Codable {
        var platforms: [String: [TrayTaskItem]]
        var dismissedTaskIDs: [String]

        init(platforms: [String: [TrayTaskItem]], dismissedTaskIDs: [String]) {
            self.platforms = platforms
            self.dismissedTaskIDs = dismissedTaskIDs
        }

        private enum CodingKeys: String, CodingKey {
            case platforms
            case dismissedTaskIDs
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            platforms = try container.decodeIfPresent([String: [TrayTaskItem]].self, forKey: .platforms) ?? [:]
            dismissedTaskIDs = try container.decodeIfPresent([String].self, forKey: .dismissedTaskIDs) ?? []
        }
    }

    private struct LoadedTaskHistory {
        var platforms: [PlatformKind: [TrayTaskItem]]
        var dismissedTaskIDs: [String]
    }

    private static func taskHistoryURL(home: URL) -> URL {
        home.appendingPathComponent(".config/all-pet/task-history.json")
    }

    private static func deduplicatedTasks(_ tasks: [TrayTaskItem]) -> [TrayTaskItem] {
        var byID: [String: TrayTaskItem] = [:]
        for var task in tasks {
            if task.platform == .dsh, let sessionID = task.sessionID, UUID(uuidString: sessionID) != nil {
                task.sessionID = "session-\(sessionID)"
            }
            task.id = task.canonicalID
            if let previous = byID[task.id] {
                let previousDate = previous.updatedAt ?? .distantPast
                let taskDate = task.updatedAt ?? .distantPast
                if taskDate < previousDate { continue }
                if task.terminalTTY == nil { task.terminalTTY = previous.terminalTTY }
                if task.terminalBinding == nil { task.terminalBinding = previous.terminalBinding }
                if task.processID == nil { task.processID = previous.processID }
                if task.launchOrigin == nil { task.launchOrigin = previous.launchOrigin }
                if task.sessionName == nil { task.sessionName = previous.sessionName }
            }
            byID[task.id] = task
        }
        return byID.values.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
    }

    private static func isSyntheticHistoryTask(_ task: TrayTaskItem) -> Bool {
        let title = task.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = title.lowercased()
        if lower.hasPrefix("[your previous response had no visible output") { return true }
        if task.sessionID == nil, ["任务已完成", "等待后续活动", "正在处理命令结果", "正在生成回复"].contains(title) {
            return true
        }
        return false
    }

    private static func isDSHSubagentHistoryTask(_ task: TrayTaskItem) -> Bool {
        guard task.platform == .dsh, let path = task.sourcePath else { return false }
        return !URL(fileURLWithPath: path).deletingLastPathComponent().lastPathComponent.hasPrefix("session-")
    }

    private static func isDSHBackedCodexTask(_ task: TrayTaskItem) -> Bool {
        guard task.platform == .codex, let path = task.sourcePath,
              let handle = FileHandle(forReadingAtPath: path) else { return false }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: 16_384),
              let newline = data.firstIndex(of: 0x0A),
              let object = try? JSONSerialization.jsonObject(with: Data(data[..<newline])) as? [String: Any],
              let payload = object["payload"] as? [String: Any] else { return false }
        let originator = (payload["originator"] as? String ?? "").lowercased()
        let threadSource = (payload["thread_source"] as? String ?? "").lowercased()
        return originator.contains("dsh") || threadSource.contains("dsh")
    }

    private static func loadTaskHistory(home: URL) -> LoadedTaskHistory {
        let url = taskHistoryURL(home: home)
        guard let data = try? Data(contentsOf: url),
              let stored = try? JSONDecoder().decode(PersistedTaskHistory.self, from: data) else {
            return LoadedTaskHistory(platforms: [:], dismissedTaskIDs: [])
        }
        var result: [PlatformKind: [TrayTaskItem]] = [:]
        for (key, tasks) in stored.platforms {
            guard let platform = PlatformKind(rawValue: key) else { continue }
            let ownedTasks = tasks.filter {
                $0.sessionID?.isEmpty == false
                    && !isDSHBackedCodexTask($0)
                    && !isDSHSubagentHistoryTask($0)
                    && !isSyntheticHistoryTask($0)
            }.map { enrichStoredTask($0, home: home) }
            result[platform] = Array(deduplicatedTasks(ownedTasks).prefix(12))
        }
        var dismissed = stored.dismissedTaskIDs.map { id -> String in
            guard id.hasPrefix("dsh|") else { return id }
            let identity = String(id.dropFirst("dsh|".count))
            return UUID(uuidString: identity) == nil ? id : "dsh|session-\(identity)"
        }
        if dismissed.count > 100 { dismissed.removeFirst(dismissed.count - 100) }
        return LoadedTaskHistory(platforms: result, dismissedTaskIDs: dismissed)
    }

    private static func enrichStoredTask(_ input: TrayTaskItem, home: URL) -> TrayTaskItem {
        var task = input
        guard let sessionID = task.sessionID else { return task }
        switch task.platform {
        case .codex:
            task.sessionName = CodexSessionNameLookup.name(for: sessionID, transcriptPath: task.sourcePath, home: home) ?? task.sessionName
            if task.launchOrigin == nil, let path = task.sourcePath {
                task.launchOrigin = CodexTranscriptIdentityLookup.read(path: path).launchOrigin
            }
        case .claude:
            if let path = task.sourcePath {
                let identity = ClaudeTranscriptIdentityLookup.read(path: path)
                if task.launchOrigin == nil { task.launchOrigin = identity.launchOrigin }
                task.sessionName = identity.customTitle ?? task.sessionName
            }
            if let origin = task.launchOrigin?.lowercased(),
               origin.contains("desktop") || origin.contains("3p") || origin.contains("claude.ai"),
               let record = ClaudeDesktopSessionLookup.originalSession(forCLI: sessionID, roots: ClaudeDesktopSessionLookup.defaultRoots()) {
                task.sessionName = record.title ?? task.sessionName
            }
        case .grok:
            if task.sessionName == nil, let cwd = task.workingDirectory {
                let value = URL(fileURLWithPath: cwd).lastPathComponent
                if !value.isEmpty { task.sessionName = value }
            }
        case .dsh:
            task.sessionName = DSHSessionNameLookup.name(for: sessionID, home: home) ?? task.sessionName
        }
        return task
    }

    private func saveTaskHistory() {
        let url = Self.taskHistoryURL(home: home)
        let platforms = Dictionary(uniqueKeysWithValues: taskHistory.map {
            ($0.key.rawValue, Self.deduplicatedTasks($0.value))
        })
        if dismissedTaskIDs.count > 100 {
            dismissedTaskIDs.removeFirst(dismissedTaskIDs.count - 100)
        }
        let stored = PersistedTaskHistory(platforms: platforms, dismissedTaskIDs: dismissedTaskIDs)
        guard let data = try? JSONEncoder().encode(stored) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    private func inferredTerminalStatus(from status: PlatformStatus) -> PlatformStatus? {
        guard status.phase == .idle else { return nil }
        let action = status.task?.action ?? status.detail
        var inferred = status
        if action.contains("完成") || action.localizedCaseInsensitiveContains("complete") {
            inferred.phase = .done
            return inferred
        }
        if action.contains("失败") || action.contains("出错") || action.localizedCaseInsensitiveContains("error") {
            inferred.phase = .failed
            return inferred
        }
        return nil
    }

    private func platformOrder(_ platform: PlatformKind) -> Int {
        PlatformKind.allCases.firstIndex(of: platform) ?? .max
    }

    private func setTaskTrayVisible(_ visible: Bool) {
        guard taskTrayIsVisible != visible,
              let traySize = taskTrayView?.preferredSize else { return }
        updateTaskTrayLayout(visible: visible, traySize: traySize)
    }

    private func resizeTaskTray(to size: NSSize) {
        guard taskTrayIsVisible else { return }
        updateTaskTrayLayout(visible: true, traySize: size)
    }

    /// 气泡隐藏时把窗口缩到精灵；展开列表/详情时保持宠物在屏幕上的位置不跳动。
    private func updateTaskTrayLayout(visible: Bool, traySize: NSSize) {
        guard let window, let bundle, let spriteView, let taskTrayView else { return }
        let spriteScreenOrigin = NSPoint(
            x: window.frame.minX + spriteView.frame.minX,
            y: window.frame.minY + spriteView.frame.minY
        )
        taskTrayIsVisible = visible
        let metrics = layoutMetrics(for: bundle, traySize: traySize)
        window.setContentSize(visible ? metrics.content : metrics.sprite)
        spriteView.frame = NSRect(
            x: visible ? (metrics.content.width - metrics.sprite.width) / 2 : 0,
            y: 0,
            width: metrics.sprite.width,
            height: metrics.sprite.height
        )
        taskTrayView.frame = NSRect(
            x: visible ? (metrics.content.width - metrics.tray.width) / 2 : 0,
            y: metrics.sprite.height + 6,
            width: metrics.tray.width,
            height: metrics.tray.height
        )
        taskTrayView.isHidden = !visible
        window.setFrameOrigin(NSPoint(
            x: spriteScreenOrigin.x - spriteView.frame.minX,
            y: spriteScreenOrigin.y
        ))
    }

    private func installOutsideClickHandling() {
        guard globalClickMonitor == nil, localClickMonitor == nil else { return }
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            let clickPoint = event.locationInWindow
            let timestamp = event.timestamp
            DispatchQueue.main.async {
                guard let self, let frame = self.window?.frame else { return }
                if abs(self.lastInternalMouseDownTimestamp - timestamp) < 0.01 { return }
                if !frame.contains(clickPoint) {
                    self.taskTrayView?.collapseToStage1()
                }
            }
        }
        localClickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            guard let self else { return event }
            if event.window === self.window { self.lastInternalMouseDownTimestamp = event.timestamp }
            guard event.window === self.window,
                  let content = self.window?.contentView,
                  let tray = self.taskTrayView,
                  let sprite = self.spriteView else {
                self.taskTrayView?.collapseToStage1()
                return event
            }
            let point = content.convert(event.locationInWindow, from: nil)
            if !tray.frame.contains(point), !sprite.frame.contains(point) {
                tray.collapseToStage1()
            }
            return event
        }
    }

    deinit {
        if let globalClickMonitor { NSEvent.removeMonitor(globalClickMonitor) }
        if let localClickMonitor { NSEvent.removeMonitor(localClickMonitor) }
    }

    // MARK: - Menu bar

    private func setupMenuBar() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "🐾"
        let menu = NSMenu()

        let toggle = NSMenuItem(title: "显示/隐藏宠物", action: #selector(togglePet), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)

        let petsMenu = makePetsMenu()
        if petsMenu.numberOfItems > 0 {
            let petsItem = NSMenuItem(title: "宠物", action: nil, keyEquivalent: "")
            petsItem.submenu = petsMenu
            menu.addItem(petsItem)
        }

        menu.addItem(.separator())
        for kind in PlatformKind.allCases {
            let statusItem = NSMenuItem(title: "\(kind.label)：加载中…", action: nil, keyEquivalent: "")
            statusItem.isEnabled = false
            statusMenuItems[kind] = statusItem
            menu.addItem(statusItem)
        }

        menu.addItem(.separator())
        let openConfig = NSMenuItem(title: "打开配置", action: #selector(openConfig), keyEquivalent: "")
        openConfig.target = self
        menu.addItem(openConfig)

        let quit = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        item.menu = menu
        self.statusItem = item
    }

    private func makePetsMenu() -> NSMenu {
        let menu = NSMenu()
        let configured = config.pet.bundlePath.map { URL(fileURLWithPath: PathExpander.expand($0)).standardizedFileURL.path }
        for bundle in PetDiscovery.discover(home: home) {
            let item = NSMenuItem()
            let view = PetMenuItemView(
                thumbnail: petThumbnail(for: bundle),
                title: bundle.manifest.displayName,
                isCurrent: bundle.directoryURL.standardizedFileURL.path == configured
            )
            view.onSelect = { [weak self] in
                self?.selectPet(bundle: bundle)
            }
            view.onDelete = { [weak self] in
                self?.deletePet(bundle: bundle)
            }
            item.view = view
            menu.addItem(item)
        }
        if menu.numberOfItems > 0 { menu.addItem(.separator()) }
        // 默认宠物目录：开箱即可一键安装的社区宠物。
        let defaultsItem = NSMenuItem(title: "默认宠物", action: nil, keyEquivalent: "")
        let defaultsMenu = NSMenu()
        for pet in DefaultPets.catalog {
            let item = NSMenuItem(title: "\(pet.displayName)（\(pet.slug)）", action: #selector(PetApp.installDefaultPet(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = pet.slug
            item.isEnabled = !petImportInProgress
            defaultsMenu.addItem(item)
        }
        defaultsItem.submenu = defaultsMenu
        menu.addItem(defaultsItem)
        menu.addItem(.separator())
        let installItem = NSMenuItem(title: "从 GitHub 安装宠物…", action: #selector(PetApp.installPetFromSource), keyEquivalent: "")
        installItem.target = self
        installItem.isEnabled = !petImportInProgress
        menu.addItem(installItem)
        let importItem = NSMenuItem(title: "导入本地宠物…", action: #selector(PetApp.importPetModel), keyEquivalent: "")
        importItem.target = self
        importItem.isEnabled = !petImportInProgress
        menu.addItem(importItem)
        let formats = NSMenuItem(title: "cc-haha · clawd-on-desk · LingChat", action: nil, keyEquivalent: "")
        formats.isEnabled = false
        menu.addItem(formats)
        return menu
    }

    @objc private func installDefaultPet(_ sender: NSMenuItem) {
        guard !petImportInProgress, let slug = sender.representedObject as? String else { return }
        runPetInstall(source: "petdex install \(slug)")
    }

    @objc private func installPetFromSource() {
        guard !petImportInProgress else { return }
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "安装宠物"
        let presets = PetRegistry.presets.map { "• \($0.id) — \($0.repositoryURL)" }.joined(separator: "\n")
        let remoteSources = RemotePetSource.allCases.map { "• \($0.label) — 输入 \($0.usageHint)" }.joined(separator: "\n")
        let defaultPets = DefaultPets.catalog.map { "• \($0.displayName) — 输入 \($0.installCommand)" }.joined(separator: "\n")
        alert.informativeText = "输入预设 ID、默认宠物名、远程源官方命令或 GitHub 仓库 URL，即可安装并设为默认宠物。\n\n默认宠物：\n\(defaultPets)\n\n远程源：\n\(remoteSources)\n\nGitHub 预设：\n\(presets)"
        alert.addButton(withTitle: "安装")
        alert.addButton(withTitle: "取消")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        field.placeholderString = "例如：petdex install boba 或 firefly--lingxiaotian 或 https://github.com/…/…"
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let source = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !source.isEmpty else { return }
        runPetInstall(source: source)
    }

    private func runPetInstall(source: String) {
        petImportInProgress = true
        statusItem?.button?.title = "🐾 安装中…"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let result = Result { try PetInstaller.install(source: source, home: self.home) }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.petImportInProgress = false
                self.statusItem?.button?.title = "🐾"
                switch result {
                case .success(let installed):
                    do {
                        try self.switchPet(to: installed.bundle.directoryURL)
                    } catch {
                        let alert = NSAlert(error: error)
                        alert.messageText = "宠物已安装，但无法设为当前宠物"
                        alert.informativeText = "安装包保留在：\(installed.bundle.directoryURL.path)\n\n\(error.localizedDescription)"
                        alert.runModal()
                        return
                    }
                    if let petsItem = self.statusItem?.menu?.items.first(where: { $0.title == "宠物" }) {
                        petsItem.submenu = self.makePetsMenu()
                    }
                    let alert = NSAlert()
                    alert.messageText = "已安装：\(installed.bundle.manifest.displayName)"
                    alert.informativeText = "\(installed.note)\n\n授权提示：\(installed.sourceKind.licenseNotice)"
                    alert.alertStyle = .informational
                    alert.runModal()
                case .failure(let error):
                    let alert = NSAlert(error: error)
                    alert.messageText = "宠物安装失败"
                    alert.runModal()
                }
            }
        }
    }

    @objc private func importPetModel() {
        guard !petImportInProgress else { return }
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.title = "导入本地宠物模型"
        panel.message = "选择 pet.json、clawd 主题/项目目录，或 LingChat 角色目录。AllPet 不会联网下载或打包第三方素材。"
        panel.prompt = "导入并使用"
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.treatsFilePackagesAsDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        petImportInProgress = true
        statusItem?.button?.title = "🐾 导入中…"
        statusItem?.menu?.items.first(where: { $0.title == "宠物" })?.submenu?.items
            .first(where: { $0.action == #selector(PetApp.importPetModel) })?.isEnabled = false
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let result = Result { try PetModelImporter.importModel(from: url, home: self.home) }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.petImportInProgress = false
                self.statusItem?.button?.title = "🐾"
                self.statusItem?.menu?.items.first(where: { $0.title == "宠物" })?.submenu?.items
                    .first(where: { $0.action == #selector(PetApp.importPetModel) })?.isEnabled = true
                switch result {
                case .success(let imported):
                    do {
                        try self.switchPet(to: imported.bundle.directoryURL)
                    } catch {
                        let alert = NSAlert(error: error)
                        alert.messageText = "宠物已导入，但无法设为当前宠物"
                        alert.informativeText = "导入包保留在：\(imported.bundle.directoryURL.path)\n\n\(error.localizedDescription)"
                        alert.runModal()
                        return
                    }
                    if let petsItem = self.statusItem?.menu?.items.first(where: { $0.title == "宠物" }) {
                        petsItem.submenu = self.makePetsMenu()
                    }
                    let alert = NSAlert()
                    alert.messageText = "已导入：\(imported.bundle.manifest.displayName)"
                    alert.informativeText = "\(imported.note)\n\n授权提示：\(imported.sourceKind.licenseNotice)"
                    alert.alertStyle = .informational
                    alert.runModal()
                case .failure(let error):
                    let alert = NSAlert(error: error)
                    alert.messageText = "宠物导入失败"
                    alert.runModal()
                }
            }
        }
    }

    private func selectPet(bundle: PetBundle) {
        do {
            try switchPet(to: bundle.directoryURL)
        } catch {
            let alert = NSAlert(error: error)
            alert.messageText = "无法切换宠物"
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    private func deletePet(bundle: PetBundle) {
        let confirm = NSAlert()
        confirm.alertStyle = .warning
        confirm.messageText = "删除宠物「\(bundle.manifest.displayName)」？"
        confirm.informativeText = "将删除以下目录：\n\(bundle.directoryURL.path)\n\n此操作无法撤销。"
        confirm.addButton(withTitle: "删除")
        confirm.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard confirm.runModal() == .alertFirstButtonReturn else { return }

        do {
            try FileManager.default.removeItem(at: bundle.directoryURL)
        } catch {
            let alert = NSAlert(error: error)
            alert.messageText = "删除宠物失败"
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            return
        }

        let deletedPath = bundle.directoryURL.standardizedFileURL.path
        let currentPath = config.pet.bundlePath.map { URL(fileURLWithPath: PathExpander.expand($0)).standardizedFileURL.path }
        if deletedPath == currentPath {
            if let replacement = PetDiscovery.discover(home: home).first {
                do {
                    try switchPet(to: replacement.directoryURL)
                } catch {
                    clearCurrentPet()
                }
            } else {
                clearCurrentPet()
            }
        }
        rebuildPetsMenu()
    }

    private func clearCurrentPet() {
        var nextConfig = config
        nextConfig.pet.bundlePath = nil
        try? nextConfig.save(to: AllPetConfiguration.configURL(home: home))
        config = nextConfig
        self.bundle = nil
        self.frames = []
        frameTimer?.invalidate()
        frameTimer = nil
        playbackFrames.removeAll(keepingCapacity: true)
        spriteView?.frameImage = nil
        statusItem?.button?.title = "🐾(无宠物)"
    }

    private func rebuildPetsMenu() {
        if let petsItem = statusItem?.menu?.items.first(where: { $0.title == "宠物" }) {
            petsItem.submenu = makePetsMenu()
        }
    }

    private func switchPet(to dir: URL) throws {
        let bundle = try PetBundle.load(from: dir)
        guard let frames = loadFrames(bundle) else { throw PetError.invalidSpritesheet(bundle.spritesheetURL) }
        var nextConfig = config
        nextConfig.pet.bundlePath = dir.standardizedFileURL.path
        try nextConfig.save(to: AllPetConfiguration.configURL(home: home))
        config = nextConfig
        self.bundle = bundle
        self.frames = frames
        rebuildPetsMenu()

        guard let window, let spriteView else { return }
        let oldSpriteScreenOrigin = NSPoint(
            x: window.frame.minX + spriteView.frame.minX,
            y: window.frame.minY + spriteView.frame.minY
        )
        let traySize = taskTrayView?.preferredSize ?? NSSize(width: 304, height: 72)
        let metrics = layoutMetrics(for: bundle, traySize: traySize)
        window.setContentSize(taskTrayIsVisible ? metrics.content : metrics.sprite)
        taskTrayView?.frame = NSRect(
            x: taskTrayIsVisible ? (metrics.content.width - metrics.tray.width) / 2 : 0,
            y: metrics.sprite.height + 6,
            width: metrics.tray.width,
            height: metrics.tray.height
        )
        spriteView.frame = NSRect(
            x: taskTrayIsVisible ? (metrics.content.width - metrics.sprite.width) / 2 : 0,
            y: 0,
            width: metrics.sprite.width,
            height: metrics.sprite.height
        )
        window.setFrameOrigin(NSPoint(
            x: oldSpriteScreenOrigin.x - spriteView.frame.minX,
            y: oldSpriteScreenOrigin.y
        ))
        frameTimer?.invalidate()
        frameTimer = nil
        playbackFrames.removeAll(keepingCapacity: true)
        setAnimation(animation)
    }

    private func updateMenu(_ snapshot: PetSnapshot) {
        for platform in snapshot.platforms {
            var title = "\(platform.platform.label)：\(platform.phase.label)"
            if let action = platform.task?.action, !action.isEmpty {
                title += " · \(String(action.prefix(28)))"
            }
            statusMenuItems[platform.platform]?.title = title
        }
    }

    @objc private func togglePet() {
        guard let window else { return }
        window.setIsVisible(!window.isVisible)
    }

    @objc private func openConfig() {
        let url = AllPetConfiguration.configURL(home: home)
        if !FileManager.default.fileExists(atPath: url.path) {
            try? AllPetConfiguration.makeDefault(home: home).save(to: url)
        }
        NSWorkspace.shared.open(url)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

/// GUI 入口（由 main.swift 在无参数 / `gui` / `run` 时调用）。
func runGUI() {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let config = AllPetConfiguration.load(from: AllPetConfiguration.configURL(home: home), home: home)
    let petApp = PetApp(config: config, home: home)
    petApp.run()
}
#endif
