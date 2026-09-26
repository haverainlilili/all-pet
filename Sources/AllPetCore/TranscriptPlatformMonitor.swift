import Foundation

/// Native JSONL adapters for Cursor, WorkBuddy, Qoder and pi.
/// Read-only: no platform config, log or conversation is changed by monitoring.
public struct TranscriptPlatformMonitor: PlatformMonitor {
    public let platform: PlatformKind
    public let roots: [String]
    private let cache = TranscriptSnapshotCache()

    public init(platform: PlatformKind, roots: [String]) {
        self.platform = platform
        self.roots = roots.map(PathExpander.expand)
    }

    public func snapshot(config: WatchConfig, now: Date) -> PlatformStatus {
        let scan = ActivityScanner.scan(roots: roots, isIncluded: { path in
            // FileManager can return mixed separators on Windows. Match directories
            // consistently without changing the original path used to read the file.
            let normalizedPath = path.replacingOccurrences(of: "\\", with: "/")
            guard !normalizedPath.contains("/subagents/"), !normalizedPath.contains("/subagent/"),
                  !URL(fileURLWithPath: path).lastPathComponent.hasPrefix("agent-") else { return false }
            if path.hasSuffix(".allpet-event.json") { return true }
            guard path.hasSuffix(".jsonl") || (platform == .cursor && path.hasSuffix(".txt")) else { return false }
            if platform == .cursor { return normalizedPath.contains("/agent-transcripts/") }
            return true
        }, recentWindow: max(120, config.waitingWindowSeconds), now: now)
        var byID: [String: (TaskInfo, Date, Bool)] = [:]
        for candidate in scan.recentCandidates.prefix(40) {
            guard var parsed = cache.read(candidate, platform: platform), !parsed.excluded,
                  parsed.task.phase != nil else { continue }
            let id = parsed.task.sessionID ?? URL(fileURLWithPath: candidate.path).deletingPathExtension().lastPathComponent
            parsed.task.sessionID = id
            parsed.task.sourcePath = parsed.task.sourcePath ?? candidate.path
            parsed.task.launchOrigin = platform == .pi ? "pi-cli" : "\(platform.rawValue)-desktop"
            // An explicit terminal event wins until a later user/tool event arrives.
            let age = now.timeIntervalSince(candidate.mtime)
            if let phase = parsed.task.phase, phase != .done && phase != .failed, age > config.activeWindowSeconds {
                parsed.task.phase = .waiting
                parsed.task.action = "等待后续活动"
            }
            if let newer = byID[id] {
                // Hooks carry exact lifecycle state; native transcripts supply stable names.
                var enriched = newer.0
                enriched.sessionName = enriched.sessionName ?? parsed.task.sessionName
                enriched.workingDirectory = enriched.workingDirectory ?? parsed.task.workingDirectory
                enriched.completedSteps = enriched.completedSteps ?? parsed.task.completedSteps
                enriched.totalSteps = enriched.totalSteps ?? parsed.task.totalSteps
                if newer.2 && !parsed.isHook { enriched.sourcePath = parsed.task.sourcePath }
                byID[id] = (enriched, newer.1, newer.2)
                if parsed.isHook && !newer.2 {
                    parsed.task.sessionName = parsed.task.sessionName ?? newer.0.sessionName
                    parsed.task.workingDirectory = parsed.task.workingDirectory ?? newer.0.workingDirectory
                    parsed.task.completedSteps = newer.0.completedSteps
                    parsed.task.totalSteps = newer.0.totalSteps
                    byID[id] = (parsed.task, candidate.mtime, true)
                }
                continue
            }
            byID[id] = (parsed.task, candidate.mtime, parsed.isHook)
        }
        let ordered = byID.values.sorted { $0.1 > $1.1 }
        let tasks = Array(ordered.prefix(5).map { $0.0 })
        return PlatformStatus(platform: platform, phase: tasks.first?.phase ?? .idle,
            detail: tasks.first?.action ?? "未检测到会话", lastActivityAt: ordered.first?.1,
            activeSessions: ordered.count, enabled: true, tasks: tasks)
    }
}

