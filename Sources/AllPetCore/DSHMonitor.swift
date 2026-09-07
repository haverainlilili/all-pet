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

        guard let mtime = scan.newestMtime else {
            return PlatformStatus(platform: .dsh, phase: .idle, detail: "未检测到会话", lastActivityAt: nil, activeSessions: 0, enabled: true)
        }

        let age = now.timeIntervalSince(mtime)
        var phase = PhaseClassifier.phase(age: age, config: config, errorDetected: false)
        var task: TaskInfo?
        var detail = phase == .running ? "正在处理 DSH 任务" : phase.label

        if let path = scan.newestPath,
           let transcript = decoder.tail(path: path, mtime: mtime, size: scan.newestSize) {
            let parsed = TaskExtractors.dsh(from: transcript.text)
            var taskInfo = parsed.info
            taskInfo.sessionID = parsed.sessionID ?? Self.sessionID(from: path)
            if let sessionID = taskInfo.sessionID {
                taskInfo.sessionName = DSHSessionNameLookup.name(for: sessionID) ?? taskInfo.sessionName
            }
            taskInfo.sourcePath = path
            taskInfo.workingDirectory = parsed.workingDirectory
            if transcript.matchesFingerprint {
                phase = PhaseClassifier.resolved(inferred: phase, parsed: parsed.phase, age: age, config: config)
                detail = parsed.detail ?? detail
                if phase == .waiting, parsed.phase == .running || parsed.phase == .thinking {
                    detail = "等待后续活动"
                    taskInfo.action = detail
                    taskInfo.toolName = nil
                }
            } else {
                // 文件已经变化而解码仍在防抖窗口：保留标题/进度，但不把旧完成状态套到新活动上。
                detail = phase == .running ? "检测到新的 DSH 活动" : phase.label
                taskInfo.action = detail
                taskInfo.toolName = nil
            }
            task = taskInfo.isEmpty ? nil : taskInfo
        }

        return PlatformStatus(
            platform: .dsh,
            phase: phase,
            detail: detail,
            lastActivityAt: mtime,
            activeSessions: scan.recentCount,
            enabled: true,
            task: task
        )
    }

    static func isTopLevelSessionPath(_ path: String) -> Bool {
        URL(fileURLWithPath: path).deletingLastPathComponent().lastPathComponent.hasPrefix("session-")
    }

    static func sessionID(from path: String) -> String? {
        let name = URL(fileURLWithPath: path).deletingLastPathComponent().lastPathComponent
        return name.isEmpty ? nil : name
    }
}
