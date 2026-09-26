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

        let record = CodexSessionMetadata.firstRecord(path: path)
        let cacheable = record != nil
        let included = record.map { object in
            guard let payload = object["payload"] as? [String: Any] else { return true }
            return !CodexSessionMetadata.isExcluded(payload: payload)
        } ?? false

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

        // 主任务（最新）决定平台聚合 phase；tasks 携带 recentWindow 内全部任务
        //（含 done/failed 完成卡片），每个任务自身的 phase 已写入 TaskInfo.phase，
        // 这样刚完成的会话在其它会话仍运行时也能作为完成卡片展示，不会漏识别。
        let tasks = Array(parsed.map { $0.task }.prefix(5))
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
        // subagent 会话的文件名形如 <主sessionID>_<subagentID>；应归属到主会话，
        // 因此优先用文件名里的主会话 ID（第一个 UUID），transcript 里的 session_id 仅作回退。
        taskInfo.sessionID = Self.sessionID(from: candidate.path) ?? parsed.sessionID
        taskInfo.sourcePath = candidate.path
        taskInfo.launchOrigin = CodexTranscriptIdentityLookup.read(path: candidate.path).launchOrigin
        if let sessionID = taskInfo.sessionID {
            taskInfo.sessionName = CodexSessionNameLookup.name(for: sessionID, transcriptPath: candidate.path)
        }
        taskInfo.workingDirectory = parsed.workingDirectory
        taskInfo.phase = phase
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

    static func sessionID(from path: String) -> String? {
        let name = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
        // 文件名形如 rollout-<ts>-<主sessionID>[_<subagentID>]；
        // 取第一个 UUID（主会话 ID），忽略 subagent 下划线后缀。
        let uuidPattern = #"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"#
        guard let range = name.range(of: uuidPattern, options: .regularExpression) else { return nil }
        return String(name[range])
    }
}
