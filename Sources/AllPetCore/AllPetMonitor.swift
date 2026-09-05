import Foundation

/// 多平台监控协调器：按配置装配各平台监控器，产出整体快照。
public struct AllPetMonitor {
    public let configuration: AllPetConfiguration
    private let monitors: [PlatformKind: any PlatformMonitor]

    public init(configuration: AllPetConfiguration, home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.configuration = configuration
        var built: [PlatformKind: any PlatformMonitor] = [:]

        for kind in PlatformKind.allCases {
            let pc = configuration.platformConfig(for: kind)
            let paths = (pc.paths.isEmpty
                ? AllPetConfiguration.defaultPaths(for: kind, home: home)
                : pc.paths).map(PathExpander.expand)

            switch kind {
            case .codex: built[kind] = CodexMonitor(roots: paths)
            case .claude: built[kind] = ClaudeMonitor(roots: paths)
            case .dsh: built[kind] = DSHMonitor(roots: paths)
            case .grok: built[kind] = GrokMonitor(paths: paths)
            }
        }
        self.monitors = built
    }

    public func snapshot(now: Date = Date()) -> PetSnapshot {
        var statuses: [PlatformStatus] = []
        for kind in PlatformKind.allCases {
            guard configuration.platformConfig(for: kind).enabled, let monitor = monitors[kind] else { continue }
            statuses.append(monitor.snapshot(config: configuration.watch, now: now))
        }
        return Aggregator.snapshot(statuses: statuses, now: now)
    }
}
