import Foundation

public enum AgentHookEvent {
    public static let supportedPlatforms: [PlatformKind] = [.cursor, .qoder]

    static func phase(event: String, payload: [String: Any]) -> AgentPhase? {
        switch event.lowercased() {
        case "userpromptsubmit", "beforesubmitprompt": return .thinking
        case "pretooluse", "beforeshellexecution", "beforemcpexecution": return .running
        case "posttooluse", "aftershellexecution", "aftermcpexecution", "afterfileedit": return .thinking
        case "permissionrequest", "notification": return .waiting
        case "posttoolusefailure": return .failed
        case "stop":
            let status = payload["status"] as? String ?? "completed"
            return ["error", "aborted"].contains(status) ? .failed : .done
        default: return nil
        }
    }

    /// Observer hook: stores only display metadata, never outputs permission decisions.
    public static func record(platform: PlatformKind, input: Data, home: URL) throws {
        guard supportedPlatforms.contains(platform), input.count <= 1_048_576,
              let payload = try JSONSerialization.jsonObject(with: input) as? [String: Any],
              let event = payload["hook_event_name"] as? String ?? payload["hookEventName"] as? String,
              let phase = phase(event: event, payload: payload),
              let id = payload["conversation_id"] as? String ?? payload["session_id"] as? String ?? payload["sessionId"] as? String,
              !id.isEmpty, id.utf8.count <= 150 else { return }
        if payload["agent_id"] != nil || payload["isSidechain"] as? Bool == true { return }
        let source = payload["transcript_path"] as? String
        if let source {
            let normalizedPath = source.replacingOccurrences(of: "\\", with: "/")
            if normalizedPath.contains("/subagents/") || normalizedPath.contains("/subagent/") { return }
        }
        let name = payload["tool_name"] as? String
        var actualPhase = phase
        if let name, ["askuserquestion", "ask_user_question"].contains(name.lowercased()) { actualPhase = .waiting }
        var output: [String: Any] = ["allpetEventVersion": 1, "platform": platform.rawValue,
            "sessionID": id, "phase": actualPhase.rawValue,
            "action": actualPhase == .done ? "任务已完成" : actualPhase.label]
        if let name { output["toolName"] = name }
        if let source { output["sourcePath"] = source }
        if let cwd = payload["cwd"] as? String ?? (payload["workspace_roots"] as? [String])?.first { output["cwd"] = cwd }
        let key = Data(id.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "=", with: "")
        let directory = home.appendingPathComponent(".config/all-pet/events/\(platform.rawValue)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent("\(key).allpet-event.json")
        let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
        try data.write(to: file, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    public static func install(platform: PlatformKind, executable: String, home: URL) throws -> URL {
        guard supportedPlatforms.contains(platform) else { throw HookError.unsupported }
        let config = home.appendingPathComponent(platform == .cursor ? ".cursor/hooks.json" : ".qoder/settings.json")
        let original = FileManager.default.fileExists(atPath: config.path) ? try Data(contentsOf: config) : nil
        var root: [String: Any] = [:]
        if let original {
            guard let object = try JSONSerialization.jsonObject(with: original) as? [String: Any] else { throw HookError.invalidConfig }
            root = object
        }
        if root["hooks"] != nil && !(root["hooks"] is [String: Any]) { throw HookError.invalidConfig }
        var hooks = root["hooks"] as? [String: Any] ?? [:]
        #if os(Windows)
        guard !executable.contains("\"") else { throw HookError.invalidConfig }
        let command = "\"\(executable)\" hook \(platform.rawValue)"
        #else
        let command = "'\(executable.replacingOccurrences(of: "'", with: "'\\''"))' hook \(platform.rawValue)"
        #endif
        let events = platform == .cursor
            ? ["beforeSubmitPrompt", "preToolUse", "postToolUse", "stop"]
            : ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Stop"]
        for event in events {
            if hooks[event] != nil && !(hooks[event] is [[String: Any]]) { throw HookError.invalidConfig }
            var entries = hooks[event] as? [[String: Any]] ?? []
            // Idempotent at a fixed installation path; preserve all unrelated hooks verbatim.
            let present = entries.contains { item in
                if item["command"] as? String == command { return true }
                return (item["hooks"] as? [[String: Any]])?.contains { $0["command"] as? String == command } == true
            }
            if !present {
                if platform == .cursor { entries.append(["command": command, "timeout": 5]) }
                else { entries.append(["hooks": [["type": "command", "command": command, "timeout": 5]]]) }
            }
            hooks[event] = entries
        }
        root["hooks"] = hooks
        if platform == .cursor { root["version"] = root["version"] ?? 1 }
        try FileManager.default.createDirectory(at: config.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoded = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        if let original, original != encoded {
            try original.write(to: config.appendingPathExtension("allpet-backup-\(UUID().uuidString)"), options: .atomic)
        }
        try encoded.write(to: config, options: .atomic)
        return config
    }

    enum HookError: LocalizedError {
        case unsupported, invalidConfig
        var errorDescription: String? {
            switch self {
            case .unsupported: return "此平台使用原生会话记录，无需事件接入。"
            case .invalidConfig: return "现有平台配置格式无法识别，未修改原配置。"
            }
        }
    }
}
