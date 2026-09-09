import Foundation

/// 各平台日志解析后的任务状态；phase 只在日志明确表达状态时覆盖 mtime 推断。
struct ParsedTask: Sendable {
    var phase: AgentPhase?
    var info = TaskInfo()
    var detail: String?
    var activityAt: Date?
    var sessionID: String?
    var workingDirectory: String?
    var launchOrigin: String?
}

/// 从平台 JSONL 尾部提取「用户任务、当前工具、进度、完成/报错」等可展示信息。
enum TaskExtractors {
    static func codex(from text: String) -> ParsedTask {
        var out = ParsedTask()

        for object in objects(in: text) {
            let topType = object["type"] as? String ?? ""
            let payload = dictionary(object["payload"])

            if topType == "session_meta" {
                out.sessionID = payload["id"] as? String ?? payload["session_id"] as? String ?? out.sessionID
                out.workingDirectory = payload["cwd"] as? String ?? out.workingDirectory
                continue
            }

            if topType == "response_item" {
                let type = payload["type"] as? String ?? ""
                switch type {
                case "message":
                    let role = payload["role"] as? String ?? ""
                    if role == "user", let title = humanPrompt(payload["content"]) {
                        out.info.title = title
                    } else if role == "assistant" {
                        out.phase = .running
                        out.info.action = "正在生成回复"
                    }
                case "custom_tool_call", "function_call", "tool_call":
                    let name = payload["name"] as? String ?? "tool"
                    let args = payload["input"] ?? payload["arguments"]
                    out.phase = .running
                    out.info.toolName = name
                    out.info.action = toolAction(name: name, arguments: args)
                case "reasoning":
                    out.phase = .thinking
                    out.info.action = "正在思考"
                default:
                    break
                }
                continue
            }

            guard topType == "event_msg" else { continue }
            let eventType = payload["type"] as? String ?? ""
            switch eventType {
            case "task_started":
                out.phase = .thinking
                out.info.action = "正在分析任务"
            case "item_started", "item_completed":
                let item = dictionary(payload["item"])
                let itemType = item["type"] as? String ?? ""
                if itemType == "UserMessage", let title = humanPrompt(item["content"]) {
                    out.info.title = title
                } else if itemType.localizedCaseInsensitiveContains("Command") {
                    out.phase = eventType == "item_started" ? .running : .thinking
                    let command = item["command"] ?? item["cmd"]
                    out.info.toolName = "command"
                    out.info.action = eventType == "item_started"
                        ? toolAction(name: "exec_command", arguments: ["command": command as Any])
                        : "正在处理命令结果"
                } else if itemType.localizedCaseInsensitiveContains("Tool") {
                    let name = item["name"] as? String ?? "tool"
                    out.phase = eventType == "item_started" ? .running : .thinking
                    out.info.toolName = name
                    out.info.action = eventType == "item_started"
                        ? toolAction(name: name, arguments: item["arguments"])
                        : "正在处理工具结果"
                } else if itemType == "Reasoning" {
                    out.phase = .thinking
                    out.info.action = "正在思考"
                }
            case "task_complete":
                if let error = nonNull(payload["error"]) {
                    out.phase = .failed
                    out.info.action = "失败：\(errorMessage(error) ?? "任务执行失败")"
                } else {
                    out.phase = .done
                    out.info.action = "任务已完成"
                }
            case "task_failed", "turn_failed", "error":
                out.phase = .failed
                out.info.action = "任务执行失败"
            case "task_cancelled", "turn_aborted":
                out.phase = .waiting
                out.info.action = "任务已中断"
            default:
                break
            }
        }

        out.detail = out.info.action
        return out
    }

