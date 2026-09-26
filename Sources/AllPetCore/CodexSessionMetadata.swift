import Foundation

/// Shared classification for live monitoring and migration of persisted task cards.
public enum CodexSessionMetadata {
    // Session metadata can contain long instructions. Read one bounded line, not the transcript.
    static func firstRecord(path: String) -> [String: Any]? {
        let url = URL(fileURLWithPath: path)
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? handle.close() }
        let limit = 1_048_576
        var line = Data()
        while line.count < limit {
            guard let chunk = try? handle.read(upToCount: min(16_384, limit - line.count)) else { return nil }
            if chunk.isEmpty { break }
            if let newline = chunk.firstIndex(of: 0x0A) {
                line.append(contentsOf: chunk[..<newline])
                return (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
            }
            line.append(chunk)
        }
        guard line.count < limit else { return nil }
        return (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
    }

    public static func readPayload(path: String) -> [String: Any]? {
        guard let record = firstRecord(path: path), record["type"] as? String == "session_meta" else { return nil }
        return record["payload"] as? [String: Any]
    }

    public static func isExcluded(payload: [String: Any]) -> Bool {
        let originator = (payload["originator"] as? String ?? "").lowercased()
        return originator.contains("dsh")
            || isInternalSource(payload["source"])
            || isInternalSource(payload["thread_source"])
    }

    private static func isInternalSource(_ raw: Any?) -> Bool {
        if let value = raw as? String {
            let lower = value.lowercased()
            return lower.contains("dsh") || lower.contains("subagent") || lower == "guardian_review"
        }
        if let value = raw as? [String: Any] {
            return value.keys.contains("subagent") || isInternalSource(value["type"])
        }
        return false
    }

    /// Unknown/missing metadata must not delete a legitimate unnamed user's history.
    public static func isExcluded(path: String) -> Bool {
        guard let payload = readPayload(path: path) else { return false }
        return isExcluded(payload: payload)
    }
}
