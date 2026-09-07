import Foundation

public struct CodexTranscriptIdentity: Sendable, Equatable {
    public var sessionID: String?
    public var launchOrigin: String?

    public init(sessionID: String? = nil, launchOrigin: String? = nil) {
        self.sessionID = sessionID
        self.launchOrigin = launchOrigin
    }
}

public enum CodexTranscriptIdentityLookup {
    public static func read(path: String) -> CodexTranscriptIdentity {
        let url = URL(fileURLWithPath: path)
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let handle = FileHandle(forReadingAtPath: path) else { return CodexTranscriptIdentity() }
        defer { try? handle.close() }
        guard let chunk = try? handle.read(upToCount: 65_536) else { return CodexTranscriptIdentity() }
        let line: Data
        if let newline = chunk.firstIndex(of: 0x0A) {
            line = Data(chunk[..<newline])
        } else {
            guard chunk.count < 65_536 else { return CodexTranscriptIdentity() }
            line = chunk
        }
        guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              object["type"] as? String == "session_meta",
              let payload = object["payload"] as? [String: Any] else { return CodexTranscriptIdentity() }
        let originator = (payload["originator"] as? String ?? "").lowercased()
        let source = (payload["source"] as? String ?? "").lowercased()
        let launchOrigin: String?
        if originator.contains("desktop") || source == "vscode" {
            launchOrigin = "codex-desktop"
        } else if originator.contains("cli") || source == "cli" || source == "exec" {
            launchOrigin = "codex-cli"
        } else {
            launchOrigin = nil
        }
        return CodexTranscriptIdentity(
            sessionID: payload["session_id"] as? String ?? payload["id"] as? String,
            launchOrigin: launchOrigin
        )
    }
}
