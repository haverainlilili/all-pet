#if canImport(Darwin)
import Darwin
#endif
import Foundation

struct GrokTerminalTarget: Sendable, Equatable {
    var processID: Int32
    var binding: TerminalBinding
}

#if os(macOS)
final class GrokTerminalTargetResolver: @unchecked Sendable {
    private let home: URL
    private let lock = NSLock()
    private var bindingByPID: [Int32: TerminalBinding] = [:]

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.home = home.standardizedFileURL.resolvingSymlinksInPath()
    }

    func resolve(originalPID: Int32?, activePID: Int32?) -> GrokTerminalTarget? {
        var seen = Set<Int32>()
        for pid in [originalPID, activePID].compactMap({ $0 }) where seen.insert(pid).inserted {
            guard isGrokProcess(pid) else { continue }
            lock.lock()
            let cached = bindingByPID[pid]
            lock.unlock()
            if let cached, TerminalBindingResolver.isValid(cached) {
                return GrokTerminalTarget(processID: pid, binding: cached)
            }
            guard let binding = TerminalBindingResolver.binding(forAgentProcessID: pid) else { continue }
            lock.lock()
            bindingByPID[pid] = binding
            lock.unlock()
            return GrokTerminalTarget(processID: pid, binding: binding)
        }
        return nil
    }

    private func isGrokProcess(_ pid: Int32) -> Bool {
        var buffer = [CChar](repeating: 0, count: 4_096)
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return false }
        let executable = URL(fileURLWithPath: String(cString: buffer)).standardizedFileURL.resolvingSymlinksInPath()
        return Self.isRecognizedExecutable(executable, home: home)
    }

    static func isRecognizedExecutable(_ executable: URL, home: URL) -> Bool {
        let executable = executable.standardizedFileURL.resolvingSymlinksInPath()
        let home = home.standardizedFileURL.resolvingSymlinksInPath()
        if executable.lastPathComponent == "grok" { return true }
        let downloads = home.appendingPathComponent(".grok/downloads", isDirectory: true).path + "/"
        let name = executable.lastPathComponent
        return executable.path.hasPrefix(downloads)
            && name.hasPrefix("grok-")
            && name.contains("-macos-")
    }
}
#else
final class GrokTerminalTargetResolver: @unchecked Sendable {
    init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {}
    func resolve(originalPID: Int32?, activePID: Int32?) -> GrokTerminalTarget? { nil }
}
#endif
