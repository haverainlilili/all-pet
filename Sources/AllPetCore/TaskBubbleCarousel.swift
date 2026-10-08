/// Keeps platform and task rotation independent of frequently reordered activity snapshots.
public struct TaskBubbleCarousel: Sendable {
    public struct Group: Sendable {
        public var platform: String
        public var taskIDs: [String]
        public init(platform: String, taskIDs: [String]) {
            self.platform = platform
            self.taskIDs = taskIDs
        }
    }

    private var platforms: [String] = []
    private var orders: [String: [String]] = [:]
    private var selected: [String: String] = [:]
    private var frontPlatform: String?

    public init() {}
    public var platformIndex: Int { platforms.firstIndex(of: frontPlatform ?? "") ?? 0 }
    public var taskCount: Int { orders.values.reduce(0) { $0 + $1.count } }
    public func selectedTaskID(for platform: String) -> String? { selected[platform] }

    public mutating func reconcile(_ groups: [Group]) {
        var nextPlatforms: [String] = []
        for group in groups where !group.platform.isEmpty && !nextPlatforms.contains(group.platform) {
            var ids: [String] = []
            for id in group.taskIDs where !id.isEmpty && !ids.contains(id) { ids.append(id) }
            guard !ids.isEmpty else { continue }
            nextPlatforms.append(group.platform)
            // Preserve the current identity and existing cycle order when mtime sorting changes.
            let previous = orders[group.platform] ?? []
            let next = previous.filter { ids.contains($0) } + ids.filter { !previous.contains($0) }
            orders[group.platform] = next
            if !next.contains(selected[group.platform] ?? "") { selected[group.platform] = next.first }
        }
        platforms = nextPlatforms
        orders = orders.filter { platforms.contains($0.key) }
        selected = selected.filter { platforms.contains($0.key) }
        if !platforms.contains(frontPlatform ?? "") { frontPlatform = platforms.first }
    }

    public mutating func advance() {
        guard let frontPlatform, let order = orders[frontPlatform], !order.isEmpty else { return }
        let index = order.firstIndex(of: selected[frontPlatform] ?? "") ?? 0
        selected[frontPlatform] = order[(index + 1) % order.count]
        // Advance a platform's task only after it has actually appeared in front.
        // Advancing every platform on every tick can permanently skip tasks.
        self.frontPlatform = platforms[(platformIndex + 1) % platforms.count]
    }

    public mutating func reset() {
        frontPlatform = platforms.first
        for platform in platforms { selected[platform] = orders[platform]?.first }
    }
}