private final class TranscriptSnapshotCache: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: (Date, UInt64, NativeTranscriptState)] = [:]
    func read(_ file: ActivityCandidate, platform: PlatformKind) -> NativeTranscriptState? {
        lock.lock(); defer { lock.unlock() }
        if let value = values[file.path], value.0 == file.mtime, value.1 == file.size { return value.2 }
        guard let attrs = try? URL(fileURLWithPath: file.path).resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              attrs.isRegularFile == true, attrs.isSymbolicLink != true,
              let handle = FileHandle(forReadingAtPath: file.path) else { return nil }
        defer { try? handle.close() }
        guard let head = try? handle.read(upToCount: 262_144) else { return nil }
        let headText: String
        if file.size > UInt64(head.count), let newline = head.lastIndex(of: 0x0A) {
            headText = String(decoding: head[..<newline], as: UTF8.self)
        } else { headText = String(decoding: head, as: UTF8.self) }
        var parsed = NativeTranscriptParser.parse(headText, platform: platform)
        if file.size > UInt64(head.count) {
            let tail = ActivityScanner.readTail(file.path, maxBytes: 1_048_576)
            parsed = NativeTranscriptParser.parse(tail, platform: platform, initial: parsed)
        }
        if values.count > 128 { values.removeAll(keepingCapacity: true) }
        values[file.path] = (file.mtime, file.size, parsed)
        return parsed
    }
}

struct NativeTranscriptState: Sendable {
    var task = TaskInfo()
    var excluded = false
    var isHook = false
}

