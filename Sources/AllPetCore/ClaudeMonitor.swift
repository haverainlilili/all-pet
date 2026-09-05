import Foundation

/// Claude Code：监控 `~/.claude/projects/**/*.jsonl`（对话转录逐行追加）。
public struct ClaudeMonitor: PlatformMonitor {
    public let platform: PlatformKind = .claude
    public let roots: [String]

    public init(roots: [String]) {
        self.roots = roots.map(PathExpander.expand)
    }

    public func snapshot(config: WatchConfig, now: Date) -> PlatformStatus {
        let scan = ActivityScanner.scan(
            roots: roots,
            isIncluded: { $0.hasSuffix(".jsonl") },
            recentWindow: config.waitingWindowSeconds,
            now: now
        )

        guard let mtime = scan.newestMtime else {
            return PlatformStatus(platform: .claude, phase: .idle, detail: "未检测到会话", lastActivityAt: nil, activeSessions: 0, enabled: true)
        }

        let tail = scan.newestPath.map { ActivityScanner.readTail($0) } ?? ""
        let errorDetected = ActivityScanner.containsError(tail)
        let phase = PhaseClassifier.phase(age: now.timeIntervalSince(mtime), config: config, errorDetected: errorDetected)
        let detail = ActivityScanner.lastJSONStringField("type", in: tail) ?? phase.label

        return PlatformStatus(platform: .claude, phase: phase, detail: detail, lastActivityAt: mtime, activeSessions: scan.recentCount, enabled: true)
    }
}