    static func claude(from text: String) -> ParsedTask {
        var out = ParsedTask()

        for object in objects(in: text) {
            let topType = object["type"] as? String ?? ""
            out.sessionID = object["sessionId"] as? String ?? object["session_id"] as? String ?? out.sessionID
            out.workingDirectory = object["cwd"] as? String ?? out.workingDirectory
            out.launchOrigin = object["entrypoint"] as? String ?? out.launchOrigin

            if topType == "queue-operation",
               object["operation"] as? String == "enqueue",
               let title = humanPrompt(object["content"]) {
                out.info.title = title
                out.phase = .waiting
                out.info.action = "任务已排队"
                continue
            }

            if topType == "custom-title", let title = compact(object["customTitle"] as? String, max: 90) {
                out.info.sessionName = title
                continue
            }

            guard topType == "assistant" || topType == "user" else { continue }
            let message = dictionary(object["message"])
            let role = message["role"] as? String ?? ""
            let content = message["content"]
            let isAPIError = object["isApiErrorMessage"] as? Bool == true
                || object["isError"] as? Bool == true
                || message["is_error"] as? Bool == true
            if isAPIError {
                out.phase = .failed
                let errorText = contentText(content)
                out.info.action = errorText.map { "失败：\($0)" } ?? "Claude API 调用失败"
                continue
            }

            if role == "user" {
                if let title = humanPrompt(content) {
                    let origin = dictionary(object["origin"])["kind"] as? String
                    if object["isSidechain"] as? Bool != true, origin == nil || origin == "human" {
                        out.info.title = title
                        out.info.action = "正在处理任务"
                        out.info.toolName = nil
                        out.phase = .thinking
                    }
                }

                for item in arrayOfDictionaries(content) where item["type"] as? String == "tool_result" {
                    if item["is_error"] as? Bool == true {
                        out.phase = .failed
                        out.info.action = "工具执行失败"
                    } else {
                        out.phase = .thinking
                        out.info.action = "正在处理工具结果"
                    }
                }
                continue
            }

            guard role == "assistant" else { continue }
            for item in arrayOfDictionaries(content) {
                switch item["type"] as? String ?? "" {
                case "thinking":
                    out.phase = .thinking
                    out.info.action = "正在思考"
                case "tool_use":
                    let name = item["name"] as? String ?? "tool"
                    out.phase = .running
                    out.info.toolName = name
                    out.info.action = toolAction(name: name, arguments: item["input"])
                case "text":
                    out.phase = .running
                    out.info.action = "正在生成回复"
                default:
                    break
                }
            }

            switch message["stop_reason"] as? String {
            case "tool_use":
                out.phase = .running
            case "end_turn", "stop_sequence":
                out.phase = .done
                out.info.action = "任务已完成"
            default:
                break
            }
        }

        out.detail = out.info.action
        return out
    }

