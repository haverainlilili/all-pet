import Foundation

/// Codex 原生精灵帧描述。
public struct PetAnimationFrame: Sendable, Equatable {
    public var row: Int
    public var column: Int
    public var durationMilliseconds: Int

    public init(row: Int, column: Int, durationMilliseconds: Int) {
        self.row = row
        self.column = column
        self.durationMilliseconds = durationMilliseconds
    }
}

/// Codex 桌宠的九种标准状态；名称、图集行号、帧数与时长取自本机 Codex。
public enum PetAnimation: String, Codable, CaseIterable, Sendable {
    case idle
    case runningRight = "running-right"
    case runningLeft = "running-left"
    case waving
    case jumping
    case failed
    case waiting
    case running
    case review

    public var row: Int {
        switch self {
        case .idle: 0
        case .runningRight: 1
        case .runningLeft: 2
        case .waving: 3
        case .jumping: 4
        case .failed: 5
        case .waiting: 6
        case .running: 7
        case .review: 8
        }
    }

    /// 单轮状态动作。Codex 对非 idle 动作播放三遍，随后回到 idle 循环。
    public var actionFrameDurationsMilliseconds: [Int] {
        switch self {
        case .idle: [1_680, 660, 660, 840, 840, 1_920]
        case .runningRight, .runningLeft: [120, 120, 120, 120, 120, 120, 120, 220]
        case .waving: [140, 140, 140, 280]
        case .jumping: [140, 140, 140, 140, 280]
        case .failed: [140, 140, 140, 140, 140, 140, 140, 240]
        case .waiting: [150, 150, 150, 150, 150, 260]
        case .running: [120, 120, 120, 120, 120, 220]
        case .review: [150, 150, 150, 150, 150, 280]
        }
    }

    public var frameDurationsMilliseconds: [Int] {
        actionFrameDurationsMilliseconds
    }

    public func playback(reduceMotion: Bool = false) -> (frames: [PetAnimationFrame], loopStartIndex: Int?) {
        let action = actionFrameDurationsMilliseconds.enumerated().map {
            PetAnimationFrame(row: row, column: $0.offset, durationMilliseconds: $0.element)
        }
        if reduceMotion { return (Array(action.prefix(1)), nil) }
        if self == .idle { return (action, 0) }

        let idle = PetAnimation.idle.actionFrameDurationsMilliseconds.enumerated().map {
            PetAnimationFrame(row: PetAnimation.idle.row, column: $0.offset, durationMilliseconds: $0.element)
        }
        let repeatedAction = action + action + action
        return (repeatedAction + idle, repeatedAction.count)
    }

    public init?(cliValue: String) {
        if let animation = PetAnimation(rawValue: cliValue) {
            self = animation
            return
        }
        switch cliValue {
        case "runningRight", "right": self = .runningRight
        case "runningLeft", "left": self = .runningLeft
        default: return nil
        }
    }
}
