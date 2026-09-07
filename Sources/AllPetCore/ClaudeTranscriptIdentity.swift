import Foundation

public struct ClaudeTranscriptIdentity: Sendable, Equatable {
    public var launchOrigin: String?
    public var customTitle: String?

    public init(launchOrigin: String? = nil, customTitle: String? = nil) {
        self.launchOrigin = launchOrigin
        self.customTitle = customTitle
    }
}

/// Reads only the bounded transcript prefix where Claude records entrypoint and custom-title metadata.
public enum ClaudeTranscriptIdentityLookup {
    public static func read(path: String, maximumBytes: Int = 262_144) -> ClaudeTranscriptIdentity {
        let url = URL(fileURLWithPath: path)
        guard maximumBytes > 0,
              let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true,
              values.isSymbolicLink != true,
              let handle = FileHandle(forReadingAtPath: path) else { return ClaudeTranscriptIdentity() }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: maximumBytes) else { return ClaudeTranscriptIdentity() }

        var result = ClaudeTranscriptIdentity()
        for line in data.split(separator: 0x0A) {
            guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
            if result.launchOrigin == nil, let value = object["entrypoint"] as? String, !value.isEmpty {
                result.launchOrigin = value
            }
            if object["type"] as? String == "custom-title",
               let value = object["customTitle"] as? String {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { result.customTitle = String(trimmed.prefix(90)) }
            }
            if result.launchOrigin != nil, result.customTitle != nil { break }
        }
        return result
    }
}
