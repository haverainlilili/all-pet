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

/// 单个平台的一次活动快照。
public struct PlatformStatus: Sendable {
    public var platform: PlatformKind
    public var phase: AgentPhase
    public var detail: String
    public var lastActivityAt: Date?
    public var activeSessions: Int
    public var enabled: Bool

    public init(
        platform: PlatformKind,
        phase: AgentPhase,
        detail: String,
        lastActivityAt: Date?,
        activeSessions: Int,
        enabled: Bool
    ) {
        self.platform = platform
        self.phase = phase
        self.detail = detail
        self.lastActivityAt = lastActivityAt
        self.activeSessions = activeSessions
        self.enabled = enabled
    }
}
