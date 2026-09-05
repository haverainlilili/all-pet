import Foundation

/// Grok：监控 `~/.grok/logs/unified.jsonl`（NDJSON 追加）与 `~/.grok/active_sessions.json`。
public struct GrokMonitor: PlatformMonitor {
    public let platform: PlatformKind = .grok
    public let logFile: String
    public let activeFile: String

    public init(paths: [String]) {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let defaults = AllPetConfiguration.defaultPaths(for: .grok, home: home)
        let expanded = paths.map(PathExpander.expand)
        self.logFile = expanded.indices.contains(0) ? expanded[0] : defaults[0]
        self.activeFile = expanded.indices.contains(1) ? expanded[1] : defaults[1]
    }

    public func snapshot(config: WatchConfig, now: Date) -> PlatformStatus {
        let fm = FileManager.default
        func mtime(_ path: String) -> Date? {
            guard let attrs = try? fm.attributesOfItem(atPath: path) else { return nil }
            return attrs[.modificationDate] as? Date
        }

        let logMtime = mtime(logFile)
        let activeMtime = mtime(activeFile)
        let activeCount = Self.readActiveSessionCount(activeFile)

        // 最近活动 = 日志与 active_sessions 两个信号中较新的那个，
        // 避免「过期残留会话」被误判为运行中。
        var newest = logMtime
        if let a = activeMtime, newest == nil || a > newest! {
            newest = a
        }

        guard let mtime = newest else {
            let phase: AgentPhase = activeCount > 0 ? .running : .idle
            return PlatformStatus(platform: .grok, phase: phase, detail: activeCount > 0 ? "有活跃会话" : "未检测到日志", lastActivityAt: nil, activeSessions: activeCount, enabled: true)
        }

        let tail = ActivityScanner.readTail(logFile)
        let errorDetected = ActivityScanner.containsError(tail)
        let phase = PhaseClassifier.phase(age: now.timeIntervalSince(mtime), config: config, errorDetected: errorDetected)
        let detail = ActivityScanner.lastJSONStringField("msg", in: tail) ?? phase.label

        return PlatformStatus(platform: .grok, phase: phase, detail: detail, lastActivityAt: mtime, activeSessions: activeCount, enabled: true)
    }

    private static func readActiveSessionCount(_ path: String) -> Int {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let array = try? JSONSerialization.jsonObject(with: data) as? [Any]
        else {
            return 0
        }
        return array.count
    }
}
