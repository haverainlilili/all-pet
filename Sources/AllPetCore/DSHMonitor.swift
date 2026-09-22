import Foundation

/// DeepSeek Harness（DSH）：监控 `~/.dsh/sessions/**/session.jsonl.zstd`。
/// 可用 zstdcat/zstd 时会解析当前任务、工具、Todo 进度与完成/错误状态；否则退回 mtime。
public struct DSHMonitor: PlatformMonitor {
    public let platform: PlatformKind = .dsh
    public let roots: [String]
    private let decoder: DSHTranscriptDecoder
    private let preferredSessionPath: String?

    public init(roots: [String]) {
        self.roots = roots.map(PathExpander.expand)
        self.decoder = DSHTranscriptDecoder()
        self.preferredSessionPath = ProcessInfo.processInfo.environment["DSH_SESSION_JSONL"]
    }

    /// 测试入口：可用纯文本解码器构造多会话夹具，不影响公开 API。
    init(roots: [String], decoder: DSHTranscriptDecoder, preferredSessionPath: String?) {
        self.roots = roots.map(PathExpander.expand)
        self.decoder = decoder
        self.preferredSessionPath = preferredSessionPath
    }

    public func snapshot(config: WatchConfig, now: Date) -> PlatformStatus {
        let scan = ActivityScanner.scan(
            roots: roots,
            isIncluded: { path in
                ((path as NSString).lastPathComponent) == "session.jsonl.zstd"
                    && Self.isTopLevelSessionPath(path)
            },
            recentWindow: config.waitingWindowSeconds,
            now: now,
            selectionPriority: { path in
                if path == preferredSessionPath { return 3 }
                let parent = ((path as NSString).deletingLastPathComponent as NSString).lastPathComponent
                return parent.hasPrefix("session-") ? 2 : 0
            },
            priorityGrace: config.waitingWindowSeconds
        )

        guard let selectedMtime = scan.newestMtime else {
            return PlatformStatus(platform: .dsh, phase: .idle, detail: "未检测到会话", lastActivityAt: nil, activeSessions: 0, enabled: true)
        }

        // 保持 DSH_SESSION_JSONL 的优先选择规则：主任务仍使用扫描器选出的会话；
        // 同时将近期其它顶层会话一并解析，避免 activeSessions 已计数但气泡只显示一项。
        var candidates: [ActivityCandidate] = []
        if let selectedPath = scan.newestPath {
            candidates.append(ActivityCandidate(path: selectedPath, mtime: selectedMtime, size: scan.newestSize))
            candidates.append(contentsOf: scan.recentCandidates.filter { $0.path != selectedPath })
        } else {
            candidates = scan.recentCandidates
        }
        var seenPaths = Set<String>()
        candidates = candidates.filter { seenPaths.insert($0.path).inserted }

        var parsed: [(task: TaskInfo, phase: AgentPhase)] = []
        for candidate in candidates.prefix(5) {
            if let result = parseTask(candidate, now: now, config: config) {
                parsed.append(result)
            }
        }
        guard let main = parsed.first else {
            return PlatformStatus(
                platform: .dsh,
                phase: .idle,
                detail: "未能解析 DSH 会话",
                lastActivityAt: selectedMtime,
                activeSessions: scan.recentCount,
                enabled: true
            )
        }

        let tasks = parsed.map(\.task)
        return PlatformStatus(
            platform: .dsh,
            phase: main.phase,
            detail: main.task.action ?? main.phase.label,
            lastActivityAt: selectedMtime,
            activeSessions: scan.recentCount,
            enabled: true,
            task: main.task,
            tasks: tasks
        )
    }

    /// 解析一个 DSH 顶层会话。每个会话保留自己的 phase，供多任务气泡独立展示。
    private func parseTask(_ candidate: ActivityCandidate, now: Date, config: WatchConfig) -> (task: TaskInfo, phase: AgentPhase)? {
        let age = now.timeIntervalSince(candidate.mtime)
        var phase = PhaseClassifier.phase(age: age, config: config, errorDetected: false)
        guard let transcript = decoder.tail(path: candidate.path, mtime: candidate.mtime, size: candidate.size) else {
            return nil
        }

        let parsed = TaskExtractors.dsh(from: transcript.text)
        var taskInfo = parsed.info
        taskInfo.sessionID = parsed.sessionID ?? Self.sessionID(from: candidate.path)
        if let sessionID = taskInfo.sessionID {
            taskInfo.sessionName = DSHSessionNameLookup.name(for: sessionID) ?? taskInfo.sessionName
        }
        taskInfo.sourcePath = candidate.path
        taskInfo.workingDirectory = parsed.workingDirectory

        if transcript.matchesFingerprint {
            phase = PhaseClassifier.resolved(inferred: phase, parsed: parsed.phase, age: age, config: config)
            if phase == .waiting, parsed.phase == .running || parsed.phase == .thinking {
                taskInfo.action = "等待后续活动"
                taskInfo.toolName = nil
            }
        } else {
            // 文件已变化而解码仍在防抖窗口：不把旧完成状态套到新活动上。
            taskInfo.action = phase == .running ? "检测到新的 DSH 活动" : phase.label
            taskInfo.toolName = nil
        }
        taskInfo.phase = phase
        return taskInfo.isEmpty ? nil : (taskInfo, phase)
    }

    static func isTopLevelSessionPath(_ path: String) -> Bool {
        URL(fileURLWithPath: path).deletingLastPathComponent().lastPathComponent.hasPrefix("session-")
    }

    static func sessionID(from path: String) -> String? {
        let name = URL(fileURLWithPath: path).deletingLastPathComponent().lastPathComponent
        return name.isEmpty ? nil : name
    }
}
