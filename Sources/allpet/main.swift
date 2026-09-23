import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#elseif canImport(CRT)
import CRT
#endif
import AllPetCore

func home() -> URL {
    if let override = ProcessInfo.processInfo.environment["ALLPET_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines),
       !override.isEmpty {
        return URL(fileURLWithPath: override, isDirectory: true).standardizedFileURL
    }
    return FileManager.default.homeDirectoryForCurrentUser
}
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

    桌面宠物 GUI 仅支持 macOS；status/watch 等 CLI 支持 macOS / Linux / Windows。

    用法:
      ./allpet                 构建并在后台启动桌面宠物（仅 macOS）
      ./allpet stop            停止桌面宠物（仅 macOS）
      ./allpet restart         重新构建并重启桌面宠物（仅 macOS）
      ./allpet logs            持续查看 GUI 日志（仅 macOS）
      ./allpet init            生成默认配置 (~/.config/all-pet/config.json)
      ./allpet status          打印四个平台(Codex/Claude Code/DSH/Grok)的一次快照
      ./allpet watch           持续监控，任务/工具/状态变化时打印
      ./allpet pet list             列出已安装宠物、默认宠物、远程源与 GitHub 预设
      ./allpet pet install 名称     从默认宠物/预设/远程源一键安装为默认宠物（默认宠物如 hoops、奶龙、deepseek酱；预设 cc-haha / clawd-on-desk / lingchat；远程源 petdex / awesome-codex-pet）
      ./allpet pet install 仓库URL  从任意 GitHub 宠物仓库一键安装
      ./allpet pet set 名称          在已安装宠物间切换（按显示名/ID）
      ./allpet pet delete 名称      删除已安装宠物（删除当前宠物时回退到第一个）
      ./allpet pet import PATH      导入 cc-haha / clawd-on-desk / LingChat 本地宠物
      ./allpet self-test            检查四平台任务解析器与气泡模型
      ./allpet help                 显示本帮助
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

private func taskSnapshotKey(_ task: TaskInfo) -> String {
    let binding = task.terminalBinding.map {
        "\($0.tty):\($0.anchorProcessID):\($0.anchorStartedAtMicroseconds)"
    } ?? ""
    var fields: [String] = []
    fields.append(task.sessionID ?? "")
    fields.append(task.sessionName ?? "")
    fields.append(task.title ?? "")
    fields.append(task.action ?? "")
    fields.append(task.progressLabel ?? "")
    fields.append(task.phase?.rawValue ?? "")
    fields.append(task.launchOrigin ?? "")
    fields.append(task.sourcePath ?? "")
    fields.append(task.workingDirectory ?? "")
    fields.append(task.processID.map { String($0) } ?? "")
    fields.append(task.terminalTTY ?? "")
    fields.append(binding)
    fields.append(task.scheduledTaskName ?? "")
    return fields.joined(separator: "~")
}

func snapshotKey(_ s: PetSnapshot) -> String {
    s.summary + "|" + s.platforms.map { platform in
        let tasks = platform.tasks.isEmpty ? platform.task.map { [$0] } ?? [] : platform.tasks
        let taskKey = tasks.map(taskSnapshotKey).joined(separator: "^")
        return "\(platform.platform.rawValue)=\(platform.phase.rawValue)|\(platform.activeSessions)|\(taskKey)"
    }.joined(separator: "|")
}

func cmdWatch() {
    let config = loadConfig()
    let monitor = AllPetMonitor(configuration: config)
    let intervalMs = max(200, config.watch.pollIntervalMilliseconds)
    var lastKey: String? = nil
    print("AllPet watch 启动（\(intervalMs)ms 轮询，Ctrl-C 退出）")
    while true {
        let s = monitor.snapshot()
        let key = snapshotKey(s)
        if key != lastKey {
            printSnapshot(s)
            lastKey = key
        }
        Thread.sleep(forTimeInterval: Double(intervalMs) / 1000.0)
    }
}

// MARK: - JSON 输出（供跨平台 GUI 消费）

private struct TaskJSON: Codable {
    var sessionName: String?
    var action: String?
    var toolName: String?
    var completedSteps: Int?
    var totalSteps: Int?
    var progressLabel: String?
    var sessionID: String?
    var sourcePath: String?
    var workingDirectory: String?
    var processID: Int32?
    var terminalTTY: String?
    var terminalBinding: TerminalBinding?
    var launchOrigin: String?
    var scheduledTaskName: String?
    var title: String?
    var phase: String?
}

private struct PlatformJSON: Codable {
    var platform: String
    var label: String
    var phase: String
    var phaseLabel: String
    var detail: String
    var activeSessions: Int
    var enabled: Bool
    var task: TaskJSON?
    var tasks: [TaskJSON]
    var bubbleHeader: String
    var bubbleDetails: [String]
}

private struct SnapshotJSON: Codable {
    var observedAt: String
    var animation: String
    var phase: String
    var summary: String
    var platforms: [PlatformJSON]
}

private func taskJSON(_ t: TaskInfo) -> TaskJSON {
    TaskJSON(
        sessionName: t.sessionName,
        action: t.action,
        toolName: t.toolName,
        completedSteps: t.completedSteps,
        totalSteps: t.totalSteps,
        progressLabel: t.progressLabel,
        sessionID: t.sessionID,
        sourcePath: t.sourcePath,
        workingDirectory: t.workingDirectory,
        processID: t.processID,
        terminalTTY: t.terminalTTY,
        terminalBinding: t.terminalBinding,
        launchOrigin: t.launchOrigin,
        scheduledTaskName: t.scheduledTaskName,
        title: t.title,
        phase: t.phase?.rawValue
    )
}

private func toJSON(_ s: PetSnapshot) -> SnapshotJSON {
    let df = ISO8601DateFormatter()
    return SnapshotJSON(
        observedAt: df.string(from: s.observedAt),
        animation: s.animation.rawValue,
        phase: s.phase.rawValue,
        summary: s.summary,
        platforms: s.platforms.map { p in
            PlatformJSON(
                platform: p.platform.rawValue,
                label: p.platform.label,
                phase: p.phase.rawValue,
                phaseLabel: p.phase.label,
                detail: p.detail,
                activeSessions: p.activeSessions,
                enabled: p.enabled,
                task: p.task.map { taskJSON($0) },
                tasks: p.tasks.map { taskJSON($0) },
                bubbleHeader: p.bubbleHeader,
                bubbleDetails: p.bubbleDetails
            )
        }
    )
}

private func emitJSON(_ s: PetSnapshot) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(toJSON(s)),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func cmdStatusJSON() {
    let monitor = AllPetMonitor(configuration: loadConfig())
    emitJSON(monitor.snapshot())
}

func cmdWatchJSON() {
    let config = loadConfig()
    let monitor = AllPetMonitor(configuration: config)
    let intervalMs = max(200, config.watch.pollIntervalMilliseconds)
    var lastKey: String? = nil
    while true {
        let s = monitor.snapshot()
        let key = snapshotKey(s)
        if key != lastKey {
            emitJSON(s)
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
        print("未发现已安装宠物。")
    } else {
        print("已安装宠物：")
        for b in bundles {
            print("  \(terminalSafe(b.manifest.id, maximumLength: 160))\t\(terminalSafe(b.manifest.displayName, maximumLength: 160))\t\(b.atlas.pixelWidth)x\(b.atlas.pixelHeight)\t\(terminalSafe(b.directoryURL.path))")
        }
    }
    print("\n远程宠物源（输入官方命令即可安装）：")
    for source in RemotePetSource.allCases {
        print("  \(source.label)\t输入 \(source.usageHint)")
    }
    print("\n默认宠物（输入名称即可安装）：")
    for pet in DefaultPets.catalog {
        print("  \(terminalSafe(pet.slug, maximumLength: 160))\t\(terminalSafe(pet.displayName, maximumLength: 160))\t\(terminalSafe(pet.pageURL, maximumLength: 160))")
    }
    print("\n可从 GitHub 一键安装的预设：")
    for p in PetRegistry.presets {
        print("  \(terminalSafe(p.id, maximumLength: 160))\t\(terminalSafe(p.name, maximumLength: 160))\t\(terminalSafe(p.repositoryURL, maximumLength: 160))")
    }
    print("\n用法：")
    print("  ./allpet pet install <预设ID / 默认宠物名 / 远程源命令 / GitHub 仓库URL>")
    print("  ./allpet pet set <显示名或ID>")
    print("  ./allpet pet import <本地路径>")
}

func petPathsEqual(_ lhs: String, _ rhs: String) -> Bool {
    #if os(Windows)
    return lhs.caseInsensitiveCompare(rhs) == .orderedSame
    #else
    return lhs == rhs
    #endif
}

func matchingPetBundle(_ target: String, in bundles: [PetBundle]) -> PetBundle? {
    let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let key = trimmed.lowercased()
    let targetPath = URL(fileURLWithPath: PathExpander.expand(trimmed)).standardizedFileURL.path
    if let exact = bundles.first(where: { petPathsEqual($0.directoryURL.standardizedFileURL.path, targetPath) }) {
        return exact
    }
    // 路径目标必须精确命中；禁止退回 contains 后误操作大小写不同或相邻目录。
    if trimmed.contains("/") || trimmed.contains("\\") { return nil }
    if let exact = bundles.first(where: {
        $0.manifest.id.lowercased() == key || $0.manifest.displayName.lowercased() == key
    }) {
        return exact
    }
    return bundles.first { bundle in
        bundle.manifest.displayName.lowercased().contains(key)
            || bundle.manifest.id.lowercased().contains(key)
            || bundle.directoryURL.path.lowercased().contains(key)
    }
}

func cmdPetSet(_ target: String) {
    let bundles = PetDiscovery.discover(home: home())
    guard let bundle = matchingPetBundle(target, in: bundles) else {
        print("❌ 未找到匹配的宠物：\(terminalSafe(target))")
        print("   可执行 ./allpet pet list 查看已安装宠物。")
        exit(EXIT_FAILURE)
    }
    do {
        var config = loadConfig()
        config.pet.bundlePath = bundle.directoryURL.path
        try config.save(to: configURL())
        print("✅ 已切换为默认宠物：\(terminalSafe(bundle.manifest.displayName, maximumLength: 160))")
        print("   GUI 正在运行时请执行：./allpet restart")
    } catch {
        print("⚠️ 切换失败：\(terminalSafe(error.localizedDescription))")
        exit(EXIT_FAILURE)
    }
}

func cmdPetInstall(_ source: String) {
    let expanded = source.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !expanded.isEmpty else {
        print("❌ 请提供预设 ID 或 GitHub 仓库 URL（./allpet pet list 可查看预设）。")
        exit(EXIT_FAILURE)
    }
    print("🐾 正在安装宠物：\(terminalSafe(expanded)) …")
    let outcome: PetInstallOutcome
    do {
        outcome = try PetInstaller.install(source: expanded, home: home())
    } catch {
        print("❌ 安装失败：\(terminalSafe(error.localizedDescription))")
        exit(EXIT_FAILURE)
    }
    do {
        var config = loadConfig()
        config.pet.bundlePath = outcome.bundle.directoryURL.path
        try config.save(to: configURL())
    } catch {
        print("⚠️ 已安装，但无法设为默认宠物：\(terminalSafe(error.localizedDescription))")
        print("   已保留路径：\(terminalSafe(outcome.bundle.directoryURL.path))")
        exit(EXIT_FAILURE)
    }
    print("✅ 已安装并设为默认宠物：\(terminalSafe(outcome.bundle.manifest.displayName, maximumLength: 160))")
    print("   来源：\(terminalSafe(outcome.repositoryURL, maximumLength: 160))")
    print("   方式：\(terminalSafe(outcome.note))")
    print("   授权：\(terminalSafe(outcome.sourceKind.licenseNotice))")
    print("   GUI 正在运行时请执行：./allpet restart")
}

func cmdPetDelete(_ target: String) {
    let bundles = PetDiscovery.discover(home: home())
    guard let bundle = matchingPetBundle(target, in: bundles) else {
        print("❌ 未找到匹配的宠物：\(terminalSafe(target))")
        print("   可执行 ./allpet pet list 查看已安装宠物。")
        exit(EXIT_FAILURE)
    }
    let deletedPath = bundle.directoryURL.standardizedFileURL.path
    do {
        try FileManager.default.removeItem(at: bundle.directoryURL)
    } catch {
        print("❌ 删除失败：\(terminalSafe(error.localizedDescription))")
        exit(EXIT_FAILURE)
    }
    let config = loadConfig()
    let currentPath = config.pet.bundlePath.map { URL(fileURLWithPath: PathExpander.expand($0)).standardizedFileURL.path }
    if let currentPath, petPathsEqual(currentPath, deletedPath) {
        var next = config
        let remaining = PetDiscovery.discover(home: home())
        next.pet.bundlePath = remaining.first?.directoryURL.standardizedFileURL.path
        do {
            try next.save(to: configURL())
        } catch {
            print("⚠️ 已删除，但无法更新默认宠物：\(terminalSafe(error.localizedDescription))")
            exit(EXIT_FAILURE)
        }
        if let replacement = remaining.first {
            print("✅ 已删除「\(terminalSafe(bundle.manifest.displayName, maximumLength: 160))」，回退到「\(terminalSafe(replacement.manifest.displayName, maximumLength: 160))」")
        } else {
            print("✅ 已删除「\(terminalSafe(bundle.manifest.displayName, maximumLength: 160))」，当前无默认宠物")
        }
    } else {
        print("✅ 已删除「\(terminalSafe(bundle.manifest.displayName, maximumLength: 160))」")
    }
}

private struct PetListJSON: Encodable {
    struct Pet: Encodable {
        let id: String
        let displayName: String
        let description: String
        let spritesheetPath: String
        let columns: Int
        let rows: Int
        let cellWidth: Int
        let cellHeight: Int
        let current: Bool
        let builtin: Bool
        let directoryPath: String
    }
    struct DefaultPet: Encodable {
        let slug: String
        let displayName: String
        let installCommand: String
    }
    let pets: [Pet]
    let defaults: [DefaultPet]
}

func cmdPetListJSON() {
    let config = loadConfig()
    let bundles = PetDiscovery.discover(home: home())
    let currentPath = config.pet.bundlePath.map { URL(fileURLWithPath: PathExpander.expand($0)).standardizedFileURL.path }
    var installedIDs = Set(bundles.map { $0.manifest.id.lowercased() })
    for b in bundles { installedIDs.insert(b.directoryURL.lastPathComponent.lowercased()) }
    let pets = bundles.map { b in
        PetListJSON.Pet(
            id: b.manifest.id,
            displayName: b.manifest.displayName,
            description: b.manifest.description,
            spritesheetPath: b.spritesheetURL.path,
            columns: b.atlas.columns,
            rows: b.atlas.rows,
            cellWidth: b.atlas.cellWidth,
            cellHeight: b.atlas.cellHeight,
            current: currentPath == b.directoryURL.standardizedFileURL.path,
            builtin: BundledPets.slugs.contains(b.manifest.id.lowercased()),
            directoryPath: b.directoryURL.path
        )
    }
    let defaults = DefaultPets.catalog
        .filter { !installedIDs.contains($0.slug.lowercased()) }
        .map { PetListJSON.DefaultPet(slug: $0.slug, displayName: $0.displayName, installCommand: $0.installCommand) }
    let payload = PetListJSON(pets: pets, defaults: defaults)
    if let data = try? JSONEncoder().encode(payload), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

func cmdSelectionSelfTest() {
    var passed = 0
    func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else {
            fputs("❌ PetSelection self-test: \(message)\n", stderr)
            exit(EXIT_FAILURE)
        }
        passed += 1
    }

    let configured = PetSelection.preferred(
        configured: "configured", discovered: ["first", "second"], isValid: { $0 != "invalid" }
    )
    expect(configured == "configured", "有效配置应优先")
    let fallback = PetSelection.preferred(
        configured: "invalid", discovered: ["broken", "first", "second"],
        isValid: { $0 != "invalid" && $0 != "broken" }
    )
    expect(fallback == "first", "失效配置应回退第一只有效宠物")
    let missing = PetSelection.preferred(
        configured: Optional<String>.none, discovered: ["broken"], isValid: { _ in false }
    )
    expect(missing == nil, "没有有效候选时应返回 nil")

    let root = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("allpet-selection-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    do {
        var config = AllPetConfiguration.makeDefault(home: root)
        config.pet.bundlePath = root.appendingPathComponent("pets/boba").path
        let url = AllPetConfiguration.configURL(home: root)
        try config.save(to: url)
        let loaded = AllPetConfiguration.load(from: url, home: root)
        expect(loaded.pet.bundlePath == config.pet.bundlePath, "选择路径应原子保存并可重新读取")
    } catch {
        fputs("❌ PetSelection persistence self-test: \(error)\n", stderr)
        exit(EXIT_FAILURE)
    }
    print("✅ PetSelection self-test 通过（\(passed) 项）")
}

let args = Array(CommandLine.arguments.dropFirst())
let jsonRequested = args.contains("--json")
switch args.first {
case "init": cmdInit()
case "status":
    if jsonRequested { cmdStatusJSON() } else { cmdStatus() }
case "watch":
    if jsonRequested { cmdWatchJSON() } else { cmdWatch() }
case "self-test": cmdSelfTest()
case "selection-self-test": cmdSelectionSelfTest()
case "pet":
    if args.count > 1 && args[1] == "list" {
        if jsonRequested { cmdPetListJSON() } else { cmdPetList() }
    } else if args.count > 2 && args[1] == "import" {
        cmdPetImport(args[2])
    } else if args.count > 2 && args[1] == "install" {
        cmdPetInstall(args[2])
    } else if args.count > 2 && args[1] == "set" {
        cmdPetSet(args[2])
    } else if args.count > 2 && args[1] == "delete" {
        cmdPetDelete(args[2])
    } else {
        printHelp()
    }
case "gui", "run":
    #if os(macOS)
    runGUI()
    #else
    fputs("当前平台暂不支持 GUI（仅 macOS）\n", stderr)
    exit(EXIT_FAILURE)
    #endif
case "help", "--help", "-h": printHelp()
case nil:
    #if os(macOS)
    runGUI()
    #else
    printHelp()
    #endif
default: printHelp()
}
