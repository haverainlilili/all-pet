#if os(macOS)
import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import AllPetCore

/// “唤起状态”：只回到任务本身的浏览器、终端或会话深链；绝不退回应用首页。
final class TaskLauncher: @unchecked Sendable {
    struct Result {
        var succeeded: Bool
        var message: String?
        var terminalTTY: String? = nil
        var terminalBinding: TerminalBinding? = nil
        /// True only when the task program is closed and opening it is required.
        var requiresStrongWake: Bool = false
    }

    private struct TerminalFocusAttempt {
        var binding: TerminalBinding?
        var liveProcessFound: Bool
    }

    private struct ProcessRow {
        var pid: Int32
        var tty: String
        var executable: String
        var command: String
    }

    private enum BrowserKind: Equatable {
        case chromium
        case safari
    }

    private let home: URL
    private var cachedBindingByTask: [String: TerminalBinding] = [:]
    private var recentWakeAt: [String: Date] = [:]
    private let claudeBaselineLock = NSLock()
    private var claudeDesktopFocusBaseline: [String: Double] = [:]

    init(home: URL) {
        self.home = home
    }

    func wake(_ task: TrayTaskItem) -> Result {
        let now = Date()
        recentWakeAt = recentWakeAt.filter { now.timeIntervalSince($0.value) < 10 }
        if let previous = recentWakeAt[task.canonicalID], now.timeIntervalSince(previous) < 2 {
            return Result(succeeded: true, message: nil)
        }
        recentWakeAt[task.canonicalID] = now

        let result: Result
        switch task.platform {
        case .codex: result = openCodex(task)
        case .claude: result = openClaude(task)
        case .dsh: result = openDSH(task)
        case .grok: result = openGrok(task)
        }
        if !result.succeeded { recentWakeAt.removeValue(forKey: task.canonicalID) }
        return result
    }

    enum StrongWakeTarget {
        case automatic
        case claudeDesktop
        case claudeCLI
    }

    /// 强唤起：任务程序已经关闭；经用户确认后启动所选程序，并定位到原任务。
    func strongWake(_ task: TrayTaskItem, target: StrongWakeTarget = .automatic) -> Result {
        switch task.platform {
        case .codex:
            return strongWakeCodex(task)
        case .claude:
            switch target {
            case .claudeDesktop:
                return strongWakeClaudeDesktop(task)
            case .claudeCLI:
                return strongWakeClaudeCLI(task)
            case .automatic:
                return Result(succeeded: false, message: "Claude 强唤起需要选择 Desktop 或 CLI")
            }
        case .dsh:
            return strongWakeDSH(task)
        case .grok:
            return strongWakeGrok(task)
        }
    }

    /// 平台程序是否已经在运行（GUI 应用或终端里的 CLI）。
    func platformAppIsRunning(_ platform: PlatformKind) -> Bool {
        switch platform {
        case .codex:
            return isApplicationRunning(bundleID: "com.openai.codex") || terminalProcessRunning(processNames: ["codex"])
        case .claude:
            return isApplicationRunning(bundleID: "com.anthropic.claudefordesktop") || terminalProcessRunning(processNames: ["claude"])
        case .dsh:
            return dshPageIsOpen()
        case .grok:
            return terminalProcessRunning(processNames: ["grok"])
        }
    }

    /// 平台程序已运行时，把它带到最前面（唤起）。
    func evokePlatform(_ platform: PlatformKind) -> Bool {
        switch platform {
        case .codex:
            if isApplicationRunning(bundleID: "com.openai.codex") {
                return activateApplication(bundleID: "com.openai.codex")
            }
            return focusAnyTerminal(processNames: ["codex"])
        case .claude:
            if isApplicationRunning(bundleID: "com.anthropic.claudefordesktop") {
                return activateApplication(bundleID: "com.anthropic.claudefordesktop")
            }
            return focusAnyTerminal(processNames: ["claude"])
        case .dsh:
            return focusExistingBrowserPage(containing: ["http://127.0.0.1:3080/", "http://localhost:3080/"])
        case .grok:
            return focusAnyTerminal(processNames: ["grok"])
        }
    }

    /// 平台程序未运行时，打开对应平台（GUI 应用优先，否则终端里启动 CLI）。
    func launchPlatform(_ platform: PlatformKind) -> Bool {
        switch platform {
        case .codex:
            if let app = codexAppURL, NSWorkspace.shared.open(app) { return true }
            return launchTerminalExecutable(codexCLIExecutables, identifier: "codex-open")
        case .claude:
            if let app = claudeDesktopAppURL, NSWorkspace.shared.open(app) { return true }
            return launchTerminalExecutable(claudeCLIExecutables, identifier: "claude-open")
        case .dsh:
            guard let url = URL(string: "http://127.0.0.1:3080/") else { return false }
            return NSWorkspace.shared.open(url)
        case .grok:
            return launchTerminalExecutable([grokExecutable], identifier: "grok-open")
        }
    }

    /// 判断用户是否已手动打开/查看该已完成任务；用于让完成气泡自动消失。
    func isManuallyViewed(_ task: TrayTaskItem) -> Bool {
        switch task.platform {
        case .codex:
            return isCodexCLI(task) ? isTerminalTabSelected(task) : isCodexDesktopThreadFocused(task)
        case .claude:
            return isClaudeDesktopTask(task) ? isClaudeDesktopFocusedSinceBaseline(task) : isTerminalTabSelected(task)
        case .dsh:
            return isDSHSessionCurrent(task)
        case .grok:
            return isTerminalTabSelected(task)
        }
    }

    private func openCodex(_ task: TrayTaskItem) -> Result {
        let terminal = focusExistingTerminal(for: task, processNames: ["codex"])
        if let binding = terminal.binding {
            return Result(succeeded: true, message: nil, terminalTTY: binding.tty, terminalBinding: binding)
        }
        if terminal.liveProcessFound {
            return Result(succeeded: false, message: "已找到原 Codex 终端，但自动化聚焦失败；未重新打开任务")
        }
        if isCodexCLI(task) {
            return Result(
                succeeded: false,
                message: "Codex CLI 已关闭，是否在此前终端重新打开该会话？",
                requiresStrongWake: true
            )
        }
        if let sessionID = task.sessionID, !sessionID.isEmpty {
            guard isApplicationRunning(bundleID: "com.openai.codex") else {
                return Result(
                    succeeded: false,
                    message: "Codex 已关闭，是否重新打开到该会话？",
                    requiresStrongWake: true
                )
            }
            var components = URLComponents()
            components.scheme = "codex"
            components.host = "threads"
            components.path = "/\(sessionID)"
            if let url = components.url, NSWorkspace.shared.open(url) {
                return Result(succeeded: true, message: nil)
            }
            return Result(succeeded: false, message: "无法向 Codex 发送原会话深链；任务气泡已保留")
        }
        return Result(succeeded: false, message: "缺少可定位的 Codex 会话，未打开应用首页")
    }

