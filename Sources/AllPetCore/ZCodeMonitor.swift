import Foundation

/// Z Code stores native sessions in SQLite (including CLI and desktop); never mutate it.
public struct ZCodeMonitor: PlatformMonitor {
    public let platform: PlatformKind = .zcode
    public let paths: [String]
    private let reader = ZCodeDatabaseReader()
    public init(paths: [String]) { self.paths = paths.map(PathExpander.expand) }

    public func snapshot(config: WatchConfig, now: Date) -> PlatformStatus {
        var tasks: [(TaskInfo, Date)] = []
        var unavailable = false
        for path in paths where FileManager.default.fileExists(atPath: path) {
            guard let rows = reader.rows(path: path) else { unavailable = true; continue }
            for row in rows {
                guard let id = row["id"] as? String, let milliseconds = row["updated"] as? Double else { continue }
                let date = Date(timeIntervalSince1970: milliseconds / 1000)
                let age = now.timeIntervalSince(date)
                guard age <= max(120, config.waitingWindowSeconds) else { continue }
                let role = row["role"] as? String ?? ""
                let finish = row["finish"] as? String ?? ""
                let part = row["partType"] as? String ?? ""
                let toolStatus = row["toolStatus"] as? String ?? ""
                let name = row["toolName"] as? String
                var phase: AgentPhase = .thinking
                var action = "正在处理任务"
                if row["hasError"] as? Int == 1 {
                    phase = .failed; action = "任务执行失败"
                } else if role == "assistant", ["stop", "end_turn", "length"].contains(finish) {
                    phase = .done; action = "任务已完成"
                } else if part == "tool" && ["pending", "running"].contains(toolStatus) {
                    phase = .running; action = TaskExtractors.toolAction(name: name ?? "tool", arguments: nil)
                    if ["askuserquestion", "ask_user_question"].contains(name?.lowercased() ?? "") {
                        phase = .waiting; action = "等待你的回复"
                    }
                } else if part == "tool" && toolStatus == "error" {
                    phase = .failed; action = "工具执行失败"
                } else if part == "reasoning" { action = "正在思考" }
                else if role == "assistant" { phase = .running; action = "正在生成回复" }
                if phase != .done && phase != .failed && age > config.activeWindowSeconds {
                    phase = .waiting; action = "等待后续活动"
                }
                let task = TaskInfo(sessionName: NativeTranscriptParser.compact(row["title"]), action: action,
                    toolName: name, completedSteps: row["completedSteps"] as? Int, totalSteps: row["totalSteps"] as? Int,
                    sessionID: id, sourcePath: path, workingDirectory: row["directory"] as? String,
                    launchOrigin: "zcode", phase: phase)
                tasks.append((task, date))
            }
        }
        tasks.sort { $0.1 > $1.1 }
        var seen = Set<String>()
        let visible = tasks.filter { seen.insert($0.0.sessionID ?? "").inserted }
        return PlatformStatus(platform: .zcode, phase: visible.first?.0.phase ?? .idle,
            detail: visible.first?.0.action ?? (unavailable ? "无法读取 Z Code 会话数据库" : "未检测到会话"),
            lastActivityAt: visible.first?.1, activeSessions: visible.count, enabled: true,
            tasks: Array(visible.prefix(5).map { $0.0 }))
    }
}

private final class ZCodeDatabaseReader: @unchecked Sendable {
    private let lock = NSLock()
    private var cached: [String: (String, [[String: Any]])] = [:]
    func rows(path: String) -> [[String: Any]]? {
        lock.lock(); defer { lock.unlock() }
        guard let values = try? URL(fileURLWithPath: path).resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true, values.isSymbolicLink != true else { return nil }
        let fingerprint = [path, path + "-wal"].map { file -> String in
            let attrs = (try? FileManager.default.attributesOfItem(atPath: file)) ?? [:]
            return "\((attrs[.modificationDate] as? Date ?? .distantPast).timeIntervalSince1970):\(attrs[.size] ?? 0)"
        }.joined(separator: "|")
        if let value = cached[path], value.0 == fingerprint { return value.1 }
        guard let data = read(path: path),
              let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
        cached[path] = (fingerprint, rows)
        return rows
    }

    private func read(path: String) -> Data? {
        let process = Process(), output = Pipe()
        let environment = ProcessInfo.processInfo.environment
        if let executable = environment["ALLPET_SQLITE_EXECUTABLE"],
           let script = environment["ALLPET_SQLITE_SCRIPT"] {
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = [script, path, Self.query]
            var env = environment; env["ELECTRON_RUN_AS_NODE"] = "1"; process.environment = env
        } else {
            let candidates = ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3"]
            guard let executable = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { return nil }
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = ["-readonly", "-json", "-cmd", ".timeout 1000", path, Self.query]
        }
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 3, execute: timeout)
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit(); timeout.cancel()
            guard process.terminationStatus == 0, data.count <= 1_048_576 else { return nil }
            return data.isEmpty ? Data("[]".utf8) : data
        } catch { return nil }
    }

    // Read only summary metadata from bounded recent top-level tasks, not transcript contents.
    static let query = """
    SELECT s.id, substr(s.title,1,90) title, s.directory,
      max(s.time_updated, coalesce(m.time_updated,0), coalesce(p.time_updated,0)) updated,
      json_extract(m.data,'$.role') role, json_extract(m.data,'$.finish') finish,
      CASE WHEN json_type(m.data,'$.error') IS NOT NULL AND json_type(m.data,'$.error') != 'null' THEN 1 ELSE 0 END hasError,
      json_extract(p.data,'$.type') partType, json_extract(p.data,'$.tool') toolName,
      json_extract(p.data,'$.state.status') toolStatus,
      (SELECT count(*) FROM todo t WHERE t.session_id=s.id) totalSteps,
      (SELECT count(*) FROM todo t WHERE t.session_id=s.id AND t.status='completed') completedSteps
    FROM session s
    LEFT JOIN message m ON m.id=(SELECT id FROM message WHERE session_id=s.id ORDER BY sequence IS NULL DESC, sequence DESC, time_created DESC, rowid DESC LIMIT 1)
    LEFT JOIN part p ON p.id=(SELECT id FROM part WHERE message_id=m.id ORDER BY sequence IS NULL DESC, sequence DESC, time_created DESC, id DESC LIMIT 1)
    WHERE s.time_archived IS NULL AND s.task_type IN ('interactive','fork','selection_side_chat','workflow_parent')
    ORDER BY s.time_updated DESC LIMIT 20;
    """
}
