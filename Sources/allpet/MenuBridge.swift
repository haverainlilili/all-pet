#if canImport(AppKit)
import AppKit
import Foundation
import Darwin
import AllPetCore
import ApplicationServices

private struct MenuBridgeEnvelope: Decodable { let type: String }
private struct MenuBridgeViewCheck: Decodable, Sendable { let requestID: String; let tasks: [TrayTaskItem] }

private struct MenuBridgePet: Decodable { let label: String; let target: String?; let source: String?; let current: Bool?; let iconPath: String? }
private struct MenuBridgePlatform: Decodable { let key: String; let label: String; let visible: Bool }
private struct MenuBridgeState: Decodable {
    let type: String; let visible: Bool; let hasPet: Bool; let busy: Bool; let busyLabel: String?
    let scalePercent: String; let tooltip: String; let statusIconPath: String?; let platformTitles: [String]
    let bubblePlatforms: [MenuBridgePlatform]?
    let installedPets: [MenuBridgePet]; let defaultPets: [MenuBridgePet]
}

final class ElectronMenuBridge: NSObject, NSMenuDelegate, @unchecked Sendable {
    private let initialParentPID = getppid()
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let menu = NSMenu()
    private let sizeControl = PetSizeControlView()
    private var inputBuffer = Data()
    private var latestState: MenuBridgeState?
    private var bubblePlatformMenuItems: [String: NSMenuItem] = [:]
    private var menuIsOpen = false
    private var needsRebuild = false
    private var accessibilityMenuItem: NSMenuItem?
    private var parentTimer: Timer?
    private var viewCheckInFlight = Set<PlatformKind>()
    private var claudeViewRevisions: [String: TrayTaskItem] = [:]
    private let taskLauncher = TaskLauncher(home: home())

