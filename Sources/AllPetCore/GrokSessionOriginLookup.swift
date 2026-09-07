import Foundation

/// The first Grok process that created a session. Resume processes reuse the same session ID,
/// so keeping this identity lets AllPet return to the terminal that originally owned it.
public struct GrokSessionOrigin: Sendable, Equatable {
    public var processID: Int32
    public var workingDirectory: String?

    public init(processID: Int32, workingDirectory: String? = nil) {
        self.processID = processID
        self.workingDirectory = workingDirectory
    }
}

public enum GrokSessionOriginLookup {
    public static func origin(for sessionID: String, inLog path: String) -> GrokSessionOrigin? {
        GrokSessionOriginCache().origin(for: sessionID, inLog: path)
    }
}

final class GrokSessionOriginCache: @unchecked Sendable {
    private struct State {
        var inode: UInt64 = 0
        var offset: UInt64 = 0
        var pending = Data()
        var origins: [String: GrokSessionOrigin] = [:]
    }

    private let lock = NSLock()
    private var states: [String: State] = [:]

    func origin(for sessionID: String, inLog path: String) -> GrokSessionOrigin? {
        guard !sessionID.isEmpty else { return nil }
        lock.lock()
        defer { lock.unlock() }

        var state = states[path] ?? State()
        if let known = state.origins[sessionID] { return known }
        let url = URL(fileURLWithPath: path)
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let size = (attributes[.size] as? NSNumber)?.uint64Value,
              let inode = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value else { return nil }

        if state.inode != inode || size < state.offset {
            state = State(inode: inode)
        } else if state.inode == 0 {
            state.inode = inode
        }
        if state.offset == size {
            states[path] = state
            return nil
        }
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        do {
            try handle.seek(toOffset: state.offset)
            while let chunk = try handle.read(upToCount: 65_536), !chunk.isEmpty {
                state.offset += UInt64(chunk.count)
                state.pending.append(chunk)
                while let newline = state.pending.firstIndex(of: 0x0A) {
                    let line = Data(state.pending[..<newline])
                    state.pending.removeSubrange(...newline)
                    Self.consume(line, into: &state.origins)
                }
                if state.pending.count > 1_048_576 {
                    state.pending.removeAll(keepingCapacity: true)
                }
            }
            if !state.pending.isEmpty,
               (try? JSONSerialization.jsonObject(with: state.pending)) != nil {
                Self.consume(state.pending, into: &state.origins)
                state.pending.removeAll(keepingCapacity: true)
            }
        } catch {
            states[path] = state
            return state.origins[sessionID]
        }
        states[path] = state
        return state.origins[sessionID]
    }

    private static func consume(_ line: Data, into origins: inout [String: GrokSessionOrigin]) {
        guard line.range(of: Data("session created".utf8)) != nil,
              let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              object["msg"] as? String == "session created",
              let sessionID = object["sid"] as? String,
              origins[sessionID] == nil,
              let pidNumber = object["pid"] as? NSNumber else { return }
        let cwd = (object["ctx"] as? [String: Any])?["cwd"] as? String
        origins[sessionID] = GrokSessionOrigin(processID: pidNumber.int32Value, workingDirectory: cwd)
    }
}
