import Foundation

/// 选择宠物时的跨平台纯逻辑：有效配置优先，否则回退到第一个可用候选。
public enum PetSelection {
    public static func preferred<Element>(
        configured: Element?,
        discovered: [Element],
        isValid: (Element) -> Bool
    ) -> Element? {
        if let configured, isValid(configured) { return configured }
        return discovered.first(where: isValid)
    }
}
