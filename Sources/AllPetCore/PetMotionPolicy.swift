import Foundation

/// 降低动态效果时统一冻结任务气泡的 spinner 和平台轮播。
public struct PetMotionPlan: Equatable {
    public let spinsStatus: Bool
    public let rotatesPlatforms: Bool

    public init(spinsStatus: Bool, rotatesPlatforms: Bool) {
        self.spinsStatus = spinsStatus
        self.rotatesPlatforms = rotatesPlatforms
    }
}

public enum PetMotionPolicy {
    public static func plan(
        reduceMotion: Bool,
        stageIsCollapsed: Bool,
        hasActiveTask: Bool,
        unfinishedPlatformCount: Int
    ) -> PetMotionPlan {
        PetMotionPlan(
            spinsStatus: !reduceMotion && hasActiveTask,
            rotatesPlatforms: !reduceMotion && stageIsCollapsed && unfinishedPlatformCount > 1
        )
    }
}