    static func dsh(from text: String) -> ParsedTask {
        var out = ParsedTask()
        var lastToolName: String?

        for object in objects(in: text) {
            let type = object["type"] as? String ?? ""
            let data = dictionary(object["data"])
            if type == "session" {
                out.sessionID = object["id"] as? String ?? data["id"] as? String ?? out.sessionID
                out.workingDirectory = object["cwd"] as? String ?? data["cwd"] as? String ?? out.workingDirectory
            }

            switch type {
            case "session/title":
                if let name = compact(data["title"] as? String, max: 90) {
                    out.info.sessionName = name
                }
            case "user/message":
                let source = dictionary(data["source"])
                if source["kind"] as? String == "user", let title = humanPrompt(data["content"]) {
                    out.info.title = title
                }
            case "turn/start":
                out.phase = .thinking
                let sessionName = out.info.sessionName
                let currentTitle = out.info.title
                out.info = TaskInfo(sessionName: sessionName, title: currentTitle, action: "开始处理任务")
                lastToolName = nil
            case "step/start":
                out.phase = .thinking
                out.info.action = "正在思考"
            case "tool/call":
                let name = data["name"] as? String ?? "tool"
                lastToolName = name
                out.phase = .running
                out.info.toolName = name
                out.info.action = toolAction(name: name, arguments: data["arguments"])
            case "tool/result":
                let message = dictionary(data["message"])
                let failed = toolResultFailed(message["content"])
                if failed {
                    out.phase = .failed
                    out.info.action = "\(toolDisplayName(lastToolName ?? "tool"))执行失败"
                } else {
                    out.phase = .thinking
                    out.info.action = "正在处理\(toolDisplayName(lastToolName ?? "tool"))结果"
                }
            case "todo/write":
                let todos = arrayOfDictionaries(data["todos"])
                let completed = todos.filter { $0["status"] as? String == "completed" }.count
                let current = todos.first { $0["status"] as? String == "in_progress" }
                out.info.completedSteps = completed
                out.info.totalSteps = todos.count
                if let content = compact(current?["content"] as? String, max: 100) {
                    out.info.action = content
                }
                out.phase = .running
            case "turn/end":
                let reason = dictionary(data["reason"])
                let kind = reason["kind"] as? String ?? ""
                switch kind {
                case "completed":
                    out.phase = .done
                    out.info.action = "任务已完成"
                case "error", "max-tokens":
                    out.phase = .failed
                    out.info.action = kind == "max-tokens" ? "任务因 token 上限停止" : "任务执行失败"
                case "aborted", "interrupted":
                    out.phase = .waiting
                    out.info.action = "任务已中断"
                case "blocked":
                    out.phase = .waiting
                    out.info.action = "任务被阻塞，等待继续"
                case "":
                    break
                default:
                    out.phase = .waiting
                    out.info.action = "任务结束：\(kind)"
                }
            case "agent/error", "step/error":
                out.phase = .failed
                out.info.action = "任务执行失败"
            case "assistant/chunk":
                let chunk = dictionary(data["chunk"])
                let chunkType = chunk["type"] as? String ?? ""
                let blockType = chunk["blockType"] as? String ?? dictionary(chunk["block"])["type"] as? String ?? ""
                if chunkType == "block-start" || chunkType == "block-end" {
                    if blockType == "reasoning" {
                        out.phase = .thinking
                        out.info.action = "正在思考"
                    } else if blockType == "tool-call" {
                        out.phase = .running
                    } else if blockType == "text" {
                        out.phase = .running
                        out.info.action = "正在生成回复"
                    }
                } else if chunkType == "tool-call-delta", let name = chunk["name"] as? String, !name.isEmpty {
                    lastToolName = name
                    out.phase = .running
                    out.info.toolName = name
                    out.info.action = toolAction(name: name, arguments: nil)
                }
            default:
                break
            }
        }

        out.detail = out.info.action
        return out
    }

