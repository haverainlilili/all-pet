import Darwin
import Foundation

/// A terminal tab binding that remains valid after its agent child exits, while its login shell survives.
public struct TerminalBinding: Codable, Sendable, Equatable {
    public var tty: String
    public var anchorProcessID: Int32
    public var anchorStartedAtMicroseconds: UInt64

    public init(tty: String, anchorProcessID: Int32, anchorStartedAtMicroseconds: UInt64) {
        self.tty = tty.hasPrefix("/dev/") ? tty : "/dev/\(tty)"
        self.anchorProcessID = anchorProcessID
        self.anchorStartedAtMicroseconds = anchorStartedAtMicroseconds
    }
}

public enum TerminalBindingResolver {
    public static func binding(forAgentProcessID processID: Int32) -> TerminalBinding? {
        guard let agentTTY = tty(for: processID) else { return nil }
        var anchorPID = processID
        var cursor = processID
        var seen = Set<Int32>()
        for _ in 0..<12 where seen.insert(cursor).inserted {
            guard let info = processInfo(cursor) else { break }
            let parent = Int32(info.pbi_ppid)
            guard parent > 1, parent != cursor,
                  processInfo(parent) != nil,
                  tty(for: parent) == agentTTY else { break }
            anchorPID = parent
            cursor = parent
        }
        guard let anchor = processInfo(anchorPID) else { return nil }
        return TerminalBinding(
            tty: agentTTY,
            anchorProcessID: anchorPID,
            anchorStartedAtMicroseconds: startToken(anchor)
        )
    }

    public static func isValid(_ binding: TerminalBinding) -> Bool {
        guard let info = processInfo(binding.anchorProcessID),
              startToken(info) == binding.anchorStartedAtMicroseconds,
              tty(for: binding.anchorProcessID) == normalized(binding.tty) else { return false }
        return true
    }

    private static func processInfo(_ pid: Int32) -> proc_bsdinfo? {
        var info = proc_bsdinfo()
        let size = MemoryLayout<proc_bsdinfo>.size
        let result = withUnsafeMutablePointer(to: &info) {
            proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, $0, Int32(size))
        }
        return result == Int32(size) ? info : nil
    }

    private static func startToken(_ info: proc_bsdinfo) -> UInt64 {
        UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec)
    }

    private static func tty(for pid: Int32) -> String? {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-p", String(pid), "-o", "tty="]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let value = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, value != "?", value != "??" else { return nil }
            return normalized(value)
        } catch {
            return nil
        }
    }

    private static func normalized(_ tty: String) -> String {
        tty.hasPrefix("/dev/") ? tty : "/dev/\(tty)"
    }
}