    func run() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        statusItem.button?.title = "🐾"
        menu.delegate = self
        statusItem.menu = menu
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                DispatchQueue.main.async { NSApp.terminate(nil) }
                return
            }
            // Apply incoming checkbox states even while the menu tracking loop is active.
            RunLoop.main.perform(inModes: [.default, .eventTracking]) { self?.consume(data) }
            CFRunLoopWakeUp(CFRunLoopGetMain())
        }
        parentTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            if getppid() == 1 || getppid() != self.initialParentPID { NSApp.terminate(nil) }
        }
        emit(["type": "ready", "protocolVersion": 1, "manualViewAccessibility": AXIsProcessTrusted()])
        app.run()
    }

    private func consume(_ data: Data) {
        inputBuffer.append(data)
        while let newline = inputBuffer.firstIndex(of: 0x0A) {
            let line = inputBuffer.prefix(upTo: newline)
            inputBuffer.removeSubrange(...newline)
            guard !line.isEmpty else { continue }
            do {
                let decoder = JSONDecoder()
                let envelope = try decoder.decode(MenuBridgeEnvelope.self, from: line)
                if envelope.type == "view-check" {
                    checkViewedTasks(try decoder.decode(MenuBridgeViewCheck.self, from: line))
                } else if envelope.type == "state" {
                    apply(try decoder.decode(MenuBridgeState.self, from: line))
                }
            } catch { emit(["type": "error", "message": "invalid state: \(error.localizedDescription)"]) }
        }
    }

    private func checkViewedTasks(_ request: MenuBridgeViewCheck) {
        guard let platform = request.tasks.first?.platform,
              [.codex, .claude, .dsh, .grok, .pi].contains(platform),
              !viewCheckInFlight.contains(platform) else { return }
        let tasks = Array(request.tasks.filter { $0.platform == platform && $0.phase == .done }.prefix(12))
        viewCheckInFlight.insert(platform)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let startedAt = Date()
            let trusted = AXIsProcessTrusted()
            if platform == .claude {
                let current = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
                for (id, task) in current where self.claudeViewRevisions[id] != task {
                    self.taskLauncher.clearClaudeFocusBaseline(for: task.canonicalID)
                }
                self.claudeViewRevisions = current
            }
            let viewed = tasks.filter { self.taskLauncher.isManuallyViewed($0) }.map(\.id)
            let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            DispatchQueue.main.async {
                self.viewCheckInFlight.remove(platform)
                self.updateAccessibilityMenuItem(trusted: trusted)
                self.emit(["type": "view-result", "requestID": request.requestID, "viewedIDs": viewed,
                           "accessibilityTrusted": trusted, "elapsedMs": elapsedMs, "platform": platform.rawValue,
                           "claudeAppActive": NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.anthropic.claudefordesktop"])
            }
        }
    }

    private func apply(_ state: MenuBridgeState) {
        latestState = state
        statusItem.button?.toolTip = state.tooltip
        if let path = state.statusIconPath, let image = NSImage(contentsOfFile: path) {
            image.size = NSSize(width: 18, height: 18)
            image.isTemplate = false
            statusItem.button?.title = ""
            statusItem.button?.image = image
        }
        sizeControl.percentText = state.scalePercent
        sizeControl.isInteractionEnabled = state.hasPet && !state.busy
        for row in state.bubblePlatforms ?? [] {
            if let item = bubblePlatformMenuItems[row.key] {
                PlatformVisibilityMenuView.update(item, checked: row.visible)
            }
        }
        if menuIsOpen { needsRebuild = true } else { rebuildMenu(state) }
    }

    private func rebuildMenu(_ state: MenuBridgeState) {
        menu.removeAllItems()
        addItem("显示/隐藏宠物", action: #selector(togglePet))
        sizeControl.percentText = state.scalePercent
        sizeControl.isInteractionEnabled = state.hasPet && !state.busy
        sizeControl.onDecrease = { [weak self] in self?.emitAction("scale-decrease") }
        sizeControl.onIncrease = { [weak self] in self?.emitAction("scale-increase") }
        let sizeItem = NSMenuItem(); sizeItem.view = sizeControl; menu.addItem(sizeItem)
        let petsItem = NSMenuItem(title: "宠物", action: nil, keyEquivalent: "")
        petsItem.submenu = makePetsMenu(state); menu.addItem(petsItem); menu.addItem(.separator())
        let platforms = NSMenuItem(title: "气泡显示平台", action: nil, keyEquivalent: "")
        let choices = NSMenu()
        bubblePlatformMenuItems.removeAll()
        for row in state.bubblePlatforms ?? [] {
            let item = NSMenuItem(title: row.label, action: nil, keyEquivalent: "")
            item.state = row.visible ? .on : .off
            item.view = PlatformVisibilityMenuView(title: row.label, checked: row.visible) { [weak self] in
                self?.emitAction("bubble-platform-toggle", value: row.key)
            }
            bubblePlatformMenuItems[row.key] = item
            choices.addItem(item)
        }
        choices.addItem(.separator())
        for (title, value) in [("全部显示", "show"), ("全部隐藏", "hide")] {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.view = PlatformVisibilityMenuView(title: title) { [weak self] in
                self?.emitAction("bubble-platform-all", value: value)
            }
            choices.addItem(item)
        }
        choices.addItem(.separator())
        addItem("仅影响气泡显示，保留任务历史", action: nil, to: choices, enabled: false)
        platforms.submenu = choices; menu.addItem(platforms)
        let integration = NSMenuItem(title: "实时状态接入", action: nil, keyEquivalent: "")
        let integrationMenu = NSMenu()
        for (key, name) in [("cursor", "Cursor"), ("qoder", "Qoder")] {
            let item = NSMenuItem(title: "启用/修复 \(name)", action: #selector(installIntegration(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = key; integrationMenu.addItem(item)
        }
        integration.submenu = integrationMenu; menu.addItem(integration)
        for title in state.platformTitles {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: ""); item.isEnabled = false; menu.addItem(item)
        }
        menu.addItem(.separator())
        if state.busy {
            let item = NSMenuItem(title: "正在\(state.busyLabel ?? "处理宠物")…", action: nil, keyEquivalent: "")
            item.isEnabled = false; menu.addItem(item)
        }
        let permission = NSMenuItem(title: "", action: #selector(openAccessibilitySettings), keyEquivalent: "")
        permission.target = self
        accessibilityMenuItem = permission
        updateAccessibilityMenuItem(trusted: AXIsProcessTrusted())
        menu.addItem(permission)
        addItem("打开配置", action: #selector(openConfig))
        addItem("退出", action: #selector(quit), keyEquivalent: "q")
        needsRebuild = false
    }

    private func makePetsMenu(_ state: MenuBridgeState) -> NSMenu {
        let pets = NSMenu()
        if state.installedPets.isEmpty {
            let item = NSMenuItem(title: "暂无已安装宠物", action: nil, keyEquivalent: ""); item.isEnabled = false; pets.addItem(item)
        }
        for pet in state.installedPets {
            let item = NSMenuItem()
            let view = PetMenuItemView(thumbnail: image(at: pet.iconPath), title: pet.label, isCurrent: pet.current == true)
            view.isInteractionEnabled = !state.busy
            view.onSelect = { [weak self] in guard pet.current != true, let value = pet.target else { return }; self?.emitAction("pet-select", value: value) }
            view.onDelete = { [weak self] in guard let value = pet.target else { return }; self?.emitAction("pet-delete", value: value) }
            item.view = view; pets.addItem(item)
        }
        if !state.defaultPets.isEmpty {
            pets.addItem(.separator())
            let heading = NSMenuItem(title: "未安装的默认宠物", action: nil, keyEquivalent: ""); heading.isEnabled = false; pets.addItem(heading)
        }
        for pet in state.defaultPets {
            guard let source = pet.source else { continue }
            let item = NSMenuItem()
            let view = PetMenuDownloadItemView(thumbnail: image(at: pet.iconPath), title: pet.label, slug: source)
            view.isInteractionEnabled = !state.busy
            view.onDownload = { [weak self] in self?.emitAction("pet-install", value: source) }
            item.view = view; pets.addItem(item)
        }
        pets.addItem(.separator())
        addItem("宠物管理…", action: #selector(openManager), to: pets)
        addItem("从 GitHub 安装宠物…", action: #selector(openInstall), to: pets, enabled: !state.busy)
        addItem("导入本地宠物…", action: #selector(openImport), to: pets, enabled: !state.busy)
        addItem("刷新宠物目录", action: #selector(refreshPets), to: pets, enabled: !state.busy)
        let formats = NSMenuItem(title: "格式：cc-haha · clawd-on-desk · LingChat", action: nil, keyEquivalent: ""); formats.isEnabled = false; pets.addItem(formats)
        return pets
    }

    private func image(at path: String?) -> NSImage? { guard let path, !path.isEmpty else { return nil }; return NSImage(contentsOfFile: path) }
    private func addItem(_ title: String, action: Selector?, keyEquivalent: String = "", to targetMenu: NSMenu? = nil, enabled: Bool = true) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent); item.target = self; item.isEnabled = enabled; (targetMenu ?? menu).addItem(item)
    }
    func menuWillOpen(_ menu: NSMenu) {
        menuIsOpen = true
        updateAccessibilityMenuItem(trusted: AXIsProcessTrusted())
    }
    private func updateAccessibilityMenuItem(trusted: Bool) {
        accessibilityMenuItem?.title = trusted
            ? "Codex 自动确认：辅助功能权限已开启"
            : "Codex 自动确认：开启辅助功能权限…"
    }
    @objc private func openAccessibilitySettings() {
        // Only prompt after the user selects this menu action. Never grant permission automatically.
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }
    func menuDidClose(_ menu: NSMenu) { menuIsOpen = false; if needsRebuild, let latestState { rebuildMenu(latestState) } }

    @objc private func installIntegration(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        emitAction("integration-install", value: key)
    }
    @objc private func togglePet() { emitAction("toggle-visibility") }
    @objc private func openConfig() { emitAction("open-config") }
    @objc private func openManager() { emitAction("open-manager") }
    @objc private func openInstall() { emitAction("open-manager", value: "install") }
    @objc private func openImport() { emitAction("open-manager", value: "import") }
    @objc private func refreshPets() { emitAction("refresh-pets") }
    @objc private func quit() { emitAction("quit") }

    private func emitAction(_ action: String, value: String? = nil) {
        var payload = ["type": "action", "action": action]; if let value { payload["value"] = value }; emit(payload)
    }
    private func emit(_ payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload), let data = try? JSONSerialization.data(withJSONObject: payload), var line = String(data: data, encoding: .utf8) else { return }
        line.append("\n"); FileHandle.standardOutput.write(Data(line.utf8))
    }
    deinit { FileHandle.standardInput.readabilityHandler = nil; parentTimer?.invalidate() }
}

private var electronMenuBridge: ElectronMenuBridge?
func runElectronMenuBridge() {
    let bridge = ElectronMenuBridge()
    electronMenuBridge = bridge
    bridge.run()
}
#endif
