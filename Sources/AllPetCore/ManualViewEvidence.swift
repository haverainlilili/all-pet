import Foundation

/// Exact session identity from DSH's versioned browser selection, never a substring match.
public enum ManualViewEvidence {
    public static func dshSelection(_ value: String, matches sessionID: String) -> Bool {
        guard !sessionID.isEmpty, value.utf8.count <= 65_536 else { return false }
        guard let data = value.data(using: .utf8),
              let decoded = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return value == sessionID // Legacy plain-string selection.
        }
        if let object = decoded as? [String: Any] { return object["sessionId"] as? String == sessionID }
        return decoded as? String == sessionID
    }
}
