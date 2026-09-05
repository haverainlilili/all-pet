import AppKit
import AllPetCore

/// 绘制当前帧的视图（把切好的 CGImage 帧铺满 bounds）。
final class SpriteView: NSView {
    var frameImage: CGImage? {
        didSet { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let image = frameImage, let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: bounds)
    }
}

/// macOS 桌面宠物应用：透明悬浮窗 + 精灵动画 + 菜单栏 + 多平台状态。
final class PetApp: NSObject {
    private var config: AllPetConfiguration
    private let monitor: AllPetMonitor
    private let home: URL

    private var bundle: PetBundle?
    private var frames: [CGImage] = []

    private var window: NSWindow?
    private var spriteView: SpriteView?
    private var bubbleLabel: NSTextField?
    private var statusItem: NSStatusItem?
    private var statusMenuItems: [PlatformKind: NSMenuItem] = [:]

    private var animation: PetAnimation = .idle
    private var frameIndex = 0
    private var frameTimer: Timer?
    private var pollTimer: Timer?

    init(config: AllPetConfiguration, home: URL) {
        self.config = config
        self.home = home
        self.monitor = AllPetMonitor(configuration: config, home: home)
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
                if let cropped = image.cropping(to: rect) {
                    out.append(cropped)
                }
            }
        }
        return out.isEmpty ? nil : out
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

        let spriteSize = NSSize(
            width: CGFloat(bundle.atlas.cellWidth) * CGFloat(config.pet.scale),
            height: CGFloat(bundle.atlas.cellHeight) * CGFloat(config.pet.scale)
        )
        let bubbleHeight: CGFloat = 26
        let contentWidth = max(spriteSize.width, 200)
        let contentSize = NSSize(width: contentWidth, height: spriteSize.height + bubbleHeight)

        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: contentSize),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        window.isMovableByWindowBackground = true

        let content = NSView(frame: NSRect(origin: .zero, size: contentSize))

        let bubble = NSTextField(labelWithString: "")
        bubble.frame = NSRect(x: 0, y: spriteSize.height, width: contentWidth, height: bubbleHeight)
        bubble.alignment = .center
        bubble.font = .systemFont(ofSize: 11, weight: .medium)
        bubble.textColor = .white
        bubble.wantsLayer = true
        bubble.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.62).cgColor
        bubble.layer?.cornerRadius = 8
        bubble.isHidden = true
        content.addSubview(bubble)
        self.bubbleLabel = bubble

        let sprite = SpriteView(frame: NSRect(origin: .zero, size: spriteSize))
        content.addSubview(sprite)
        self.spriteView = sprite

        window.contentView = content
        positionWindow(window, size: contentSize)
        window.orderFrontRegardless()
        self.window = window

        setAnimation(.idle)
    }

    private func positionWindow(_ window: NSWindow, size: NSSize) {
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        let margin: CGFloat = 20
        let anchor = config.pet.anchor
        let origin: NSPoint
        switch anchor {
        case "bottom-left":
            origin = NSPoint(x: visible.minX + margin, y: visible.minY + margin)
        case "top-right":
            origin = NSPoint(x: visible.maxX - size.width - margin, y: visible.maxY - size.height - margin)
        case "top-left":
            origin = NSPoint(x: visible.minX + margin, y: visible.maxY - size.height - margin)
        default: // bottom-right
            origin = NSPoint(x: visible.maxX - size.width - margin, y: visible.minY + margin)
        }
        window.setFrameOrigin(origin)
    }

    // MARK: - Animation

    private func setAnimation(_ anim: PetAnimation) {
        if anim == animation && frameTimer != nil { return }
        animation = anim
        frameIndex = 0
        showFrame()
        scheduleNextFrame()
    }

    private func showFrame() {
        guard let spriteView, !frames.isEmpty else { return }
        let columns = bundle?.atlas.columns ?? PetAtlas.codexColumns
        let durations = animation.frameDurationsMilliseconds
        let i = frameIndex % durations.count
        let index = animation.row * columns + i
        if index < frames.count {
            spriteView.frameImage = frames[index]
        }
    }

    private func scheduleNextFrame() {
        frameTimer?.invalidate()
        let durations = animation.frameDurationsMilliseconds
        let duration = durations[frameIndex % durations.count]
        frameIndex += 1
        frameTimer = Timer.scheduledTimer(withTimeInterval: Double(duration) / 1000.0, repeats: false) { [weak self] _ in
            self?.showFrame()
            self?.scheduleNextFrame()
        }
    }

    // MARK: - Polling

    private func startPolling() {
        let interval = max(0.2, Double(config.watch.pollIntervalMilliseconds) / 1000.0)
        pollTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.tick()
        }
        tick()
    }

    private func tick() {
        let snapshot = monitor.snapshot()
        setAnimation(snapshot.animation)
        updateBubble(snapshot.summary)
        updateMenu(snapshot)
    }

    private func updateBubble(_ text: String) {
        guard let bubble = bubbleLabel else { return }
        if text.isEmpty || text == "全部空闲" {
            bubble.isHidden = true
        } else {
            bubble.stringValue = text
            bubble.isHidden = false
        }
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
        for bundle in PetDiscovery.discover(home: home) {
            let item = NSMenuItem(title: bundle.manifest.displayName, action: #selector(selectPet(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = bundle.directoryURL.path
            item.state = (bundle.directoryURL.path == config.pet.bundlePath) ? .on : .off
            menu.addItem(item)
        }
        return menu
    }

    @objc private func selectPet(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        switchPet(to: URL(fileURLWithPath: path))
    }

    private func switchPet(to dir: URL) {
        guard let bundle = try? PetBundle.load(from: dir),
              let frames = loadFrames(bundle) else { return }
        self.bundle = bundle
        self.frames = frames

        config.pet.bundlePath = dir.path
        try? config.save(to: AllPetConfiguration.configURL(home: home))

        // 重新布局窗口尺寸。
        guard let window else { return }
        let spriteSize = NSSize(
            width: CGFloat(bundle.atlas.cellWidth) * CGFloat(config.pet.scale),
            height: CGFloat(bundle.atlas.cellHeight) * CGFloat(config.pet.scale)
        )
        let bubbleHeight: CGFloat = 26
        let contentWidth = max(spriteSize.width, 200)
        let contentSize = NSSize(width: contentWidth, height: spriteSize.height + bubbleHeight)
        window.setContentSize(contentSize)
        bubbleLabel?.frame = NSRect(x: 0, y: spriteSize.height, width: contentWidth, height: bubbleHeight)
        spriteView?.frame = NSRect(origin: .zero, size: spriteSize)
        setAnimation(.idle)
    }

    private func updateMenu(_ snapshot: PetSnapshot) {
        for platform in snapshot.platforms {
            statusMenuItems[platform.platform]?.title = "\(platform.platform.label)：\(platform.phase.label)"
        }
    }

    @objc private func togglePet() {
        guard let window else { return }
        window.setIsVisible(!window.isVisible)
    }

    @objc private func openConfig() {
        let url = AllPetConfiguration.configURL(home: home)
        if !FileManager.default.fileExists(atPath: url.path) {
            let cfg = AllPetConfiguration.makeDefault(home: home)
            try? cfg.save(to: url)
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
    let app = PetApp(config: config, home: home)
    app.run()
}
