#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif
import Foundation

struct DSHDecodedTranscript {
    var text: String
    var matchesFingerprint: Bool
}

/// 按路径缓存 DSH zstd 会话，并以有界内存、限频和硬超时流式提取任务上下文。
final class DSHTranscriptDecoder: @unchecked Sendable {
    private struct Command {
        var executable: String
        var prefix: [String]
    }

    private struct CacheEntry {
        var mtime: Date?
        var size: UInt64 = 0
        var cachedAt: Date?
        var lastAttemptAt: Date?
        var decodeDuration: TimeInterval = 0
        var text: String?
    }

    private struct ContextLine {
        var position: Int
        var data: Data
    }

    /// zstd 仍需从头解码，但这里只保留固定大小的尾部、最近用户消息、Turn 和 Todo 行。
    private struct StreamCollector {
        private static let markerSpecs: [(needle: Data, limit: Int)] = [
            (Data("\"type\":\"session/title\"".utf8), 2),
            (Data("\"type\":\"turn/start\"".utf8), 8),
            (Data("\"source\":{\"kind\":\"user\"".utf8), 8),
            (Data("\"type\":\"todo/write\"".utf8), 8)
        ]

        private let maxTailBytes: Int
        private let maxContextLineBytes = 131_072
        private var tail = Data()
        private var partialLine = Data()
        private var droppingLongLine = false
        private var lineNumber = 0
        private var contextLines: [[ContextLine]]

        init(maxTailBytes: Int) {
            self.maxTailBytes = max(1, maxTailBytes)
            self.contextLines = Array(repeating: [], count: Self.markerSpecs.count)
        }

        mutating func consume(_ chunk: Data) {
            tail.append(chunk)
            if tail.count > maxTailBytes * 2 {
                tail = Data(tail.suffix(maxTailBytes))
            }

            var cursor = chunk.startIndex
            while cursor < chunk.endIndex {
                if let newline = chunk[cursor...].firstIndex(of: 0x0A) {
                    append(chunk[cursor..<newline], endsLine: true)
                    cursor = chunk.index(after: newline)
                } else {
                    append(chunk[cursor...], endsLine: false)
                    break
                }
            }
        }

        mutating func result() -> Data {
            if !partialLine.isEmpty, !droppingLongLine {
                record(partialLine)
                partialLine.removeAll(keepingCapacity: true)
            }

            var unique: [Int: Data] = [:]
            for lines in contextLines {
                for line in lines { unique[line.position] = line.data }
            }

            var output = Data()
            for position in unique.keys.sorted() {
                if let line = unique[position] {
                    output.append(line)
                    output.append(0x0A)
                }
            }
            output.append(contentsOf: tail.suffix(maxTailBytes))
            return output
        }

        private mutating func append(_ segment: Data.SubSequence, endsLine: Bool) {
            if !droppingLongLine {
                if partialLine.count + segment.count <= maxContextLineBytes {
                    partialLine.append(contentsOf: segment)
                } else {
                    partialLine.removeAll(keepingCapacity: true)
                    droppingLongLine = true
                }
            }

            guard endsLine else { return }
            if !droppingLongLine { record(partialLine) }
            partialLine.removeAll(keepingCapacity: true)
            droppingLongLine = false
            lineNumber += 1
        }

        private mutating func record(_ line: Data) {
            for index in Self.markerSpecs.indices {
                let spec = Self.markerSpecs[index]
                guard line.range(of: spec.needle) != nil else { continue }
                contextLines[index].append(ContextLine(position: lineNumber, data: line))
                if contextLines[index].count > spec.limit {
                    contextLines[index].removeFirst(contextLines[index].count - spec.limit)
                }
                break
            }
        }
    }

    private final class DrainBox: @unchecked Sendable {
        private let maxTailBytes: Int
        private let lock = NSLock()
        private var collector: StreamCollector?
        private var failed = false

        init(maxTailBytes: Int) {
            self.maxTailBytes = maxTailBytes
        }

        func drain(_ handle: FileHandle) {
            var local = StreamCollector(maxTailBytes: maxTailBytes)
            do {
                while let chunk = try handle.read(upToCount: 65_536), !chunk.isEmpty {
                    local.consume(chunk)
                }
                lock.lock()
                collector = local
                lock.unlock()
            } catch {
                lock.lock()
                failed = true
                lock.unlock()
            }
        }

        func result() -> Data? {
            lock.lock()
            defer { lock.unlock() }
            guard !failed, var collector else { return nil }
            return collector.result()
        }
    }

    private static let drainQueue = DispatchQueue(
        label: "allpet.dsh-zstd-drain",
        qos: .utility,
        attributes: .concurrent
    )

    private let lock = NSLock()
    private let commandOverride: Command?
    private let timeoutOverride: TimeInterval?
    private var cache: [String: CacheEntry] = [:]
    private var lruPaths: [String] = []
    private let maxCacheEntries = 4

    init(
        executableOverride: String? = nil,
        prefixOverride: [String] = [],
        timeoutOverride: TimeInterval? = nil
    ) {
        self.commandOverride = executableOverride.map { Command(executable: $0, prefix: prefixOverride) }
        self.timeoutOverride = timeoutOverride
    }

