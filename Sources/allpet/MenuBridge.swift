#if canImport(AppKit)
import AppKit
import Foundation
import Darwin

private struct MenuBridgePet: Decodable { let label: String; let target: String?; let source: String?; let current: Bool?; let iconPath: String? }
private struct MenuBridgeState: Decodable {
    let type: String; let visible: Bool; let hasPet: Bool; let busy: Bool; let busyLabel: String?
    let scalePercent: String; let tooltip: String; let statusIconPath: String?; let platformTitles: [String]
    let installedPets: [MenuBridgePet]; let defaultPets: [MenuBridgePet]
}

final class ElectronMenuBridge: NSObject, NSMenuDelegate, @unchecked Sendable {
    private let initialParentPID = getppid()
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let menu = NSMenu()
    private let sizeControl = PetSizeControlView()
    private var inputBuffer = Data()
    private var latestState: MenuBridgeState?
    private var menuIsOpen = false
    private var needsRebuild = false
    private var parentTimer: Timer?

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
            DispatchQueue.main.async { self?.consume(data) }
        }
        parentTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            if getppid() == 1 || getppid() != self.initialParentPID { NSApp.terminate(nil) }
        }
        emit(["type": "ready", "protocolVersion": 1])
        app.run()
    }

    private func consume(_ data: Data) {
        inputBuffer.append(data)
        while let newline = inputBuffer.firstIndex(of: 0x0A) {
            let line = inputBuffer.prefix(upTo: newline)
            inputBuffer.removeSubrange(...newline)
            guard !line.isEmpty else { continue }
            do {
                let state = try JSONDecoder().decode(MenuBridgeState.self, from: line)
                if state.type == "state" { apply(state) }
            } catch { emit(["type": "error", "message": "invalid state: \(error.localizedDescription)"]) }
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
        for title in state.platformTitles {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: ""); item.isEnabled = false; menu.addItem(item)
        }
        menu.addItem(.separator())
        if state.busy {
            let item = NSMenuItem(title: "正在\(state.busyLabel ?? "处理宠物")…", action: nil, keyEquivalent: "")
            item.isEnabled = false; menu.addItem(item)
        }
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
    private func addItem(_ title: String, action: Selector, keyEquivalent: String = "", to targetMenu: NSMenu? = nil, enabled: Bool = true) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent); item.target = self; item.isEnabled = enabled; (targetMenu ?? menu).addItem(item)
    }
    func menuWillOpen(_ menu: NSMenu) { menuIsOpen = true }
    func menuDidClose(_ menu: NSMenu) { menuIsOpen = false; if needsRebuild, let latestState { rebuildMenu(latestState) } }

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