    private func openClaude(_ task: TrayTaskItem) -> Result {
        let terminal = focusExistingTerminal(for: task, processNames: ["claude"])
        if let binding = terminal.binding {
            return Result(succeeded: true, message: nil, terminalTTY: binding.tty, terminalBinding: binding)
        }
        if terminal.liveProcessFound {
            return Result(succeeded: false, message: "已找到原 Claude 终端，但自动化聚焦失败；未重新打开任务")
        }
        if let sessionID = task.sessionID, !sessionID.isEmpty {
            let recoveredOrigin = task.launchOrigin
                ?? task.sourcePath.map { ClaudeTranscriptIdentityLookup.read(path: $0).launchOrigin }
                ?? nil
            let desktopOwned = recoveredOrigin == "claude-desktop-3p" || sessionID.hasPrefix("local_")
            let desktopSession = sessionID.hasPrefix("local_")
                ? ClaudeDesktopSessionLookup.session(withID: sessionID, roots: claudeDesktopSessionRoots)
                : (desktopOwned ? claudeDesktopSession(for: sessionID) : nil)
            if let desktopSession {
                guard isApplicationRunning(bundleID: "com.anthropic.claudefordesktop") else {
                    return Result(
                        succeeded: false,
                        message: "Claude Desktop 已关闭，是否重新打开到该会话？",
                        requiresStrongWake: true
                    )
                }
                var components = URLComponents()
                components.scheme = "claude"
                components.host = "claude.ai"
                components.path = "/epitaxy/\(desktopSession.sessionID)"
                if let url = components.url, NSWorkspace.shared.open(url),
                   waitForApplicationRunning(bundleID: "com.anthropic.claudefordesktop", timeout: 8) {
                    return Result(succeeded: true, message: nil)
                }
                return Result(succeeded: false, message: "Claude Desktop 未能打开到原任务；任务气泡已保留")
            } else if desktopOwned, isApplicationRunning(bundleID: "com.anthropic.claudefordesktop") {
                return Result(
                    succeeded: false,
                    message: "Claude Desktop 仍在运行，但找不到该任务的原始 metadata；未进入强唤起，也未创建副本"
                )
            } else {
                return Result(
                    succeeded: false,
                    message: "Claude 任务程序已关闭，强唤起时请选择 Desktop 或 CLI",
                    requiresStrongWake: true
                )
            }
        }
        return Result(succeeded: false, message: "找不到原 Claude 任务界面；为避免创建副本，没有执行 Desktop resume 导入")
    }

    private func openDSH(_ task: TrayTaskItem) -> Result {
        guard let sessionID = task.sessionID, !sessionID.isEmpty else {
            return Result(succeeded: false, message: "缺少 DSH 会话标识，未只打开浏览器首页")
        }
        guard let sourcePath = task.sourcePath, !sourcePath.isEmpty,
              FileManager.default.fileExists(atPath: sourcePath) else {
            return Result(succeeded: false, message: "DSH 任务记录已不存在，未打开其他会话")
        }
        let needles = ["http://127.0.0.1:3080/", "http://localhost:3080/"]
        if focusExistingBrowserPage(containing: needles, selectingDSHSession: sessionID) {
            return Result(succeeded: true, message: nil)
        }
        return Result(
            succeeded: false,
            message: "此前打开的 DSH 页面已关闭，是否重新打开到该会话？",
            requiresStrongWake: true
        )
    }

    private func openGrok(_ task: TrayTaskItem) -> Result {
        let terminal = focusExistingTerminal(for: task, processNames: ["grok"])
        if let binding = terminal.binding {
            return Result(succeeded: true, message: nil, terminalTTY: binding.tty, terminalBinding: binding)
        }
        if terminal.liveProcessFound {
            return Result(succeeded: false, message: "已找到原 Grok 终端，但自动化聚焦失败；未重新打开任务")
        }
        return Result(
            succeeded: false,
            message: "Grok 已关闭，是否在此前终端重新打开该会话？",
            requiresStrongWake: true
        )
    }

    private func strongWakeCodex(_ task: TrayTaskItem) -> Result {
        guard let sessionID = task.sessionID, !sessionID.isEmpty else {
            return Result(succeeded: false, message: "缺少 Codex 会话标识")
        }
        guard codexSessionIsKnown(task, sessionID: sessionID) else {
            return Result(succeeded: false, message: "找不到该 Codex 原会话记录，未执行强唤起")
        }
        if isCodexCLI(task) {
            let executables = [
                home.appendingPathComponent(".local/bin/codex").path,
                home.appendingPathComponent(".npm-global/bin/codex").path,
                "/opt/homebrew/bin/codex",
                "/usr/local/bin/codex"
            ]
            guard let executable = executables.first(where: FileManager.default.isExecutableFile(atPath:)) else {
                return Result(succeeded: false, message: "找不到 Codex CLI 可执行文件")
            }
            return reopenTerminalCommand(
                task: task,
                executable: executable,
                arguments: ["resume", sessionID],
                identifier: "codex-\(sessionID)",
                workingDirectory: task.workingDirectory,
                processNames: ["codex"],
                sessionID: sessionID
            )
        }
        var components = URLComponents()
        components.scheme = "codex"
        components.host = "threads"
        components.path = "/\(sessionID)"
        guard let url = components.url, NSWorkspace.shared.open(url),
              waitForApplicationRunning(bundleID: "com.openai.codex", timeout: 12) else {
            return Result(succeeded: false, message: "Codex 未能通过原会话深链启动；任务气泡已保留")
        }
        return Result(succeeded: true, message: nil)
    }

    private func strongWakeClaudeDesktop(_ task: TrayTaskItem) -> Result {
        guard let record = claudeDesktopRecord(for: task) else {
            return Result(
                succeeded: false,
                message: "该会话没有可精确定位的 Claude Desktop 原任务；为避免创建副本，请改选 Claude CLI"
            )
        }
        // 冷启动：Claude Desktop 关闭时，仅靠 claude:// 深链可能无法拉起应用本体；
        // 先直接打开 .app 并等它运行，再发深链定位到原会话。
        if !isApplicationRunning(bundleID: "com.anthropic.claudefordesktop") {
            guard let app = claudeDesktopAppURL else {
                return Result(succeeded: false, message: "找不到 Claude Desktop 应用，无法唤起")
            }
            NSWorkspace.shared.open(app)
            guard waitForApplicationRunning(bundleID: "com.anthropic.claudefordesktop", timeout: 12) else {
                return Result(succeeded: false, message: "Claude Desktop 未能启动；任务气泡已保留")
            }
            // 等应用完成启动并注册 URL handler 后再发深链。
            Thread.sleep(forTimeInterval: 1.0)
        }
        var components = URLComponents()
        components.scheme = "claude"
        components.host = "claude.ai"
        components.path = "/epitaxy/\(record.sessionID)"
        guard let url = components.url, NSWorkspace.shared.open(url),
              waitForApplicationRunning(bundleID: "com.anthropic.claudefordesktop", timeout: 8) else {
            return Result(succeeded: false, message: "Claude Desktop 未能打开到原任务；任务气泡已保留")
        }
        return Result(succeeded: true, message: nil)
    }

