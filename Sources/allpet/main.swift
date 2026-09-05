import Foundation
import AllPetCore

func home() -> URL { FileManager.default.homeDirectoryForCurrentUser }
func configURL() -> URL { AllPetConfiguration.configURL(home: home()) }

func loadConfig() -> AllPetConfiguration {
    AllPetConfiguration.load(from: configURL(), home: home())
}

func printHelp() {
    print("""
    allpet — Codex 风格的多平台桌面宠物

    用法:
      allpet init             生成默认配置 (~/.config/all-pet/config.json)
      allpet status           打印四个平台(Codex/Claude Code/DSH/Grok)的一次快照
      allpet watch            持续监控，状态变化时打印
      allpet pet list         列出发现的 Codex 宠物
      allpet help             显示本帮助
    """)
}

func formatAge(_ date: Date?, now: Date) -> String {
    guard let date else { return "-" }
    let s = now.timeIntervalSince(date)
    if s < 5 { return "刚刚" }
    if s < 60 { return "\(Int(s))s 前" }
    if s < 3600 { return "\(Int(s / 60))m 前" }
    if s < 86_400 { return "\(Int(s / 3600))h 前" }
    return "\(Int(s / 86_400))d 前"
}

func printSnapshot(_ s: PetSnapshot) {
    let df = DateFormatter()
    df.dateFormat = "yyyy-MM-dd HH:mm:ss"
    print("AllPet · \(df.string(from: s.observedAt)) · 宠物 \(s.animation.rawValue) · \(s.summary)")

    for p in s.platforms {
        let name = p.platform.label.padding(toLength: 12, withPad: " ", startingAt: 0)
        let phase = p.phase.label.padding(toLength: 5, withPad: " ", startingAt: 0)
        let detail = p.detail.isEmpty ? "-" : p.detail
        print("  \(name) \(phase)  \(detail)  · \(p.activeSessions) 会话 · \(formatAge(p.lastActivityAt, now: s.observedAt))")
    }
}

func cmdInit() {
    let url = configURL()
    if FileManager.default.fileExists(atPath: url.path) {
        print("配置已存在：\(url.path)")
        return
    }
    let cfg = AllPetConfiguration.makeDefault(home: home())
    do {
        try cfg.save(to: url)
        print("已生成默认配置：\(url.path)")
    } catch {
        print("写入失败：\(error.localizedDescription)")
    }
}

func cmdStatus() {
    let monitor = AllPetMonitor(configuration: loadConfig())
    printSnapshot(monitor.snapshot())
}

func cmdWatch() {
    let config = loadConfig()
    let monitor = AllPetMonitor(configuration: config)
    let intervalMs = max(200, config.watch.pollIntervalMilliseconds)
    var lastKey: String? = nil
    print("AllPet watch 启动（\(intervalMs)ms 轮询，Ctrl-C 退出）")
    while true {
        let s = monitor.snapshot()
        let key = s.summary + "|" + s.platforms.map { "\($0.platform.rawValue)=\($0.phase.rawValue)" }.joined(separator: "|")
        if key != lastKey {
            printSnapshot(s)
            lastKey = key
        }
        Thread.sleep(forTimeInterval: Double(intervalMs) / 1000.0)
    }
}

func cmdPetList() {
    let bundles = PetDiscovery.discover(home: home())
    if bundles.isEmpty {
        print("未发现任何宠物。请把 pet.json + spritesheet.webp 放到 ~/.codex/pets/<id>/ 下。")
        return
    }
    for b in bundles {
        print("\(b.manifest.id)\t\(b.manifest.displayName)\t\(b.atlas.pixelWidth)x\(b.atlas.pixelHeight)\t\(b.directoryURL.path)")
    }
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "init": cmdInit()
case "status": cmdStatus()
case "watch": cmdWatch()
case "pet":
    if args.count > 1 && args[1] == "list" { cmdPetList() } else { printHelp() }
case "help", "--help", "-h": printHelp()
default:
    printHelp()
    print("提示：GUI 桌面宠物将在下一步实现；先用 `allpet status` / `allpet watch` 验证多平台监控。")
}