    static func grok(
        from text: String,
        projectTitle: String?,
        activeSessionIDs: Set<String> = [],
        relevanceWindow: TimeInterval = 120
    ) -> ParsedTask {
        var states: [String: ParsedTask] = [:]

        for object in objects(in: text) {
            guard let sessionID = object["sid"] as? String,
                  activeSessionIDs.isEmpty || activeSessionIDs.contains(sessionID) else { continue }
            let level = object["lvl"] as? String ?? ""
            let message = object["msg"] as? String ?? ""
            let context = dictionary(object["ctx"])
            var state = states[sessionID] ?? ParsedTask()
            var recognized = false

            // OIDC/auth/daemon 等全局错误没有 sid，不能冒充某个 Grok 任务失败。
            if level == "error" {
                state.phase = .failed
                state.info.action = "Grok 任务出错"
                state.info.toolName = nil
                recognized = true
            } else {
                switch message {
                case "turn.phase_transition":
                    recognized = true
                    switch context["to"] as? String {
                    case "thinking":
                        state.phase = .thinking
                        state.info.action = "正在思考"
                        state.info.toolName = nil
                    case "waiting_model":
                        state.phase = .thinking
                        state.info.action = "正在等待模型"
                        state.info.toolName = nil
                    case "responding":
                        state.phase = .running
                        state.info.action = "正在生成回复"
                        state.info.toolName = nil
                    case "tool", "using_tool", "tool_running":
                        let name = context["tool_name"] as? String ?? context["name"] as? String
                        state.phase = .running
                        state.info.toolName = name
                        state.info.action = name.map { toolAction(name: $0, arguments: context) } ?? "正在调用工具"
                    case "waiting_task_output", "waiting_tool_output":
                        state.phase = .waiting
                        state.info.action = "正在等待工具输出"
                    default:
                        state.phase = .running
                        state.info.action = "任务处理中"
                        state.info.toolName = nil
                    }
                case "shell.handle_prompt.start":
                    recognized = true
                    state.phase = .thinking
                    state.info.action = "正在处理任务"
                    state.info.toolName = nil
                case "shell.handle_prompt.done", "turn.complete":
                    recognized = true
                    state.info.toolName = nil
                    if context["ok"] as? Bool == false {
                        state.phase = .failed
                        state.info.action = "任务执行失败"
                    } else {
                        state.phase = .done
                        state.info.action = "任务已完成"
                    }
                case "agent response complete":
                    recognized = true
                    state.phase = .done
                    state.info.action = "任务已完成"
                    state.info.toolName = nil
                case "shell.tool.exec_start":
                    recognized = true
                    let name = context["tool_name"] as? String ?? context["name"] as? String ?? "tool"
                    state.phase = .running
                    state.info.toolName = name
                    state.info.action = toolAction(name: name, arguments: context)
                case "shell.tool.exec_done":
                    recognized = true
                    let name = context["tool_name"] as? String ?? context["name"] as? String ?? "tool"
                    state.info.toolName = name
                    if context["success"] as? Bool == false || context["ok"] as? Bool == false {
                        state.phase = .failed
                        state.info.action = "\(toolDisplayName(name))执行失败"
                    } else {
                        state.phase = .thinking
                        state.info.action = "正在处理\(toolDisplayName(name))结果"
                    }
                default:
                    if message.localizedCaseInsensitiveContains("tool") {
                        recognized = true
                        state.phase = .running
                        let name = context["tool_name"] as? String ?? context["name"] as? String ?? "tool"
                        state.info.toolName = name
                        state.info.action = toolAction(name: name, arguments: context)
                    }
                }
            }

            if recognized {
                state.sessionID = sessionID
                if let timestamp = parseISO8601(object["ts"] as? String) {
                    state.activityAt = timestamp
                }
                state.detail = state.info.action
                states[sessionID] = state
            }
        }

        let newestActivity = states.values.compactMap(\.activityAt).max()
        let threshold = newestActivity?.addingTimeInterval(-max(0, relevanceWindow))
        // 完成/失败是终态，即使超出 relevanceWindow 也保留；但「最近活跃」的优先级更高。
        func isRecent(_ state: ParsedTask) -> Bool {
            guard let threshold else { return true }
            return state.activityAt.map { $0 >= threshold } ?? false
        }
        let candidates = states.values.filter { state in
            isRecent(state) || state.phase == .done || state.phase == .failed
        }
        func rank(_ state: ParsedTask) -> Int {
            let recent = isRecent(state)
            switch state.phase {
            case .failed: return recent ? 6 : 2
            case .running, .thinking: return recent ? 5 : 1
            case .waiting: return recent ? 4 : 1
            case .done: return recent ? 3 : 2
            case .idle: return recent ? 2 : 1
            case nil: return 0
            }
        }
        var selected = candidates.max { left, right in
            let leftRank = rank(left)
            let rightRank = rank(right)
            if leftRank != rightRank { return leftRank < rightRank }
            let leftDate = left.activityAt ?? .distantPast
            let rightDate = right.activityAt ?? .distantPast
            if leftDate != rightDate { return leftDate < rightDate }
            return (left.sessionID ?? "") < (right.sessionID ?? "")
        } ?? ParsedTask()
        selected.info.sessionName = compact(projectTitle, max: 90)
        return selected
    }

    // MARK: - Shared JSON helpers

    private static func objects(in text: String) -> [[String: Any]] {
        text.split(separator: "\n", omittingEmptySubsequences: true).compactMap { line in
            guard let data = String(line).data(using: .utf8),
                  let value = try? JSONSerialization.jsonObject(with: data),
                  let object = value as? [String: Any] else { return nil }
            return object
        }
    }

    private static func dictionary(_ value: Any?) -> [String: Any] {
        value as? [String: Any] ?? [:]
    }