enum NativeTranscriptParser {
    static func parse(_ text: String, platform: PlatformKind, initial: NativeTranscriptState = .init()) -> NativeTranscriptState {
        var result = initial
        var sawJSON = false
        func set(_ phase: AgentPhase, _ action: String) {
            result.task.phase = phase; result.task.action = action
            if phase != .running { result.task.toolName = nil }
        }
        func tool(_ name: String, _ input: Any?) {
            result.task.toolName = name
            let waiting = ["askuserquestion", "ask_user_question", "request_user_input", "exitplanmode"].contains(name.lowercased())
            result.task.phase = waiting ? .waiting : .running
            result.task.action = waiting ? "等待你的回复" : TaskExtractors.toolAction(name: name, arguments: input)
            let dict = input as? [String: Any] ?? [:]
            if let todos = (dict["todos"] ?? dict["plan"]) as? [[String: Any]] {
                result.task.totalSteps = todos.count
                result.task.completedSteps = todos.filter { ["completed", "done"].contains($0["status"] as? String ?? "") }.count
            }
        }
        for line in text.split(separator: "\n") {
            guard let data = String(line).data(using: .utf8),
                  let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            sawJSON = true
            let type = row["type"] as? String ?? ""
            if row["isSidechain"] as? Bool == true || row["isSubagent"] as? Bool == true { result.excluded = true; continue }
            if type == "session_meta", let payload = row["payload"] as? [String: Any], CodexSessionMetadata.isExcluded(payload: payload) {
                result.excluded = true; continue
            }
            if row["allpetEventVersion"] as? Int == 1 {
                guard row["platform"] as? String == platform.rawValue, let id = row["sessionID"] as? String,
                      let phase = AgentPhase(rawValue: row["phase"] as? String ?? "") else { continue }
                result.isHook = true
                result.task.sessionID = id; result.task.workingDirectory = row["cwd"] as? String
                result.task.sourcePath = row["sourcePath"] as? String
                result.task.sessionName = compact(row["sessionName"]) ?? result.task.sessionName
                set(phase, row["action"] as? String ?? phase.label)
                result.task.toolName = row["toolName"] as? String
                continue
            }
            result.task.sessionID = row["sessionId"] as? String ?? row["session_id"] as? String ?? row["conversation_id"] as? String ?? result.task.sessionID
            result.task.workingDirectory = row["cwd"] as? String ?? result.task.workingDirectory
            if platform == .pi && type == "session" { result.task.sessionID = row["id"] as? String; continue }
            if type == "ai-title" || type == "custom-title" || type == "session_info" {
                result.task.sessionName = compact(row["aiTitle"] ?? row["customTitle"] ?? row["name"]) ?? result.task.sessionName
                continue
            }
            let meta = row["data"] as? [String: Any] ?? [:]
            if type == "session_meta", let content = meta["content"] as? [String: Any] {
                result.task.sessionName = compact(content["title"] ?? content["name"]) ?? result.task.sessionName
                if content["session_type"] as? String == "subagent" { result.excluded = true }
                continue
            }
            if type == "progress", let event = meta["hookEvent"] as? String, let phase = AgentHookEvent.phase(event: event, payload: meta) {
                set(phase, phase == .done ? "任务已完成" : phase.label); continue
            }
            if type == "reasoning" { set(.thinking, "正在思考"); continue }
            if type == "function_call" { tool(row["name"] as? String ?? "tool", jsonValue(row["arguments"])); continue }
            if type == "function_call_result" {
                let failed = ["failed", "error"].contains(row["status"] as? String ?? "")
                set(failed ? .failed : .thinking, failed ? "工具执行失败" : "正在处理工具结果"); continue
            }
            if type == "error" { set(.failed, "任务执行失败"); continue }
            let message = row["message"] as? [String: Any] ?? row
            let role = message["role"] as? String ?? ""
            let content = message["content"]
            let parts = content as? [[String: Any]] ?? []
            if role == "toolResult" || role == "tool" {
                let failed = message["isError"] as? Bool == true
                set(failed ? .failed : .thinking, failed ? "工具执行失败" : "正在处理工具结果"); continue
            }
            if role == "user" {
                if parts.contains(where: { $0["type"] as? String == "tool_result" }) {
                    let failed = parts.contains { $0["is_error"] as? Bool == true }
                    set(failed ? .failed : .thinking, failed ? "工具执行失败" : "正在处理工具结果")
                } else if row["isMeta"] as? Bool != true {
                    let title = compact(contentText(content))
                    result.task.title = title ?? result.task.title
                    result.task.sessionName = result.task.sessionName ?? title
                    set(.thinking, "正在处理任务")
                }
                continue
            }
            guard role == "assistant" else { continue }
            let previousPhase = result.task.phase
            if parts.isEmpty, content is String { set(.running, "正在生成回复") }
            for part in parts {
                switch part["type"] as? String {
                case "tool_use", "toolCall": tool(part["name"] as? String ?? "tool", part["input"] ?? part["arguments"])
                case "thinking", "reasoning": set(.thinking, "正在思考")
                case "text", "output_text": set(.running, "正在生成回复")
                default: break
                }
            }
            let stop = message["stopReason"] as? String ?? message["stop_reason"] as? String ?? ""
            if ["stop", "end_turn", "stop_sequence"].contains(stop) || (platform == .workbuddy && row["status"] as? String == "completed") {
                set(.done, "任务已完成")
            } else if ["error", "aborted"].contains(stop) || row["isApiErrorMessage"] as? Bool == true {
                set(.failed, stop == "aborted" ? "任务已中断" : "任务执行失败")
            } else if platform == .qoder && previousPhase == .done && !parts.contains(where: { $0["type"] as? String == "tool_use" }) {
                // Qoder writes its final text after the Stop progress record.
                set(.done, "任务已完成")
            }
        }
        // Older Cursor transcript files are plain text; never infer completion from silence.
        if platform == .cursor, !sawJSON {
            for line in text.components(separatedBy: .newlines) {
                if line == "user:" { set(.thinking, "正在处理任务") }
                else if line == "assistant:" { set(.running, "正在生成回复") }
                else if line.hasPrefix("[Tool call]") { tool(String(line.dropFirst(11)).trimmingCharacters(in: .whitespaces), nil) }
                else if line.hasPrefix("[Tool result]") { set(.thinking, "正在处理工具结果") }
            }
        }
        return result
    }
    static func compact(_ input: Any?) -> String? {
        guard let input = input as? String else { return nil }
        let value = input.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : String(value.prefix(90))
    }
    private static func contentText(_ value: Any?) -> String? {
        if let value = value as? String { return value }
        return (value as? [[String: Any]])?.compactMap { $0["text"] as? String }.joined(separator: " ")
    }
    private static func jsonValue(_ value: Any?) -> Any? {
        guard let text = value as? String, let data = text.data(using: .utf8) else { return value }
        return (try? JSONSerialization.jsonObject(with: data)) ?? value
    }
}
