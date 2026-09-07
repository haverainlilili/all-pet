import Foundation

/// 平台监控器协议：每个平台把「最近活动」翻译成统一的 PlatformStatus。
public protocol PlatformMonitor: Sendable {
    var platform: PlatformKind { get }
    func snapshot(config: WatchConfig, now: Date) -> PlatformStatus
}

/// 依据「距最近修改的时长」把活动归类为 running / waiting / idle / failed。
public enum PhaseClassifier {
    public static func phase(age: TimeInterval, config: WatchConfig, errorDetected: Bool) -> AgentPhase {
        if age <= config.activeWindowSeconds {
            return errorDetected ? .failed : .running
        }
        if age <= config.waitingWindowSeconds {
            return .waiting
        }
        return .idle
    }

    /// 活跃日志事件只能覆盖 activeWindow；完成/失败/等待可在 waitingWindow 内保留。
    public static func resolved(
        inferred: AgentPhase,
        parsed: AgentPhase?,
        age: TimeInterval,
        config: WatchConfig
    ) -> AgentPhase {
        guard let parsed else { return inferred }
        switch parsed {
        case .running, .thinking:
            return age <= config.activeWindowSeconds ? parsed : inferred
        case .waiting, .done, .failed:
            return age <= config.waitingWindowSeconds ? parsed : inferred
        case .idle:
            return .idle
        }
    }
}
