import Foundation

/// 主线程宠物操作闸门：同一时刻只允许一个 install/import/select/delete/refresh 写入选择状态。
public struct PetOperationGate: Equatable {
    public private(set) var label: String?

    public init() {}

    @discardableResult
    public mutating func begin(_ label: String) -> Bool {
        guard self.label == nil else { return false }
        self.label = label
        return true
    }

    public mutating func finish() {
        label = nil
    }

    public var isBusy: Bool { label != nil }
}
