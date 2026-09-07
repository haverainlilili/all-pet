import Foundation

/// Claude Code：监控 `~/.claude/projects/**/*.jsonl`，提取提示词、工具调用和结束状态。
public struct ClaudeMonitor: PlatformMonitor {
    public let platform: PlatformKind = .claude
    public let roots: [String]
    private let taskCache: TaskParseCache

    public init(roots: [String]) {
        self.roots = roots.map(PathExpander.expand)
        self.taskCache = TaskParseCache()
    }

    public func snapshot(config: WatchConfig, now: Date) -> PlatformStatus {
        let scan = ActivityScanner.scan(
            roots: roots,
            isIncluded: { $0.hasSuffix(".jsonl") },
            recentWindow: config.waitingWindowSeconds,
            now: now,
            selectionPriority: { $0.contains("/subagents/") ? 0 : 1 },
            priorityGrace: config.waitingWindowSeconds
        )

        guard let mtime = scan.newestMtime, let path = scan.newestPath else {
            return PlatformStatus(platform: .claude, phase: .idle, detail: "未检测到会话", lastActivityAt: nil, activeSessions: 0, enabled: true)
        }

        let age = now.timeIntervalSince(mtime)
        let cached = taskCache.parse(
            path: path,
            mtime: mtime,
            size: scan.newestSize,
            maxBytes: 1_048_576,
            parser: { TaskExtractors.claude(from: $0) }
        )
        let tail = cached.text
        let parsed = cached.task
        var phase = PhaseClassifier.phase(
            age: age,
            config: config,
            errorDetected: ActivityScanner.containsError(tail) && age <= config.activeWindowSeconds
        )
        phase = PhaseClassifier.resolved(inferred: phase, parsed: parsed.phase, age: age, config: config)
        var taskInfo = parsed.info
        taskInfo.sessionID = parsed.sessionID ?? URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
        taskInfo.sourcePath = path
        taskInfo.workingDirectory = parsed.workingDirectory
        let identity = ClaudeTranscriptIdentityLookup.read(path: path)
        taskInfo.launchOrigin = parsed.launchOrigin ?? identity.launchOrigin
        taskInfo.sessionName = parsed.info.sessionName ?? identity.customTitle
        if Self.isDesktopOrigin(taskInfo.launchOrigin),
           let sessionID = taskInfo.sessionID,
           let record = ClaudeDesktopSessionLookup.originalSession(forCLI: sessionID, roots: ClaudeDesktopSessionLookup.defaultRoots()) {
            taskInfo.sessionName = record.title ?? taskInfo.sessionName
        }
        var detail = parsed.detail ?? ActivityScanner.lastJSONStringField("type", in: tail) ?? phase.label
        if phase == .waiting, parsed.phase == .running || parsed.phase == .thinking {
            detail = "等待后续活动"
            taskInfo.action = detail
            taskInfo.toolName = nil
        }
        let task = taskInfo.isEmpty ? nil : taskInfo

        return PlatformStatus(
            platform: .claude,
            phase: phase,
            detail: detail,
            lastActivityAt: mtime,
            activeSessions: scan.recentCount,
            enabled: true,
            task: task
        )
    }

    private static func isDesktopOrigin(_ value: String?) -> Bool {
        guard let value = value?.lowercased() else { return false }
        return value.contains("desktop") || value.contains("3p") || value.contains("claude.ai")
    }
}
