import Foundation
import Darwin
import AllPetCore

func home() -> URL { FileManager.default.homeDirectoryForCurrentUser }
func configURL() -> URL { AllPetConfiguration.configURL(home: home()) }

func terminalSafe(_ value: String, maximumLength: Int = 1_024) -> String {
    let filtered = value.unicodeScalars.map { scalar -> Character in
        let code = scalar.value
        return (code < 0x20 || (0x7f...0x9f).contains(code)) ? " " : Character(String(scalar))
    }
    return String(String(filtered).prefix(maximumLength))
        .replacingOccurrences(of: "  +", with: " ", options: .regularExpression)
}

func loadConfig() -> AllPetConfiguration {
    AllPetConfiguration.load(from: configURL(), home: home())
}

func printHelp() {
    print("""
    allpet — Codex 风格的多平台桌面宠物

    用法:
      ./allpet                 自动构建并在后台启动桌面宠物
      ./allpet stop            停止桌面宠物
      ./allpet restart         重新构建并重启桌面宠物
      ./allpet logs            持续查看 GUI 日志
      ./allpet init            生成默认配置 (~/.config/all-pet/config.json)
      ./allpet status          打印四个平台(Codex/Claude Code/DSH/Grok)的一次快照
      ./allpet watch           持续监控，任务/工具/状态变化时打印
      ./allpet pet list        列出发现的 Codex/热门项目宠物
      ./allpet pet import PATH 导入 cc-haha / clawd-on-desk / LingChat 本地宠物
      ./allpet self-test       检查四平台任务解析器与气泡模型
      ./allpet help            显示本帮助
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
        let detail = terminalSafe(p.detail.isEmpty ? "-" : p.detail)
        print("  \(name) \(phase)  \(detail)  · \(p.activeSessions) 会话 · \(formatAge(p.lastActivityAt, now: s.observedAt))")
        let bubbleDetails = p.bubbleDetails.filter { $0 != detail }
        if !bubbleDetails.isEmpty {
            print("                  ↳ \(terminalSafe(bubbleDetails.joined(separator: " · ")))")
        }
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
        let key = s.summary + "|" + s.platforms.map {
            "\($0.platform.rawValue)=\($0.phase.rawValue)|\($0.task?.action ?? "")|\($0.task?.sessionName ?? "")|\($0.task?.progressLabel ?? "")"
        }.joined(separator: "|")
        if key != lastKey {
            printSnapshot(s)
            lastKey = key
        }
        Thread.sleep(forTimeInterval: Double(intervalMs) / 1000.0)
    }
}


func cmdSelfTest() {
    let report = AllPetSelfTest.run()
    if report.passed {
        print("✅ AllPet self-test 通过（\(report.checks) 项）")
    } else {
        print("❌ AllPet self-test 失败（\(report.failures.count)/\(report.checks) 项）")
        for failure in report.failures { print("  - \(failure)") }
        exit(EXIT_FAILURE)
    }
}

func cmdPetImport(_ path: String) {
    let expanded = (path as NSString).expandingTildeInPath
    let url: URL
    if expanded.hasPrefix("/") {
        url = URL(fileURLWithPath: expanded)
    } else {
        url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
            .appendingPathComponent(expanded)
    }
    let result: PetModelImportResult
    do {
        result = try PetModelImporter.importModel(from: url, home: home())
    } catch {
        print("❌ 导入失败：\(terminalSafe(error.localizedDescription))")
        exit(EXIT_FAILURE)
    }
    do {
        var config = loadConfig()
        config.pet.bundlePath = result.bundle.directoryURL.path
        try config.save(to: configURL())
    } catch {
        print("⚠️ 已导入，但无法设为默认宠物：\(terminalSafe(error.localizedDescription))")
        print("   已保留路径：\(terminalSafe(result.bundle.directoryURL.path))")
        exit(EXIT_FAILURE)
    }
    print("✅ 已导入并设为默认宠物：\(terminalSafe(result.bundle.manifest.displayName, maximumLength: 160))")
    print("   来源格式：\(terminalSafe(result.sourceKind.label, maximumLength: 160))")
    print("   路径：\(terminalSafe(result.bundle.directoryURL.path))")
    print("   方式：\(terminalSafe(result.note))")
    print("   授权：\(terminalSafe(result.sourceKind.licenseNotice))")
    print("   GUI 正在运行时请执行：./allpet restart")
}

func cmdPetList() {
    let bundles = PetDiscovery.discover(home: home())
    if bundles.isEmpty {
        print("未发现任何宠物。请把 pet.json 与其 spritesheetPath 指向的 PNG/WebP 图集放到 ~/.codex/pets/<id>/ 下。")
        return
    }
    for b in bundles {
        print("\(terminalSafe(b.manifest.id, maximumLength: 160))\t\(terminalSafe(b.manifest.displayName, maximumLength: 160))\t\(b.atlas.pixelWidth)x\(b.atlas.pixelHeight)\t\(terminalSafe(b.directoryURL.path))")
    }
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "init": cmdInit()
case "status": cmdStatus()
case "watch": cmdWatch()
case "self-test": cmdSelfTest()
case "pet":
    if args.count > 1 && args[1] == "list" {
        cmdPetList()
    } else if args.count > 2 && args[1] == "import" {
        cmdPetImport(args[2])
    } else {
        printHelp()
    }
case "gui", "run": runGUI()
case "help", "--help", "-h": printHelp()
case nil: runGUI()
default: printHelp()
}