    private func strongWakeClaudeCLI(_ task: TrayTaskItem) -> Result {
        guard let sessionID = claudeCLISessionID(for: task), !sessionID.isEmpty else {
            return Result(succeeded: false, message: "缺少可用于 Claude CLI 的原会话标识")
        }
        let executables = [
            home.appendingPathComponent(".local/bin/claude").path,
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude"
        ]
        guard let executable = executables.first(where: FileManager.default.isExecutableFile(atPath:)) else {
            return Result(succeeded: false, message: "找不到 Claude CLI 可执行文件")
        }
        return reopenTerminalCommand(
            task: task,
            executable: executable,
            arguments: ["--resume", sessionID],
            identifier: "claude-\(sessionID)",
            workingDirectory: task.workingDirectory,
            processNames: ["claude"],
            sessionID: sessionID
        )
    }

    private func strongWakeDSH(_ task: TrayTaskItem) -> Result {
        guard let sessionID = task.sessionID, !sessionID.isEmpty,
              let url = URL(string: "http://127.0.0.1:3080/") else {
            return Result(succeeded: false, message: "缺少 DSH 会话标识")
        }
        guard NSWorkspace.shared.open(url) else {
            return Result(succeeded: false, message: "无法打开 DSH 页面")
        }
        for _ in 0..<20 {
            Thread.sleep(forTimeInterval: 0.2)
            if focusExistingBrowserPage(
                containing: ["http://127.0.0.1:3080/", "http://localhost:3080/"],
                selectingDSHSession: sessionID
            ) {
                return Result(succeeded: true, message: nil)
            }
        }
        return Result(succeeded: false, message: "DSH 页面已打开，但未确认切换到指定会话")
    }

    private func strongWakeGrok(_ task: TrayTaskItem) -> Result {
        guard let sessionID = task.sessionID, !sessionID.isEmpty else {
            return Result(succeeded: false, message: "缺少 Grok 会话标识")
        }
        let executable = home.appendingPathComponent(".grok/bin/grok").path
        guard FileManager.default.isExecutableFile(atPath: executable) else {
            return Result(succeeded: false, message: "找不到 Grok 可执行文件")
        }
        var arguments: [String] = []
        if let cwd = task.workingDirectory, !cwd.isEmpty { arguments += ["--cwd", cwd] }
        arguments += ["--resume", sessionID]
        return reopenTerminalCommand(
            task: task,
            executable: executable,
            arguments: arguments,
            identifier: "grok-\(sessionID)",
            workingDirectory: task.workingDirectory,
            processNames: ["grok"],
            sessionID: sessionID
        )
    }

    private var claudeDesktopSessionRoots: [URL] {
        [
            home.appendingPathComponent("Library/Application Support/Claude-3p/claude-code-sessions"),
            home.appendingPathComponent("Library/Application Support/Claude/claude-code-sessions")
        ]
    }

    private func claudeDesktopSession(for cliSessionID: String) -> ClaudeDesktopSessionRecord? {
        ClaudeDesktopSessionLookup.originalSession(forCLI: cliSessionID, roots: claudeDesktopSessionRoots)
    }

    private func claudeDesktopRecord(for task: TrayTaskItem) -> ClaudeDesktopSessionRecord? {
        guard let sessionID = task.sessionID, !sessionID.isEmpty else { return nil }
        if sessionID.hasPrefix("local_") {
            return ClaudeDesktopSessionLookup.session(withID: sessionID, roots: claudeDesktopSessionRoots)
        }
        return claudeDesktopSession(for: sessionID)
    }

    private func claudeCLISessionID(for task: TrayTaskItem) -> String? {
        guard let sessionID = task.sessionID, !sessionID.isEmpty else { return nil }
        if sessionID.hasPrefix("local_") {
            return ClaudeDesktopSessionLookup.session(withID: sessionID, roots: claudeDesktopSessionRoots)?.cliSessionID
        }
        return sessionID
    }

    private func isClaudeDesktopTask(_ task: TrayTaskItem) -> Bool {
        let origin = task.launchOrigin
            ?? task.sourcePath.map { ClaudeTranscriptIdentityLookup.read(path: $0).launchOrigin }
            ?? nil
        return origin == "claude-desktop-3p" || (task.sessionID?.hasPrefix("local_") == true)
    }

    private func isClaudeDesktopFocusedSinceBaseline(_ task: TrayTaskItem) -> Bool {
        guard let record = claudeDesktopRecord(for: task) else { return false }
        let key = task.canonicalID
        // 只把「当前焦点会话」视为已查看：应用启动时自动回落到上一个会话，
        // 会短暂顶高那个会话的 lastFocusedAt，但那并非用户主动查看，不能误判。
        guard let mostRecent = ClaudeDesktopSessionLookup.mostRecentlyFocusedSession(roots: claudeDesktopSessionRoots),
              mostRecent.sessionID == record.sessionID else { return false }
        let current = record.lastFocusedAt
        claudeBaselineLock.lock()
        defer { claudeBaselineLock.unlock() }
        if let baseline = claudeDesktopFocusBaseline[key] {
            return current > baseline + 1
        }
        claudeDesktopFocusBaseline[key] = current
        return false
    }

    /// 任务转成「已完成」时重置该会话的焦点基线，避免同一会话再次完成后沿用旧基线被过早判为已查看。
    func clearClaudeFocusBaseline(for canonicalID: String) {
        claudeBaselineLock.lock()
        claudeDesktopFocusBaseline.removeValue(forKey: canonicalID)
        claudeBaselineLock.unlock()
    }

    private func isTerminalTabSelected(_ task: TrayTaskItem) -> Bool {
        guard let tty = task.terminalTTY, !tty.isEmpty else { return false }
        let expected = normalizeTTY(tty)
        if isApplicationActive(bundleID: "com.apple.Terminal"),
           let selected = selectedTerminalTTY() {
            return normalizeTTY(selected) == expected
        }
        if isApplicationActive(bundleID: "com.googlecode.iterm2"),
           let selected = selectediTermTTY() {
            return normalizeTTY(selected) == expected
        }
        return false
    }

    private func selectedTerminalTTY() -> String? {
        let source = """
        if application id "com.apple.Terminal" is running then
            tell application id "com.apple.Terminal"
                try
                    return (tty of selected tab of front window) as text
                end try
            end tell
        end if
        return "MISS"
        """
        let result = runAppleScript(source)
        return result == nil || result == "MISS" ? nil : result
    }

    private func selectediTermTTY() -> String? {
        let source = """
        if application id "com.googlecode.iterm2" is running then
            tell application id "com.googlecode.iterm2"
                try
                    return (tty of current session of current terminal) as text
                end try
            end tell
        end if
        return "MISS"
        """
        let result = runAppleScript(source)
        return result == nil || result == "MISS" ? nil : result
    }

    private func isDSHSessionCurrent(_ task: TrayTaskItem) -> Bool {
        guard let sessionID = task.sessionID, !sessionID.isEmpty else { return false }
        let needles = ["http://127.0.0.1:3080/", "http://localhost:3080/"]
        let source = "JSON.stringify(localStorage.getItem('dsh.sessions.current'))"
        if isApplicationActive(bundleID: "com.apple.Safari"),
           let value = readSafariJavaScript(origins: needles, source: source),
           value.contains(sessionID) {
            return true
        }
        for bundleID in ["com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser"] {
            guard isApplicationActive(bundleID: bundleID),
                  let value = readChromiumJavaScript(bundleID: bundleID, origins: needles, source: source),
                  value.contains(sessionID) else { continue }
            return true
        }
        return false
    }

