import Foundation

/// 路径展开：把 `~` / `~/...` 展开为绝对路径。
public enum PathExpander {
    public static func expand(_ path: String) -> String {
        if path == "~" {
            return FileManager.default.homeDirectoryForCurrentUser.path
        }
        if path.hasPrefix("~/") {
            return FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(String(path.dropFirst(2))).path
        }
        return path
    }
}

/// 平台枚举。
public enum PlatformKind: String, Codable, CaseIterable, Sendable {
    case codex
    case claude
    case dsh
    case grok

    public var label: String {
        switch self {
        case .codex: "Codex"
        case .claude: "Claude Code"
        case .dsh: "DSH"
        case .grok: "Grok"
        }
    }
}

/// 单个平台的运行阶段。
public enum AgentPhase: String, Codable, Sendable {
    case idle
    case running
    case thinking
    case waiting
    case done
    case failed

    public var label: String {
        switch self {
        case .idle: "空闲"
        case .running: "运行中"
        case .thinking: "思考中"
        case .waiting: "等待中"
        case .done: "完成"
        case .failed: "出错"
        }
    }
}

/// 宠物气泡里展示的当前任务上下文。
public struct TaskInfo: Sendable, Equatable {
    /// 平台自身的稳定会话名称；气泡只展示此字段，不展示当前轮任务标题。
    public var sessionName: String?
    public var title: String?
    public var action: String?
    public var toolName: String?
    public var completedSteps: Int?
    public var totalSteps: Int?
    /// 精确唤起原平台任务所需的会话与来源信息。
    public var sessionID: String?
    public var sourcePath: String?
    public var workingDirectory: String?
    public var processID: Int32?
    public var terminalTTY: String?
    public var terminalBinding: TerminalBinding?
    public var launchOrigin: String?

    public init(
        sessionName: String? = nil,
        title: String? = nil,
        action: String? = nil,
        toolName: String? = nil,
        completedSteps: Int? = nil,
        totalSteps: Int? = nil,
        sessionID: String? = nil,
        sourcePath: String? = nil,
        workingDirectory: String? = nil,
        processID: Int32? = nil,
        terminalTTY: String? = nil,
        terminalBinding: TerminalBinding? = nil,
        launchOrigin: String? = nil
    ) {
        self.sessionName = sessionName
        self.title = title
        self.action = action
        self.toolName = toolName
        self.completedSteps = completedSteps
        self.totalSteps = totalSteps
        self.sessionID = sessionID
        self.sourcePath = sourcePath
        self.workingDirectory = workingDirectory
        self.processID = processID
        self.terminalTTY = terminalTTY
        self.terminalBinding = terminalBinding
        self.launchOrigin = launchOrigin
    }

    public var progressLabel: String? {
        guard let completedSteps, let totalSteps, totalSteps > 0 else { return nil }
        return "进度 \(completedSteps)/\(totalSteps)"
    }

    public var isEmpty: Bool {
        sessionName == nil && title == nil && action == nil && toolName == nil && totalSteps == nil && sessionID == nil
    }
}

/// 单个平台的一次活动快照。
public struct PlatformStatus: Sendable {
    public var platform: PlatformKind
    public var phase: AgentPhase
    public var detail: String
    public var lastActivityAt: Date?
    public var activeSessions: Int
    public var enabled: Bool
    public var task: TaskInfo?

    public init(
        platform: PlatformKind,
        phase: AgentPhase,
        detail: String,
        lastActivityAt: Date?,
        activeSessions: Int,
        enabled: Bool,
        task: TaskInfo? = nil
    ) {
        self.platform = platform
        self.phase = phase
        self.detail = detail
        self.lastActivityAt = lastActivityAt
        self.activeSessions = activeSessions
        self.enabled = enabled
        self.task = task
    }

    public var bubbleHeader: String {
        "\(platform.label) · \(phase.label)"
    }

    /// 气泡正文（最多两行）：当前动作优先，其次任务标题。
    public var bubbleDetails: [String] {
        var lines: [String] = []
        if let action = task?.action, !action.isEmpty {
            let value = task?.progressLabel.map { "\($0) · \(action)" } ?? action
            lines.append(value)
        } else if detail != phase.label, !detail.isEmpty, detail != "未检测到会话" {
            lines.append(detail)
        }

        if let name = task?.sessionName, !name.isEmpty {
            let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            let duplicatesPrimaryLine = lines.contains { line in
                let normalizedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
                return normalizedLine == normalizedName || normalizedLine.hasSuffix(" · \(normalizedName)")
            }
            if !duplicatesPrimaryLine { lines.append("会话：\(name)") }
        }
        return Array(lines.prefix(2))
    }
}