    func tail(path: String, mtime: Date, size: UInt64, maxBytes: Int = 2_000_000) -> DSHDecodedTranscript? {
        let attemptStartedAt = Date()

        lock.lock()
        var entry = cache[path] ?? CacheEntry()
        let sameFingerprint = entry.mtime == mtime && entry.size == size
        if sameFingerprint, let text = entry.text {
            touchLocked(path)
            lock.unlock()
            return DSHDecodedTranscript(text: text, matchesFingerprint: true)
        }
        let lastWorkAt = [entry.cachedAt, entry.lastAttemptAt].compactMap { $0 }.max()
        let minimumInterval = Self.minimumDecodeInterval(for: size, previousDuration: entry.decodeDuration)
        if let lastWorkAt, attemptStartedAt.timeIntervalSince(lastWorkAt) < minimumInterval {
            let stale = entry.text
            touchLocked(path)
            lock.unlock()
            return stale.map { DSHDecodedTranscript(text: $0, matchesFingerprint: false) }
        }
        entry.lastAttemptAt = attemptStartedAt
        cache[path] = entry
        touchLocked(path)
        lock.unlock()

        guard let command = commandOverride ?? Self.resolveCommand() else {
            return cachedValue(for: path, mtime: mtime, size: size)
        }

        let process = Process()
        let output = Pipe()
        let terminated = DispatchSemaphore(value: 0)
        process.executableURL = URL(fileURLWithPath: command.executable)
        process.arguments = command.prefix + [path]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { _ in terminated.signal() }

        do {
            try process.run()
        } catch {
            return cachedValue(for: path, mtime: mtime, size: size)
        }

        let drain = DrainBox(maxTailBytes: maxBytes)
        let drainGroup = DispatchGroup()
        let handle = output.fileHandleForReading
        drainGroup.enter()
        Self.drainQueue.async {
            drain.drain(handle)
            drainGroup.leave()
        }

        let timeout = timeoutOverride ?? Self.decodeTimeout(for: size)
        guard drainGroup.wait(timeout: .now() + timeout) == .success else {
            Self.stop(process: process, terminated: terminated, handle: handle, drainGroup: drainGroup)
            return cachedValue(for: path, mtime: mtime, size: size)
        }

        guard terminated.wait(timeout: .now() + 1) == .success else {
            Self.stop(process: process, terminated: terminated, handle: handle, drainGroup: drainGroup)
            return cachedValue(for: path, mtime: mtime, size: size)
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              let selectedData = drain.result(),
              !selectedData.isEmpty else {
            return cachedValue(for: path, mtime: mtime, size: size)
        }

        let text = String(decoding: selectedData, as: UTF8.self)
        let completedAt = Date()
        lock.lock()
        entry = cache[path] ?? CacheEntry()
        entry.mtime = mtime
        entry.size = size
        entry.cachedAt = completedAt
        entry.decodeDuration = completedAt.timeIntervalSince(attemptStartedAt)
        entry.text = text
        cache[path] = entry
        touchLocked(path)
        lock.unlock()
        return DSHDecodedTranscript(text: text, matchesFingerprint: true)
    }

    private func cachedValue(for path: String, mtime: Date, size: UInt64) -> DSHDecodedTranscript? {
        lock.lock()
        defer { lock.unlock() }
        guard let entry = cache[path], entry.mtime == mtime, entry.size == size, let text = entry.text else {
            return nil
        }
        touchLocked(path)
        return DSHDecodedTranscript(text: text, matchesFingerprint: true)
    }

    private func touchLocked(_ path: String) {
        lruPaths.removeAll { $0 == path }
        lruPaths.append(path)
        while lruPaths.count > maxCacheEntries {
            let removed = lruPaths.removeFirst()
            cache.removeValue(forKey: removed)
        }
    }

    private static func stop(
        process: Process,
        terminated: DispatchSemaphore,
        handle: FileHandle,
        drainGroup: DispatchGroup
    ) {
        if process.isRunning { process.terminate() }
        if terminated.wait(timeout: .now() + 0.5) == .timedOut, process.isRunning {
            #if os(macOS) || os(Linux)
            kill(process.processIdentifier, SIGKILL)
            #else
            process.terminate()
            #endif
            _ = terminated.wait(timeout: .now() + 1)
        }
        try? handle.close()
        _ = drainGroup.wait(timeout: .now() + 1)
        if !process.isRunning { process.waitUntilExit() }
    }

    private static func minimumDecodeInterval(for size: UInt64, previousDuration: TimeInterval) -> TimeInterval {
        let base: TimeInterval
        switch size {
        case 50_000_000...: base = 15
        case 10_000_000...: base = 8
        default: base = 4
        }
        return min(30, max(base, previousDuration * 4))
    }

    private static func decodeTimeout(for size: UInt64) -> TimeInterval {
        switch size {
        case 50_000_000...: 45
        case 10_000_000...: 25
        default: 12
        }
    }

    private static func resolveCommand() -> Command? {
        let fm = FileManager.default
        let pathDirectories = (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":")
            .map(String.init)
        let extraDirectories = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/homebrew/Caskroom/miniconda/base/bin",
            "/usr/bin"
        ]

        for directory in pathDirectories + extraDirectories {
            let candidate = URL(fileURLWithPath: directory).appendingPathComponent("zstdcat").path
            if fm.isExecutableFile(atPath: candidate) {
                return Command(executable: candidate, prefix: [])
            }
        }
        for directory in pathDirectories + extraDirectories {
            let candidate = URL(fileURLWithPath: directory).appendingPathComponent("zstd").path
            if fm.isExecutableFile(atPath: candidate) {
                return Command(executable: candidate, prefix: ["-dc"])
            }
        }
        return nil
    }
}