    private func readChromiumJavaScript(bundleID: String, origins: [String], source: String) -> String? {
        let condition = browserURLCondition(variable: "u", origins: origins)
        let script = """
        if application id \(appleScriptLiteral(bundleID)) is running then
            tell application id \(appleScriptLiteral(bundleID))
                repeat with w in windows
                    try
                        set activeIndex to active tab index of w
                        set u to URL of tab activeIndex of w as text
                        if \(condition) then
                            try
                                return (execute tab activeIndex of w javascript \(appleScriptLiteral(source))) as text
                            end try
                        end if
                    end try
                end repeat
            end tell
        end if
        return "MISS"
        """
        let result = runAppleScript(script)
        return result == nil || result == "MISS" ? nil : result
    }

    private func readSafariJavaScript(origins: [String], source: String) -> String? {
        let condition = browserURLCondition(variable: "u", origins: origins)
        let script = """
        if application id "com.apple.Safari" is running then
            tell application id "com.apple.Safari"
                repeat with w in windows
                    try
                        set u to URL of current tab of w as text
                        if \(condition) then
                            try
                                return (do JavaScript \(appleScriptLiteral(source)) in current tab of w) as text
                            end try
                        end if
                    end try
                end repeat
            end tell
        end if
        return "MISS"
        """
        let result = runAppleScript(script)
        return result == nil || result == "MISS" ? nil : result
    }

