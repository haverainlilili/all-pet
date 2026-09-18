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
            isIncluded: { $0.hasSuffix(".jsonl") && !$0.contains("/subagents/") },
            recentWindow: config.waitingWindowSeconds,
            now: now,
            selectionPriority: { _ in 1 },
            priorityGrace: config.waitingWindowSeconds
        )

        guard scan.newestMtime != nil, !scan.recentCandidates.isEmpty else {
            return PlatformStatus(platform: .claude, phase: .idle, detail: "未检测到会话", lastActivityAt: nil, activeSessions: 0, enabled: true)
        }

        // 解析 recentWindow 内所有会话（多会话并存时每个都识别），按修改时间从新到旧。
        var parsed: [(task: TaskInfo, phase: AgentPhase)] = []
        for candidate in scan.recentCandidates {
            guard let result = parseTask(candidate, now: now, config: config) else { continue }
            // 过滤「自动的小任务」：既无会话名（custom-title / Desktop 标题）也非定时任务的会话，
            // 视为临时/测试指令（如「reply with the single word ok」），不放入气泡。
            if result.task.sessionName == nil, result.task.scheduledTaskName == nil { continue }
            parsed.append(result)
        }
        guard let main = parsed.first else {
            return PlatformStatus(platform: .claude, phase: .idle, detail: "无命名临时会话", lastActivityAt: scan.newestMtime, activeSessions: scan.recentCount, enabled: true)
        }

        let tasks = Array(parsed.map { $0.task }.prefix(5))
        let detail = main.task.action ?? main.phase.label

        return PlatformStatus(
            platform: .claude,
            phase: main.phase,
            detail: detail,
            lastActivityAt: scan.newestMtime,
            activeSessions: scan.recentCount,
            enabled: true,
            task: main.task,
            tasks: tasks
        )
    }

    /// 解析单个活动候选为一个任务及其阶段。
    private func parseTask(_ candidate: ActivityCandidate, now: Date, config: WatchConfig) -> (task: TaskInfo, phase: AgentPhase)? {
        let age = now.timeIntervalSince(candidate.mtime)
        let cached = taskCache.parse(
            path: candidate.path,
            mtime: candidate.mtime,
            size: candidate.size,
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
        taskInfo.sessionID = parsed.sessionID ?? URL(fileURLWithPath: candidate.path).deletingPathExtension().lastPathComponent
        taskInfo.scheduledTaskName = parsed.scheduledTaskName
        taskInfo.sourcePath = candidate.path
        taskInfo.workingDirectory = parsed.workingDirectory
        let identity = ClaudeTranscriptIdentityLookup.read(path: candidate.path)
        taskInfo.launchOrigin = parsed.launchOrigin ?? identity.launchOrigin
        taskInfo.sessionName = parsed.info.sessionName ?? identity.customTitle
        if Self.isDesktopOrigin(taskInfo.launchOrigin),
           let sessionID = taskInfo.sessionID,
           let record = ClaudeDesktopSessionLookup.originalSession(forCLI: sessionID, roots: ClaudeDesktopSessionLookup.defaultRoots()) {
            taskInfo.sessionName = record.title ?? taskInfo.sessionName
        }
        taskInfo.phase = phase
        if phase == .waiting, parsed.phase == .running || parsed.phase == .thinking {
            taskInfo.action = "等待后续活动"
            taskInfo.toolName = nil
        }
        return taskInfo.isEmpty ? nil : (taskInfo, phase)
    }

    private static func isDesktopOrigin(_ value: String?) -> Bool {
        guard let value = value?.lowercased() else { return false }
        return value.contains("desktop") || value.contains("3p") || value.contains("claude.ai")
    }
}
