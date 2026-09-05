import Foundation

/// DeepSeek Harness（DSH）：监控 `~/.dsh/sessions/**/session.jsonl.zstd`。
/// 会话文件为 zstd 压缩二进制，v1 只用 mtime 判断「正在写入 → 运行中」。
public struct DSHMonitor: PlatformMonitor {
    public let platform: PlatformKind = .dsh
    public let roots: [String]

    public init(roots: [String]) {
        self.roots = roots.map(PathExpander.expand)
    }

    public func snapshot(config: WatchConfig, now: Date) -> PlatformStatus {
        let scan = ActivityScanner.scan(
            roots: roots,
            isIncluded: { (($0 as NSString).lastPathComponent) == "session.jsonl.zstd" },
            recentWindow: config.waitingWindowSeconds,
            now: now
        )

        guard let mtime = scan.newestMtime else {
            return PlatformStatus(platform: .dsh, phase: .idle, detail: "未检测到会话", lastActivityAt: nil, activeSessions: 0, enabled: true)
        }

        let phase = PhaseClassifier.phase(age: now.timeIntervalSince(mtime), config: config, errorDetected: false)
        return PlatformStatus(platform: .dsh, phase: phase, detail: phase.label, lastActivityAt: mtime, activeSessions: scan.recentCount, enabled: true)
    }
}