    private func isApplicationActive(bundleID: String) -> Bool {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).contains { $0.isActive }
    }

    private func isCodexDesktopThreadFocused(_ task: TrayTaskItem) -> Bool {
        guard let sessionName = task.sessionName.map({ normalizedAXText($0) }), !sessionName.isEmpty else { return false }
        guard let application = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex")
                .first(where: { $0.isActive }) else { return false }
        let root = AXUIElementCreateApplication(application.processIdentifier)
        guard let windows = axValue(root, attribute: kAXWindowsAttribute) as? [AXUIElement] else { return false }
        for window in windows {
            let main = (axValue(window, attribute: kAXMainAttribute) as? NSNumber)?.boolValue == true
            let focused = (axValue(window, attribute: kAXFocusedAttribute) as? NSNumber)?.boolValue == true
            guard main || focused else { continue }
            var visited = 0
            if codexMainHeaderShowsTitle(window, expected: sessionName, inNavigation: false, visited: &visited) {
                return true
            }
        }
        return false
    }

    /// 侧边栏（AXLandmarkNavigation）列出全部线程；主内容区里与「当前线程标题」一致的按钮才是正在查看的会话。
    private func codexMainHeaderShowsTitle(
        _ element: AXUIElement,
        expected: String,
        inNavigation: Bool,
        visited: inout Int
    ) -> Bool {
        guard visited < 12_000 else { return false }
        visited += 1
        let role = axValue(element, attribute: kAXRoleAttribute) as? String
        let insideNavigation = inNavigation || role == "AXLandmarkNavigation"
        if !insideNavigation, role == (kAXButtonRole as String),
           let title = axValue(element, attribute: kAXTitleAttribute) as? String,
           normalizedAXText(title) == expected {
            return true
        }
        guard let children = axValue(element, attribute: kAXChildrenAttribute) as? [AXUIElement] else { return false }
        for child in children where codexMainHeaderShowsTitle(
            child, expected: expected, inNavigation: insideNavigation, visited: &visited) {
            return true
        }
        return false
    }

    private func normalizedAXText(_ value: String) -> String {
        value.unicodeScalars.map { scalar -> String in
            switch scalar.value {
            case 0x00A0, 0x2007, 0x202F: " "
            default: String(scalar)
            }
        }.joined()
        .split(whereSeparator: { $0.isWhitespace })
        .joined(separator: " ")
    }

    private func axValue(_ element: AXUIElement, attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
    }


    private func codexSessionIsKnown(_ task: TrayTaskItem, sessionID: String) -> Bool {
        if let path = task.sourcePath {
            let identity = CodexTranscriptIdentityLookup.read(path: path)
            if identity.sessionID == sessionID { return true }
        }
        return CodexSessionNameLookup.name(for: sessionID, transcriptPath: task.sourcePath, home: home) != nil
    }

    private func isCodexCLI(_ task: TrayTaskItem) -> Bool {
        let origin = task.launchOrigin
            ?? task.sourcePath.map { CodexTranscriptIdentityLookup.read(path: $0).launchOrigin }
            ?? nil
        if origin == "codex-cli" { return true }
        if origin == "codex-desktop" { return false }
        return task.terminalBinding != nil || task.terminalTTY != nil
    }

    private func waitForApplicationRunning(bundleID: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if isApplicationRunning(bundleID: bundleID) { return true }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline
        return false
    }

    private func isApplicationRunning(bundleID: String) -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
    }

    private var codexAppURL: URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex")
    }

    private var claudeDesktopAppURL: URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.anthropic.claudefordesktop")
    }

    private var codexCLIExecutables: [String] {
        [
            home.appendingPathComponent(".local/bin/codex").path,
            home.appendingPathComponent(".npm-global/bin/codex").path,
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex"
        ]
    }

    private var claudeCLIExecutables: [String] {
        [
            home.appendingPathComponent(".local/bin/claude").path,
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude"
        ]
    }

    private var grokExecutable: String {
        home.appendingPathComponent(".grok/bin/grok").path
    }

    private func activateApplication(bundleID: String) -> Bool {
        guard isApplicationRunning(bundleID: bundleID) else { return false }
        forceFrontmostPreservingWindow(bundleID: bundleID)
        return true
    }

    private func terminalProcessRunning(processNames: [String]) -> Bool {
        let rows = processRows().filter { $0.tty != "??" && $0.tty != "?" && !$0.tty.isEmpty }
        for row in rows {
            var identified = row
            if let executable = processExecutablePath(row.pid) { identified.executable = executable }
            if processNames.contains(where: { process(identified, matchesExecutableNamed: $0) }) { return true }
        }
        return false
    }

    private func focusAnyTerminal(processNames: [String]) -> Bool {
        let rows = processRows().filter { $0.tty != "??" && $0.tty != "?" && !$0.tty.isEmpty }
        for row in rows {
            var identified = row
            if let executable = processExecutablePath(row.pid) { identified.executable = executable }
            guard processNames.contains(where: { process(identified, matchesExecutableNamed: $0) }) else { continue }
            guard let binding = TerminalBindingResolver.binding(forAgentProcessID: row.pid),
                  focusTerminal(tty: binding.tty) else { continue }
            return true
        }
        return false
    }

    private func launchTerminalExecutable(_ candidates: [String], identifier: String) -> Bool {
        guard let executable = candidates.first(where: FileManager.default.isExecutableFile(atPath:)) else { return false }
        do {
            try openNewTerminalCommand(shellQuote(executable), identifier: identifier)
            return true
        } catch {
            return false
        }
    }

    private func dshPageIsOpen() -> Bool {
        let needles = ["http://127.0.0.1:3080/", "http://localhost:3080/"]
        let condition = browserURLCondition(variable: "u", origins: needles)
        for bundleID in ["com.google.Chrome", "com.google.Chrome.canary", "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser"] {
            let script = """
            if application id \(appleScriptLiteral(bundleID)) is running then
                tell application id \(appleScriptLiteral(bundleID))
                    repeat with w in windows
                        repeat with t in tabs of w
                            try
                                set u to URL of t as text
                                if \(condition) then return "FOUND"
                            end try
                        end repeat
                    end repeat
                end tell
            end if
            return "MISS"
            """
            if runAppleScript(script) == "FOUND" { return true }
        }
        let safari = """
        if application id "com.apple.Safari" is running then
            tell application id "com.apple.Safari"
                repeat with w in windows
                    repeat with t in tabs of w
                        try
                            set u to URL of t as text
                            if \(condition) then return "FOUND"
                        end try
                    end repeat
                end repeat
            end tell
        end if
        return "MISS"
        """
        return runAppleScript(safari) == "FOUND"
    }

    // MARK: - Existing browser windows

    private func focusExistingBrowserPage(containing needles: [String], selectingDSHSession sessionID: String? = nil) -> Bool {
        let knownBrowsers: [(bundleID: String, kind: BrowserKind)] = [
            ("com.google.Chrome", .chromium),
            ("com.google.Chrome.canary", .chromium),
            ("com.microsoft.edgemac", .chromium),
            ("com.brave.Browser", .chromium),
            ("company.thebrowser.Browser", .chromium),
            ("com.apple.Safari", .safari)
        ]
        let definitions = Dictionary(uniqueKeysWithValues: knownBrowsers.map { ($0.bundleID, $0.kind) })
        var candidates: [(bundleID: String, kind: BrowserKind, windowID: Int64?, windowTitle: String?)] = []
        var seen = Set<String>()

        func appendCandidate(bundleID: String, kind: BrowserKind, windowID: Int64?, windowTitle: String? = nil) {
            let key = "\(bundleID)|\(windowID.map(String.init) ?? "any")"
            guard seen.insert(key).inserted else { return }
            candidates.append((bundleID, kind, windowID, windowTitle))
        }

        if let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            let runningByPID = Dictionary(uniqueKeysWithValues: NSWorkspace.shared.runningApplications.map { ($0.processIdentifier, $0) })
            for window in windows {
                guard (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                      let pidNumber = window[kCGWindowOwnerPID as String] as? NSNumber,
                      let bundleID = runningByPID[pidNumber.int32Value]?.bundleIdentifier,
                      let kind = definitions[bundleID],
                      let windowNumber = window[kCGWindowNumber as String] as? NSNumber else { continue }
                let windowTitle = (window[kCGWindowName as String] as? String).flatMap { $0.isEmpty ? nil : $0 }
                if kind == .chromium, windowTitle == nil {
                    // Chrome-family AppleScript IDs do not equal CGWindow numbers. Without a title,
                    // preserve cross-app recency at the browser-app level and use its own window order.
                    appendCandidate(bundleID: bundleID, kind: kind, windowID: nil)
                } else {
                    appendCandidate(
                        bundleID: bundleID,
                        kind: kind,
                        windowID: windowNumber.int64Value,
                        windowTitle: windowTitle
                    )
                }
            }
        }
        for browser in knownBrowsers {
            appendCandidate(bundleID: browser.bundleID, kind: browser.kind, windowID: nil)
        }

        var attemptedExactBundles = Set<String>()
        for candidate in candidates {
            guard NSRunningApplication.runningApplications(withBundleIdentifier: candidate.bundleID).isEmpty == false else { continue }
            if sessionID != nil, attemptedExactBundles.contains(candidate.bundleID) { continue }
            let source: String
            switch candidate.kind {
            case .chromium:
                source = chromiumFocusScript(
                    bundleID: candidate.bundleID,
                    needles: needles,
                    windowTitle: candidate.windowTitle
                )
            case .safari:
                source = safariFocusScript(needles: needles, windowID: candidate.windowID)
            }
            if runAppleScript(source) == "FOUND" {
                forceFrontmostPreservingWindow(bundleID: candidate.bundleID)
                guard let sessionID else { return true }
                attemptedExactBundles.insert(candidate.bundleID)
                let selectedExactly: Bool
                switch candidate.kind {
                case .chromium:
                    selectedExactly = selectDSHSessionInChromium(
                        bundleID: candidate.bundleID,
                        needles: needles,
                        sessionID: sessionID
                    )
                case .safari:
                    selectedExactly = selectDSHSessionInSafari(needles: needles, sessionID: sessionID)
                }
                if selectedExactly { return true }
            }
        }
        return false
    }

    private func chromiumFocusScript(
        bundleID: String,
        needles: [String],
        windowTitle: String?
    ) -> String {
        let condition = browserURLCondition(variable: "u", origins: needles)
        let windowCondition: String
        if let windowTitle, !windowTitle.isEmpty {
            windowCondition = "(name of w as text) is \(appleScriptLiteral(windowTitle))"
        } else {
            // Chromium CGWindow numbers and AppleScript window IDs are unrelated namespaces.
            windowCondition = "true"
        }
        return """
        if application id \(appleScriptLiteral(bundleID)) is running then
            tell application id \(appleScriptLiteral(bundleID))
                repeat with w in windows
                    if \(windowCondition) then
                        try
                            set activeIndex to active tab index of w
                            set u to URL of tab activeIndex of w as text
                            if \(condition) then
                                set index of w to 1
                                activate
                                return "FOUND"
                            end if
                        end try
                        set tabIndex to 0
                        repeat with t in tabs of w
                            set tabIndex to tabIndex + 1
                            set u to URL of t as text
                            if \(condition) then
                                set active tab index of w to tabIndex
                                set index of w to 1
                                activate
                                return "FOUND"
                            end if
                        end repeat
                    end if
                end repeat
            end tell
        end if
        return "MISS"
        """
    }

    private func safariFocusScript(needles: [String], windowID: Int64?) -> String {
        let condition = browserURLCondition(variable: "u", origins: needles)
        let windowCondition = windowID.map { "(id of w as text) is \(appleScriptLiteral(String($0)))" } ?? "true"
        return """
        if application id "com.apple.Safari" is running then
            tell application id "com.apple.Safari"
                repeat with w in windows
                    if \(windowCondition) then
                        try
                            set u to URL of current tab of w as text
                            if \(condition) then
                                set index of w to 1
                                activate
                                return "FOUND"
                            end if
                        end try
                        set tabIndex to 0
                        repeat with t in tabs of w
                            set tabIndex to tabIndex + 1
                            set u to URL of t as text
                            if \(condition) then
                                set current tab of w to tab tabIndex of w
                                set index of w to 1
                                activate
                                return "FOUND"
                            end if
                        end repeat
                    end if
                end repeat
            end tell
        end if
        return "MISS"
        """
    }

    private func browserURLCondition(variable: String, origins: [String]) -> String {
        origins.map { "\(variable) starts with \(appleScriptLiteral($0))" }.joined(separator: " or ")
    }

    private func selectDSHSessionInChromium(bundleID: String, needles: [String], sessionID: String) -> Bool {
        guard let scripts = dshSelectionJavaScripts(sessionID: sessionID) else { return false }
        guard runChromiumJavaScript(bundleID: bundleID, origins: needles, source: scripts.injection) else { return false }
        Thread.sleep(forTimeInterval: 1.0)
        return consumeChromiumDSHMarker(bundleID: bundleID, origins: needles, marker: scripts.marker)
    }

    private func runChromiumJavaScript(bundleID: String, origins: [String], source: String) -> Bool {
        let condition = browserURLCondition(variable: "u", origins: origins)
        let directSource = """
        if application id \(appleScriptLiteral(bundleID)) is running then
            tell application id \(appleScriptLiteral(bundleID))
                repeat with w in windows
                    try
                        set activeIndex to active tab index of w
                        set u to URL of tab activeIndex of w as text
                        if \(condition) then
                            set index of w to 1
                            activate
                            try
                                execute tab activeIndex of w javascript \(appleScriptLiteral(source))
                                return "INJECTED"
                            end try
                            return "READY"
                        end if
                    end try
                end repeat
            end tell
        end if
        return "MISS"
        """
        let directResult = runAppleScript(directSource)
        if directResult == "INJECTED" { return true }
        guard directResult == "READY" else { return false }

        let accessibilitySource = """
        tell application "System Events"
            try
                set browserProcess to first application process whose bundle identifier is \(appleScriptLiteral(bundleID))
                tell browserProcess
                    set frontmost to true
                    delay 0.18
                    keystroke "l" using command down
                    delay 0.18
                    set addressField to value of attribute "AXFocusedUIElement"
                    if role of addressField is not "AXTextField" then return "MISS"
                    set fieldValue to value of addressField as text
                    if fieldValue is not "127.0.0.1:3080" and fieldValue does not start with "127.0.0.1:3080/" and fieldValue is not "localhost:3080" and fieldValue does not start with "localhost:3080/" and fieldValue does not start with "http://127.0.0.1:3080/" and fieldValue does not start with "http://localhost:3080/" then return "MISS"
                    set value of addressField to \(appleScriptLiteral("javascript:" + source))
                    set focused of addressField to true
                    key code 36
                    return "INJECTED"
                end tell
            on error
                return "MISS"
            end try
        end tell
        """
        return runExternalAppleScript(accessibilitySource) == "INJECTED"
    }

    private func consumeChromiumDSHMarker(bundleID: String, origins: [String], marker: String) -> Bool {
        let originCondition = browserURLCondition(variable: "u", origins: origins)
        let markerCondition = "u contains \(appleScriptLiteral("#" + marker))"
        let cleanupJS = "history.replaceState(null,'',location.pathname+location.search);void(0)"
        let source = """
        if application id \(appleScriptLiteral(bundleID)) is running then
            tell application id \(appleScriptLiteral(bundleID))
                repeat with w in windows
                    set tabIndex to 0
                    repeat with t in tabs of w
                        set tabIndex to tabIndex + 1
                        set u to URL of t as text
                        if (\(originCondition)) and \(markerCondition) then
                            set active tab index of w to tabIndex
                            set index of w to 1
                            activate
                            try
                                execute tab tabIndex of w javascript \(appleScriptLiteral(cleanupJS))
                            end try
                            return "VERIFIED"
                        end if
                    end repeat
                end repeat
            end tell
        end if
        return "MISS"
        """
        return runAppleScript(source) == "VERIFIED"
    }

    private func selectDSHSessionInSafari(needles: [String], sessionID: String) -> Bool {
        guard let scripts = dshSelectionJavaScripts(sessionID: sessionID) else { return false }
        guard runSafariJavaScript(origins: needles, source: scripts.injection) else { return false }
        Thread.sleep(forTimeInterval: 1.0)
        return consumeSafariDSHMarker(origins: needles, marker: scripts.marker)
    }

    private func runSafariJavaScript(origins: [String], source: String) -> Bool {
        let condition = browserURLCondition(variable: "u", origins: origins)
        let appleScript = """
        if application id "com.apple.Safari" is running then
            tell application id "com.apple.Safari"
                repeat with w in windows
                    try
                        set u to URL of current tab of w as text
                        if \(condition) then
                            set index of w to 1
                            activate
                            try
                                do JavaScript \(appleScriptLiteral(source)) in current tab of w
                                return "INJECTED"
                            end try
                            return "READY"
                        end if
                    end try
                end repeat
            end tell
        end if
        return "MISS"
        """
        return runAppleScript(appleScript) == "INJECTED"
    }

    private func consumeSafariDSHMarker(origins: [String], marker: String) -> Bool {
        let originCondition = browserURLCondition(variable: "u", origins: origins)
        let markerCondition = "u contains \(appleScriptLiteral("#" + marker))"
        let cleanupJS = "history.replaceState(null,'',location.pathname+location.search);void(0)"
        let source = """
        tell application id "com.apple.Safari"
            repeat with w in windows
                set tabIndex to 0
                repeat with t in tabs of w
                    set tabIndex to tabIndex + 1
                    set u to URL of t as text
                    if (\(originCondition)) and \(markerCondition) then
                        set current tab of w to tab tabIndex of w
                        set index of w to 1
                        activate
                        try
                            do JavaScript \(appleScriptLiteral(cleanupJS)) in current tab of w
                        end try
                        return "VERIFIED"
                    end if
                end repeat
            end repeat
        end tell
        return "MISS"
        """
        return runAppleScript(source) == "VERIFIED"
    }

    private func dshSelectionJavaScripts(sessionID: String) -> (injection: String, marker: String)? {
        guard let selectionData = try? JSONEncoder().encode(["sessionId": sessionID]),
              let selection = String(data: selectionData, encoding: .utf8),
              let selectionLiteralData = try? JSONEncoder().encode(selection),
              let selectionLiteral = String(data: selectionLiteralData, encoding: .utf8) else { return nil }
        let encodedID = Data(sessionID.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let marker = "allpet-session-\(encodedID)"
        guard let markerData = try? JSONEncoder().encode(marker),
              let markerLiteral = String(data: markerData, encoding: .utf8) else { return nil }
        // 一次性完成：写会话 → 打 hash marker → reload。reload 保留 hash，
        // 重载后 URL 稳定携带 marker，供 consume 定位并用 history.replaceState 清掉，
        // 不再像旧实现那样改写标签 URL（那会再触发一次页面导航/刷新）。
        let injection = "localStorage.setItem('dsh.sessions.current', \(selectionLiteral));location.hash=\(markerLiteral);location.reload();void(0)"
        return (injection, marker)
    }

    // MARK: - Existing terminal windows

    private func focusExistingTerminal(
        for task: TrayTaskItem,
        processNames: [String]
    ) -> TerminalFocusAttempt {
        let rows = processRows().filter { $0.tty != "??" && $0.tty != "?" && !$0.tty.isEmpty }
        let sourcePIDs: Set<Int32>
        if task.platform == .codex || task.platform == .claude,
           let sourcePath = task.sourcePath, !sourcePath.isEmpty {
            sourcePIDs = processIDsHolding(path: sourcePath)
        } else {
            sourcePIDs = []
        }

        var scored: [(row: ProcessRow, score: Int, exact: Bool)] = []
        for row in rows {
            let sourceMatch = sourcePIDs.contains(row.pid)
            let pidMatch = task.processID == row.pid
            let sessionMatch = task.sessionID.map { !$0.isEmpty && row.command.contains($0) } ?? false
            guard pidMatch || sourceMatch || sessionMatch else { continue }

            var identifiedRow = row
            if let executable = processExecutablePath(row.pid) { identifiedRow.executable = executable }
            let nameMatch = processNames.contains { process(identifiedRow, matchesExecutableNamed: $0) }
            // A transcript reader (tail/vim/indexer) is not task ownership.
            guard nameMatch else { continue }

            var cwdMatch = false
            if let cwd = task.workingDirectory, !cwd.isEmpty {
                cwdMatch = row.command.contains(cwd)
                if !cwdMatch { cwdMatch = processWorkingDirectory(row.pid) == cwd }
            }
            let exact = pidMatch || sourceMatch || sessionMatch
            guard exact else { continue }

            var score = nameMatch ? 10 : 0
            if pidMatch { score += 1_000 }
            if sourceMatch { score += 800 }
            if sessionMatch { score += 500 }
            if cwdMatch { score += 100 }
            scored.append((row, score, exact))
        }

        let sorted = scored.sorted {
            $0.score == $1.score ? $0.row.pid > $1.row.pid : $0.score > $1.score
        }
        if let remembered = task.terminalBinding ?? cachedBindingByTask[task.id],
           sorted.contains(where: { normalizeTTY($0.row.tty) == normalizeTTY(remembered.tty) }),
           TerminalBindingResolver.isValid(remembered),
           focusTerminal(tty: remembered.tty) {
            cachedBindingByTask[task.id] = remembered
            return TerminalFocusAttempt(binding: remembered, liveProcessFound: true)
        }
        for candidate in sorted {
            guard let binding = TerminalBindingResolver.binding(forAgentProcessID: candidate.row.pid),
                  focusTerminal(tty: binding.tty) else { continue }
            cachedBindingByTask[task.id] = binding
            return TerminalFocusAttempt(binding: binding, liveProcessFound: true)
        }

        return TerminalFocusAttempt(binding: nil, liveProcessFound: !sorted.isEmpty)
    }

    private func normalizeTTY(_ tty: String) -> String {
        tty.hasPrefix("/dev/") ? tty : "/dev/\(tty)"
    }

    private func focusTerminal(tty: String) -> Bool {
        let terminalScript = terminalFocusScript(tty: tty)
        if runAppleScript(terminalScript) == "FOUND" {
            forceFrontmostPreservingWindow(bundleID: "com.apple.Terminal")
            return true
        }
        let iTermScript = iTermFocusScript(tty: tty)
        if runAppleScript(iTermScript) == "FOUND" {
            forceFrontmostPreservingWindow(bundleID: "com.googlecode.iterm2")
            return true
        }
        return false
    }

    private func terminalFocusScript(tty: String) -> String {
        """
        if application id "com.apple.Terminal" is running then
            tell application id "com.apple.Terminal"
                repeat with w in windows
                    repeat with t in tabs of w
                        try
                            if (tty of t as text) is \(appleScriptLiteral(tty)) then
                                set selected tab of w to t
                                set index of w to 1
                                activate
                                return "FOUND"
                            end if
                        end try
                    end repeat
                end repeat
            end tell
        end if
        return "MISS"
        """
    }

    private func iTermFocusScript(tty: String) -> String {
        """
        if application id "com.googlecode.iterm2" is running then
            tell application id "com.googlecode.iterm2"
                repeat with w in windows
                    repeat with t in tabs of w
                        repeat with s in sessions of t
                            try
                                if (tty of s as text) is \(appleScriptLiteral(tty)) then
                                    select t
                                    select s
                                    set index of w to 1
                                    activate
                                    return "FOUND"
                                end if
                            end try
                        end repeat
                    end repeat
                end repeat
            end tell
        end if
        return "MISS"
        """
    }

    private func processRows() -> [ProcessRow] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-axo", "pid=,tty=,comm=,args="]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return [] }
            return String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { line in
                let parts = line.split(maxSplits: 3, whereSeparator: { $0 == " " || $0 == "\t" })
                guard parts.count == 4, let pid = Int32(parts[0]) else { return nil }
                return ProcessRow(pid: pid, tty: String(parts[1]), executable: String(parts[2]), command: String(parts[3]))
            }
        } catch {
            return []
        }
    }

    private func processIDsHolding(path: String) -> Set<Int32> {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-t", path]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return Set(String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { Int32($0) })
        } catch {
            return []
        }
    }

    private func processExecutablePath(_ pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 4_096)
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        return String(cString: buffer)
    }

    private func processWorkingDirectory(_ pid: Int32) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            return String(decoding: data, as: UTF8.self)
                .split(separator: "\n")
                .first(where: { $0.hasPrefix("n/") })
                .map { String($0.dropFirst()) }
        } catch {
            return nil
        }
    }

    private func process(_ row: ProcessRow, matchesExecutableNamed name: String) -> Bool {
        func base(_ token: Substring) -> String { URL(fileURLWithPath: String(token)).lastPathComponent }
        func matches(_ token: Substring) -> Bool {
            let url = URL(fileURLWithPath: String(token))
            let baseName = url.lastPathComponent
            if baseName == name || url.deletingPathExtension().lastPathComponent == name { return true }
            if name == "claude" && url.pathComponents.contains("claude-code") { return true }
            if name == "claude", url.path.hasPrefix(home.appendingPathComponent(".local/share/claude/versions", isDirectory: true).path + "/") {
                return true
            }
            if name == "grok",
               url.path.hasPrefix(home.appendingPathComponent(".grok/downloads", isDirectory: true).path + "/"),
               baseName.hasPrefix("grok-"), baseName.contains("-macos-") {
                return true
            }
            return false
        }
        let executableToken = Substring(row.executable)
        let executable = base(executableToken)
        if matches(executableToken) { return true }

        var argv = row.command.split(whereSeparator: { $0 == " " || $0 == "\t" })
        if let argv0 = argv.first, matches(argv0), String(argv0).hasPrefix("/") {
            let launchedPath = URL(fileURLWithPath: String(argv0)).standardizedFileURL.resolvingSymlinksInPath().path
            let kernelPath = URL(fileURLWithPath: row.executable).standardizedFileURL.resolvingSymlinksInPath().path
            if launchedPath == kernelPath { return true }
        }
        if argv.first.map(base) == executable { argv.removeFirst() }
        let interpreters = Set(["node", "bun", "deno", "python", "python3", "bash", "sh", "zsh"])
        if interpreters.contains(executable) {
            guard let script = argv.first(where: { !$0.hasPrefix("-") }) else { return false }
            return matches(script)
        }
        if executable == "env" {
            while let first = argv.first, first.contains("=") || first.hasPrefix("-") { argv.removeFirst() }
            guard let launcher = argv.first else { return false }
            argv.removeFirst()
            let launcherName = base(launcher)
            if matches(launcher) { return true }
            if interpreters.contains(launcherName),
               let script = argv.first(where: { !$0.hasPrefix("-") }) {
                return matches(script)
            }
        }
        return false
    }

    private func reopenTerminalCommand(
        task: TrayTaskItem,
        executable: String,
        arguments: [String],
        identifier: String,
        workingDirectory: String?,
        processNames: [String],
        sessionID: String
    ) -> Result {
        let command = ([executable] + arguments).map(shellQuote).joined(separator: " ")
        let directoryPrefix = workingDirectory.flatMap { $0.isEmpty ? nil : "cd \(shellQuote($0)) && " } ?? ""
        let existingTabCommand = directoryPrefix + command
        let newTabCommand = directoryPrefix + "exec " + command
        let existingMatches = matchingTerminalProcesses(processNames: processNames, sessionID: sessionID)
        if !existingMatches.isEmpty {
            for row in existingMatches {
                guard let binding = TerminalBindingResolver.binding(forAgentProcessID: row.pid),
                      focusTerminal(tty: binding.tty) else { continue }
                cachedBindingByTask[task.id] = binding
                return Result(succeeded: true, message: nil, terminalTTY: binding.tty, terminalBinding: binding)
            }
            return Result(succeeded: false, message: "目标会话已重新运行，但无法聚焦其终端；未创建重复任务")
        }
        let previousPIDs = Set(existingMatches.map(\.pid))
        let expectedTTY: String?

        if let binding = task.terminalBinding,
           TerminalBindingResolver.isValid(binding),
           runCommand(existingTabCommand, in: binding) {
            expectedTTY = normalizeTTY(binding.tty)
        } else {
            do {
                try openNewTerminalCommand(newTabCommand, identifier: identifier)
                expectedTTY = nil
            } catch {
                return Result(succeeded: false, message: "无法重新打开任务：\(error.localizedDescription)")
            }
        }

        var stableCounts: [Int32: Int] = [:]
        for _ in 0..<50 {
            Thread.sleep(forTimeInterval: 0.1)
            let matches = matchingTerminalProcesses(
                processNames: processNames,
                sessionID: sessionID,
                requireActiveGrokRegistration: true
            ).filter { candidate in
                !previousPIDs.contains(candidate.pid)
                    && (expectedTTY == nil || normalizeTTY(candidate.tty) == expectedTTY)
            }
            let livePIDs = Set(matches.map(\.pid))
            stableCounts = stableCounts.filter { livePIDs.contains($0.key) }
            for candidate in matches {
                let count = (stableCounts[candidate.pid] ?? 0) + 1
                stableCounts[candidate.pid] = count
                guard count >= 6,
                      let binding = TerminalBindingResolver.binding(forAgentProcessID: candidate.pid) else { continue }
                cachedBindingByTask[task.id] = binding
                return Result(
                    succeeded: true,
                    message: nil,
                    terminalTTY: binding.tty,
                    terminalBinding: binding
                )
            }
        }
        return Result(succeeded: false, message: "已发送打开请求，但未确认目标会话成功启动；任务气泡已保留")
    }

    private func matchingTerminalProcesses(
        processNames: [String],
        sessionID: String,
        requireActiveGrokRegistration: Bool = false
    ) -> [ProcessRow] {
        let rows = processRows()
        let isGrok = processNames.contains("grok")
        let grokPID = isGrok ? activeGrokProcessID(for: sessionID) : nil
        return rows.compactMap { row in
            let hasSessionIdentity = isGrok && requireActiveGrokRegistration
                ? grokPID == row.pid
                : row.command.contains(sessionID) || grokPID == row.pid
            guard row.tty != "??", row.tty != "?", !row.tty.isEmpty, hasSessionIdentity else { return nil }
            var identified = row
            if let executable = processExecutablePath(row.pid) { identified.executable = executable }
            guard processNames.contains(where: { process(identified, matchesExecutableNamed: $0) }) else { return nil }
            return row
        }
    }

    private func activeGrokProcessID(for sessionID: String) -> Int32? {
        let url = home.appendingPathComponent(".grok/active_sessions.json")
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? 0) <= 1_048_576,
              let data = try? Data(contentsOf: url),
              let entries = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
        return entries.first(where: { $0["session_id"] as? String == sessionID })
            .flatMap { ($0["pid"] as? NSNumber)?.int32Value }
    }

    private func runCommand(_ command: String, in binding: TerminalBinding) -> Bool {
        let terminal = """
        if application id "com.apple.Terminal" is running then
            tell application id "com.apple.Terminal"
                repeat with w in windows
                    repeat with t in tabs of w
                        try
                            if (tty of t as text) is \(appleScriptLiteral(binding.tty)) and (busy of t is false) then
                                do script \(appleScriptLiteral(command)) in t
                                set selected tab of w to t
                                set index of w to 1
                                activate
                                return "FOUND"
                            end if
                        end try
                    end repeat
                end repeat
            end tell
        end if
        return "MISS"
        """
        if runAppleScript(terminal) == "FOUND" {
            forceFrontmostPreservingWindow(bundleID: "com.apple.Terminal")
            return true
        }
        let iTerm = """
        if application id "com.googlecode.iterm2" is running then
            tell application id "com.googlecode.iterm2"
                repeat with w in windows
                    repeat with t in tabs of w
                        repeat with s in sessions of t
                            try
                                if (tty of s as text) is \(appleScriptLiteral(binding.tty)) and (is processing of s is false) then
                                    tell s to write text \(appleScriptLiteral(command))
                                    select t
                                    select s
                                    set index of w to 1
                                    activate
                                    return "FOUND"
                                end if
                            end try
                        end repeat
                    end repeat
                end repeat
            end tell
        end if
        return "MISS"
        """
        if runAppleScript(iTerm) == "FOUND" {
            forceFrontmostPreservingWindow(bundleID: "com.googlecode.iterm2")
            return true
        }
        return false
    }

    private func openNewTerminalCommand(_ command: String, identifier: String) throws {
        let directory = home.appendingPathComponent(".config/all-pet/wake", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let safeName = identifier.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "-", options: .regularExpression)
        let scriptURL = directory.appendingPathComponent("\(safeName).command")
        try "#!/bin/zsh\n\(command)\n".write(to: scriptURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: scriptURL.path)
        let terminal = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.open([scriptURL], withApplicationAt: terminal, configuration: configuration)
    }

    // MARK: - Foreground helpers

    private func forceFrontmostPreservingWindow(bundleID: String) {
        let script = "tell application \"System Events\" to set frontmost of (first application process whose bundle identifier is \(appleScriptLiteral(bundleID))) to true"
        let foreground = Process()
        foreground.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        foreground.arguments = ["-e", script]
        foreground.standardOutput = FileHandle.nullDevice
        foreground.standardError = FileHandle.nullDevice
        try? foreground.run()
        foreground.waitUntilExit()
    }

    private func runExternalAppleScript(_ source: String) -> String? {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", source]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }

    private func runAppleScript(_ source: String) -> String? {
        var error: NSDictionary?
        let result = NSAppleScript(source: source)?.executeAndReturnError(&error)
        return error == nil ? result?.stringValue : nil
    }

    private func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }

    private func appleScriptLiteral(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "\"\(escaped)\""
    }


}
#endif
