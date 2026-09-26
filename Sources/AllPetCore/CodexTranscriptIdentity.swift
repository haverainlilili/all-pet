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
        guard let payload = CodexSessionMetadata.readPayload(path: path) else { return CodexTranscriptIdentity() }
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
