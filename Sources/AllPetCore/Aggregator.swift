import Foundation

/// 聚合后的整体快照：多个平台的阶段 → 一个宠物动画 + 气泡文案。
public struct PetSnapshot: Sendable {
    public var animation: PetAnimation
    public var phase: AgentPhase
    public var platforms: [PlatformStatus]
    public var summary: String
    public var observedAt: Date

    public init(animation: PetAnimation, phase: AgentPhase, platforms: [PlatformStatus], summary: String, observedAt: Date) {
        self.animation = animation
        self.phase = phase
        self.platforms = platforms
        self.summary = summary
        self.observedAt = observedAt
    }
}

public enum Aggregator {

    public static func snapshot(statuses: [PlatformStatus], now: Date) -> PetSnapshot {
        let phase: AgentPhase
        if statuses.contains(where: { $0.phase == .failed }) {
            phase = .failed
        } else if statuses.contains(where: { $0.phase == .running || $0.phase == .thinking }) {
            phase = .running
        } else if statuses.contains(where: { $0.phase == .waiting }) {
            phase = .waiting
        } else if statuses.contains(where: { $0.phase == .done }) {
            phase = .done
        } else {
            phase = .idle
        }

        let animation: PetAnimation
        switch phase {
        case .failed: animation = .failed
        case .running, .thinking: animation = .running
        case .waiting: animation = .waiting
        case .done: animation = .review
        case .idle: animation = .idle
        }

        return PetSnapshot(
            animation: animation,
            phase: phase,
            platforms: statuses,
            summary: summary(statuses: statuses),
            observedAt: now
        )
    }

    private static func summary(statuses: [PlatformStatus]) -> String {
        let parts = statuses
            .filter { $0.phase != .idle }
            .map { "\($0.platform.label) \($0.phase.label)" }
        if parts.isEmpty { return "全部空闲" }
        return parts.joined(separator: " · ")
    }
}
