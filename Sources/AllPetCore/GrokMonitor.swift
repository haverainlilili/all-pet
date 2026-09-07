import Foundation

/// Grok：监控 `~/.grok/logs/unified.jsonl` 与 `~/.grok/active_sessions.json`。
public struct GrokMonitor: PlatformMonitor {
    private struct ActiveSessionInfo {
        var count: Int
        var sessionIDs: Set<String>
        var titlesBySession: [String: String]
        var cwdBySession: [String: String]
        var pidBySession: [String: Int32]
        var fallbackSessionID: String?
    }

    public let platform: PlatformKind = .grok
    public let logFile: String
    public let activeFile: String
    private let taskCache: TaskParseCache
    private let sessionOriginCache: GrokSessionOriginCache
    private let terminalResolver: GrokTerminalTargetResolver

    public init(paths: [String]) {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let defaults = AllPetConfiguration.defaultPaths(for: .grok, home: home)
        let expanded = paths.map(PathExpander.expand)
        self.logFile = expanded.indices.contains(0) ? expanded[0] : defaults[0]
        self.activeFile = expanded.indices.contains(1) ? expanded[1] : defaults[1]
        self.taskCache = TaskParseCache()
        self.sessionOriginCache = GrokSessionOriginCache()
        self.terminalResolver = GrokTerminalTargetResolver(home: home)
    }

    public func snapshot(config: WatchConfig, now: Date) -> PlatformStatus {
        let fm = FileManager.default
        func fileInfo(_ path: String) -> (mtime: Date, size: UInt64)? {
            guard let attrs = try? fm.attributesOfItem(atPath: path),
                  let mtime = attrs[.modificationDate] as? Date else { return nil }
            let size = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
            return (mtime, size)
        }

        let logInfo = fileInfo(logFile)
        let logMtime = logInfo?.mtime
        let activeMtime = fileInfo(activeFile)?.mtime
        let active = Self.readActiveSessionInfo(activeFile)
        let parsed: ParsedTask
        if let logInfo {
            let variant = active.sessionIDs.sorted().joined(separator: "#") + "|\(config.waitingWindowSeconds)"
            parsed = taskCache.parse(
                path: logFile,
                mtime: logInfo.mtime,
                size: logInfo.size,
                variant: variant,
                maxBytes: 524_288,
                parser: {
                    TaskExtractors.grok(
                        from: $0,
                        projectTitle: nil,
                        activeSessionIDs: active.sessionIDs,
                        relevanceWindow: config.waitingWindowSeconds
                    )
                }
            ).task
        } else {
            parsed = TaskExtractors.grok(
                from: "",
                projectTitle: nil,
                activeSessionIDs: active.sessionIDs,
                relevanceWindow: config.waitingWindowSeconds
            )
        }
        let activeSignalAt = active.count > 0 ? activeMtime : nil

        let activityAt: Date?
        let usesParsedActivity: Bool
        switch (parsed.activityAt, activeSignalAt) {
        case let (parsedAt?, activeAt?):
            activityAt = max(parsedAt, activeAt)
            usesParsedActivity = parsedAt.timeIntervalSince(activeAt) >= -2
        case let (parsedAt?, nil):
            activityAt = parsedAt
            usesParsedActivity = true
        case let (nil, activeAt?):
            activityAt = activeAt
            usesParsedActivity = false
        case (nil, nil):
            activityAt = nil
            usesParsedActivity = false
        }

        let selectedSessionID = usesParsedActivity ? parsed.sessionID : active.fallbackSessionID
        let selectedTitle = selectedSessionID.flatMap { active.titlesBySession[$0] }
        let activeCWD = selectedSessionID.flatMap { active.cwdBySession[$0] }
        let activePID = selectedSessionID.flatMap { active.pidBySession[$0] }
        let origin = selectedSessionID.flatMap { sessionOriginCache.origin(for: $0, inLog: logFile) }
        let terminalTarget = terminalResolver.resolve(originalPID: origin?.processID, activePID: activePID)
        let selectedCWD = origin?.workingDirectory ?? activeCWD
        let selectedPID = terminalTarget?.processID ?? activePID
        guard let activityAt else {
            return PlatformStatus(
                platform: .grok,
                phase: .idle,
                detail: logMtime == nil ? "未检测到日志" : "未检测到任务活动",
                lastActivityAt: logMtime,
                activeSessions: active.count,
                enabled: true,
                task: selectedTitle.map { TaskInfo(sessionName: $0) }
            )
        }

        let age = now.timeIntervalSince(activityAt)
        var phase = PhaseClassifier.phase(age: age, config: config, errorDetected: false)
        var info = parsed.info
        info.sessionName = selectedTitle
        info.sessionID = selectedSessionID
        info.sourcePath = logFile
        info.workingDirectory = selectedCWD
        info.processID = selectedPID
        info.terminalTTY = terminalTarget?.binding.tty
        info.terminalBinding = terminalTarget?.binding
        let detail: String

        if usesParsedActivity {
            phase = PhaseClassifier.resolved(inferred: phase, parsed: parsed.phase, age: age, config: config)
            if phase == .waiting, parsed.phase == .running || parsed.phase == .thinking {
                info.action = "等待后续活动"
                info.toolName = nil
                detail = "等待后续活动"
            } else {
                detail = parsed.detail ?? phase.label
            }
        } else {
            info.action = phase == .running ? "Grok 会话已启动" : nil
            info.toolName = nil
            detail = phase == .running ? "Grok 会话已启动" : phase.label
        }

        return PlatformStatus(
            platform: .grok,
            phase: phase,
            detail: detail,
            lastActivityAt: activityAt,
            activeSessions: active.count,
            enabled: true,
            task: info.isEmpty ? nil : info
        )
    }

    private static func readActiveSessionInfo(_ path: String) -> ActiveSessionInfo {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return ActiveSessionInfo(count: 0, sessionIDs: [], titlesBySession: [:], cwdBySession: [:], pidBySession: [:], fallbackSessionID: nil)
        }

        let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.path
        var sessionIDs = Set<String>()
        var titles: [String: String] = [:]
        var cwdBySession: [String: String] = [:]
        var pidBySession: [String: Int32] = [:]
        var fallbackSessionID: String?
        for item in array {
            guard let sessionID = item["session_id"] as? String else { continue }
            sessionIDs.insert(sessionID)
            fallbackSessionID = sessionID
            if let pid = (item["pid"] as? NSNumber)?.int32Value { pidBySession[sessionID] = pid }
            guard let cwd = item["cwd"] as? String else { continue }
            cwdBySession[sessionID] = cwd
            let normalized = URL(fileURLWithPath: cwd).standardizedFileURL.path
            guard normalized != home else { continue }
            let title = URL(fileURLWithPath: normalized).lastPathComponent
            guard !title.isEmpty else { continue }
            titles[sessionID] = title
        }
        return ActiveSessionInfo(
            count: array.count,
            sessionIDs: sessionIDs,
            titlesBySession: titles,
            cwdBySession: cwdBySession,
            pidBySession: pidBySession,
            fallbackSessionID: fallbackSessionID
        )
    }
}
