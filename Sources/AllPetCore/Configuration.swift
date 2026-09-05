import Foundation

public struct WatchConfig: Codable, Sendable {
    public var pollIntervalMilliseconds: Int
    public var activeWindowSeconds: Double
    public var waitingWindowSeconds: Double

    public init(
        pollIntervalMilliseconds: Int = 1000,
        activeWindowSeconds: Double = 8,
        waitingWindowSeconds: Double = 120
    ) {
        self.pollIntervalMilliseconds = pollIntervalMilliseconds
        self.activeWindowSeconds = activeWindowSeconds
        self.waitingWindowSeconds = waitingWindowSeconds
    }
}

public struct PetDisplayConfig: Codable, Sendable {
    public var enabled: Bool
    public var scale: Double
    public var anchor: String
    public var bundlePath: String?

    public init(enabled: Bool = true, scale: Double = 0.42, anchor: String = "bottom-right", bundlePath: String? = nil) {
        self.enabled = enabled
        self.scale = scale
        self.anchor = anchor
        self.bundlePath = bundlePath
    }
}

public struct PlatformConfig: Codable, Sendable {
    public var enabled: Bool
    public var paths: [String]

    public init(enabled: Bool = true, paths: [String] = []) {
        self.enabled = enabled
        self.paths = paths
    }
}

/// 全局配置，持久化在 `~/.config/all-pet/config.json`。
public struct AllPetConfiguration: Codable, Sendable {
    public var pet: PetDisplayConfig
    public var watch: WatchConfig
    public var platforms: [String: PlatformConfig]

    public init(pet: PetDisplayConfig = .init(), watch: WatchConfig = .init(), platforms: [String: PlatformConfig] = [:]) {
        self.pet = pet
        self.watch = watch
        self.platforms = platforms
    }

    public func platformConfig(for kind: PlatformKind) -> PlatformConfig {
        platforms[kind.rawValue] ?? PlatformConfig()
    }

    public static func defaultPaths(for kind: PlatformKind, home: URL) -> [String] {
        switch kind {
        case .codex: [home.appendingPathComponent(".codex/sessions").path]
        case .claude: [home.appendingPathComponent(".claude/projects").path]
        case .dsh: [home.appendingPathComponent(".dsh/sessions").path]
        case .grok: [
            home.appendingPathComponent(".grok/logs/unified.jsonl").path,
            home.appendingPathComponent(".grok/active_sessions.json").path
        ]
        }
    }

    public static func makeDefault(home: URL) -> AllPetConfiguration {
        var platforms: [String: PlatformConfig] = [:]
        for kind in PlatformKind.allCases {
            platforms[kind.rawValue] = PlatformConfig(enabled: true, paths: defaultPaths(for: kind, home: home))
        }
        return AllPetConfiguration(pet: .init(), watch: .init(), platforms: platforms)
    }

    public static func configURL(home: URL) -> URL {
        home.appendingPathComponent(".config/all-pet/config.json")
    }

    /// 读取配置；文件不存在或损坏时回退到默认值。缺失的平台键用默认路径补齐。
    public static func load(from url: URL, home: URL) -> AllPetConfiguration {
        let defaults = makeDefault(home: home)
        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              var cfg = try? JSONDecoder().decode(AllPetConfiguration.self, from: data)
        else {
            return defaults
        }
        for kind in PlatformKind.allCases {
            if cfg.platforms[kind.rawValue] == nil {
                cfg.platforms[kind.rawValue] = defaults.platforms[kind.rawValue]
            }
        }
        return cfg
    }

    public func save(to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: url, options: .atomic)
    }
}