    private static func arrayOfDictionaries(_ value: Any?) -> [[String: Any]] {
        (value as? [Any] ?? []).compactMap { $0 as? [String: Any] }
    }

    private static func nonNull(_ value: Any?) -> Any? {
        guard let value, !(value is NSNull) else { return nil }
        return value
    }

    private static func contentText(_ value: Any?) -> String? {
        if let string = value as? String { return compact(string, max: 120) }
        if let object = value as? [String: Any] {
            if let text = object["text"] as? String { return compact(text, max: 120) }
            return contentText(object["content"])
        }

        var pieces: [String] = []
        for item in arrayOfDictionaries(value) {
            let type = item["type"] as? String ?? ""
            if ["text", "input_text", "output_text"].contains(type), let text = item["text"] as? String {
                if let value = compact(text, max: 120) { pieces.append(value) }
            }
        }
        return compact(pieces.joined(separator: " "), max: 120)
    }

    private static func humanPrompt(_ value: Any?) -> String? {
        guard let text = contentText(value) else { return nil }
        let lower = text.lowercased()
        let rejectedPrefixes = [
            "<environment_context", "<system-reminder", "<skills_instructions",
            "<in-app-browser-context", "<compacted-summary", "<checkpoint", "<task-notification",
            "current runtime context.", "this is an automatically generated checkpoint",
            "you are an ai", "the approval policy changed",
            "you are repeating the exact same tool call",
            "[your previous response had no visible output"
        ]
        if rejectedPrefixes.contains(where: { lower.hasPrefix($0) }) { return nil }
        if lower.contains("<available_skills>") { return nil }
        return text
    }

    private static func compact(_ value: String?, max: Int) -> String? {
        guard var value else { return nil }
        value = value.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        if value.count > max {
            value = String(value.prefix(max - 1)) + "…"
        }
        return value
    }

    private static func parseISO8601(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }

    private static func errorMessage(_ value: Any) -> String? {
        if let string = value as? String {
            if let data = string.data(using: .utf8),
               let decoded = try? JSONSerialization.jsonObject(with: data) {
                return errorMessage(decoded)
            }
            return compact(string, max: 100)
        }
        let object = dictionary(value)
        if let message = object["message"] { return errorMessage(message) }
        if let nested = object["error"] { return errorMessage(nested) }
        return nil
    }

    private static func toolResultFailed(_ value: Any?) -> Bool {
        for item in arrayOfDictionaries(value) where item["type"] as? String == "tool-result" {
            if item["isError"] as? Bool == true || item["is_error"] as? Bool == true { return true }
        }
        return false
    }

    private static func toolAction(name: String, arguments: Any?) -> String {
        let display = toolDisplayName(name)
        guard let detail = toolArgumentDetail(arguments) else { return display }
        return "\(display)：\(detail)"
    }

    private static func toolArgumentDetail(_ value: Any?) -> String? {
        var object: [String: Any] = [:]
        var rawString: String?
        if let typed = value as? [String: Any] {
            object = typed
        } else if let string = value as? String {
            rawString = string
            if let data = string.data(using: .utf8),
               let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                object = decoded
            }
        }

        for key in ["description", "query", "question", "pattern", "file_path", "path", "url", "command", "cmd"] {
            if let string = object[key] as? String,
               let compacted = compact(string.components(separatedBy: .newlines).first, max: 88) {
                return compacted
            }
        }

        if let rawString, rawString.count < 180 {
            return compact(rawString, max: 88)
        }
        return nil
    }

    private static func toolDisplayName(_ name: String) -> String {
        switch name.lowercased() {
        case "bash", "exec", "exec_command", "shell": "运行命令"
        case "read", "read_file": "读取文件"
        case "write", "write_file": "写入文件"
        case "edit", "apply_patch": "修改文件"
        case "grep", "search": "搜索内容"
        case "glob", "find": "查找文件"
        case "web_search", "web_search_exa": "搜索网络"
        case "web_fetch": "读取网页"
        case "todo_write": "更新任务计划"
        case "skill": "加载技能"
        case "subagent", "subagent_fork": "调用子代理"
        default: "调用 \(name)"
        }
    }
}
