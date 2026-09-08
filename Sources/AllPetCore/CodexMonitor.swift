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

        guard let mtime = scan.newestMtime, let path = scan.newestPath else {
            return PlatformStatus(platform: .codex, phase: .idle, detail: "未检测到会话", lastActivityAt: nil, activeSessions: 0, enabled: true)
        }

        let age = now.timeIntervalSince(mtime)
        let cached = taskCache.parse(
            path: path,
            mtime: mtime,
            size: scan.newestSize,
            maxBytes: 1_048_576,
            parser: { TaskExtractors.codex(from: $0) }
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
        taskInfo.sessionID = parsed.sessionID ?? Self.sessionID(from: path)
        taskInfo.sourcePath = path
        taskInfo.launchOrigin = CodexTranscriptIdentityLookup.read(path: path).launchOrigin
        if let sessionID = taskInfo.sessionID {
            taskInfo.sessionName = CodexSessionNameLookup.name(for: sessionID, transcriptPath: path)
        }
        taskInfo.workingDirectory = parsed.workingDirectory
        var detail = parsed.detail ?? ActivityScanner.lastJSONStringField("type", in: tail) ?? phase.label
        if phase == .waiting, parsed.phase == .running || parsed.phase == .thinking {
            detail = "等待后续活动"
            taskInfo.action = detail
            taskInfo.toolName = nil
        }
        let task = taskInfo.isEmpty ? nil : taskInfo

        return PlatformStatus(
            platform: .codex,
            phase: phase,
            detail: detail,
            lastActivityAt: mtime,
            activeSessions: scan.recentCount,
            enabled: true,
            task: task
        )
    }

    private static func sessionID(from path: String) -> String? {
        let name = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
        guard name.count >= 36 else { return nil }
        return String(name.suffix(36))
    }
}
