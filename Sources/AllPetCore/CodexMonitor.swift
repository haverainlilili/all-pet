import Foundation

private final class CodexSessionClassifier: @unchecked Sendable {
    private let lock = NSLock()
    private var cache: [String: Bool] = [:]

    func belongsToCodex(_ path: String) -> Bool {
        lock.lock()
        if let cached = cache[path] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        var included = false
        var cacheable = false
        if let handle = FileHandle(forReadingAtPath: path) {
            defer { try? handle.close() }
            let data = (try? handle.read(upToCount: 65_536)) ?? nil
            let firstLine = data.flatMap { chunk -> Data? in
                if let newline = chunk.firstIndex(of: 0x0A) { return Data(chunk[..<newline]) }
                return chunk.count < 65_536 ? chunk : nil
            }
            if let firstLine,
               let object = try? JSONSerialization.jsonObject(with: firstLine) as? [String: Any] {
                if let payload = object["payload"] as? [String: Any] {
                    let originator = (payload["originator"] as? String ?? "").lowercased()
                    let threadSource = (payload["thread_source"] as? String ?? "").lowercased()
                    // 排除 DSH 起源，以及 Codex 子代理 rollout（thread_source == "subagent"）。
                    included = !originator.contains("dsh") && !threadSource.contains("dsh") && threadSource != "subagent"
                } else {
                    included = true
                }
                cacheable = true
            }
        }

        if cacheable {
            lock.lock()
            cache[path] = included
            lock.unlock()
        }
        return included
    }
}

/// Codex：监控 `~/.codex/sessions/**/*.jsonl`，并提取用户任务、工具和完成/错误状态。
public struct CodexMonitor: PlatformMonitor {
    public let platform: PlatformKind = .codex
    public let roots: [String]
    private let taskCache: TaskParseCache
    private let sessionClassifier: CodexSessionClassifier

    public init(roots: [String]) {
        self.roots = roots.map(PathExpander.expand)
        self.taskCache = TaskParseCache()
        self.sessionClassifier = CodexSessionClassifier()
    }

    public func snapshot(config: WatchConfig, now: Date) -> PlatformStatus {
        let scan = ActivityScanner.scan(
            roots: roots,
            isIncluded: { path in
                path.hasSuffix(".jsonl") && sessionClassifier.belongsToCodex(path)
            },
            recentWindow: config.waitingWindowSeconds,
            now: now
        )

        guard scan.newestMtime != nil, !scan.recentCandidates.isEmpty else {
            return PlatformStatus(platform: .codex, phase: .idle, detail: "未检测到会话", lastActivityAt: nil, activeSessions: 0, enabled: true)
        }

        // 解析 recentWindow 内所有会话（多会话并存时每个都识别），按修改时间从新到旧。
        var parsed: [(task: TaskInfo, phase: AgentPhase)] = []
        for candidate in scan.recentCandidates {
            if let result = parseTask(candidate, now: now, config: config) {
                parsed.append(result)
            }
        }
        guard let main = parsed.first else {
            return PlatformStatus(platform: .codex, phase: .idle, detail: "未检测到会话", lastActivityAt: nil, activeSessions: scan.recentCount, enabled: true)
        }

        // 主任务（最新）决定平台聚合 phase；主任务在进行中时，把其它进行中的会话一并展开展示。
        let running = parsed.filter { $0.phase == .running || $0.phase == .thinking || $0.phase == .waiting }
        let tasks: [TaskInfo]
        if main.phase == .running || main.phase == .thinking || main.phase == .waiting {
            tasks = running.map { $0.task }
        } else {
            tasks = [main.task]
        }
        let detail = main.task.action ?? main.phase.label

        return PlatformStatus(
            platform: .codex,
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
            parser: { TaskExtractors.codex(from: $0) }
        )
        let parsed = cached.task
        let tail = cached.text
        var phase = PhaseClassifier.phase(
            age: age,
            config: config,
            errorDetected: ActivityScanner.containsError(tail) && age <= config.activeWindowSeconds
        )
        // Codex 的任务状态由「最后事件」决定：parsed 的 running/thinking/waiting 表示
        // 任务进行中 / 等待用户，不因 age 快速降级（8s/120s 会误伤长任务与计划模式）。
        // 仅用 30 分钟硬超时清理崩溃/僵尸 session（无 task_complete 且长期无活动）。
        phase = Self.resolvePhase(parsed: parsed.phase, inferred: phase, age: age)
        var taskInfo = parsed.info
        taskInfo.sessionID = parsed.sessionID ?? Self.sessionID(from: candidate.path)
        taskInfo.sourcePath = candidate.path
        taskInfo.launchOrigin = CodexTranscriptIdentityLookup.read(path: candidate.path).launchOrigin
        if let sessionID = taskInfo.sessionID {
            taskInfo.sessionName = CodexSessionNameLookup.name(for: sessionID, transcriptPath: candidate.path)
        }
        taskInfo.workingDirectory = parsed.workingDirectory
        if phase == .waiting, parsed.phase == .running || parsed.phase == .thinking {
            taskInfo.action = "等待后续活动"
            taskInfo.toolName = nil
        }
        return taskInfo.isEmpty ? nil : (taskInfo, phase)
    }

    /// Codex 阶段解析：running/thinking/waiting 保持到硬超时（长任务、计划模式等待用户
    /// 不应消失）；done/failed 是终态；idle 直接空闲。超出硬超时的进行中任务视为僵尸，清理为 idle。
    private static func resolvePhase(parsed: AgentPhase?, inferred: AgentPhase, age: TimeInterval) -> AgentPhase {
        guard let parsed else { return inferred }
        switch parsed {
        case .running, .thinking, .waiting:
            return age <= hardTimeout ? parsed : .idle
        case .done, .failed:
            return parsed
        case .idle:
            return .idle
        }
    }

    /// 进行中/等待状态的最长保留时长（秒）；超过则判定为已停止的僵尸 session。
    private static let hardTimeout: TimeInterval = 1_800

    private static func sessionID(from path: String) -> String? {
        let name = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
        guard name.count >= 36 else { return nil }
        return String(name.suffix(36))
    }
}
