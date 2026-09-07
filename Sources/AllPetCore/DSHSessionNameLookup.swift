import Foundation

/// Reads DSH's small projection-cache record instead of using the latest user turn as the session label.
public enum DSHSessionNameLookup {
    public static func name(for sessionID: String, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> String? {
        guard !sessionID.isEmpty, !sessionID.contains("/"), !sessionID.contains("\\") else { return nil }
        let dshRoot: URL
        if let configured = ProcessInfo.processInfo.environment["DSH_HOME"], !configured.isEmpty {
            dshRoot = URL(fileURLWithPath: PathExpander.expand(configured), isDirectory: true)
        } else {
            dshRoot = home.appendingPathComponent(".dsh", isDirectory: true)
        }
        let url = dshRoot.appendingPathComponent("storages/session_projcache/sessions", isDirectory: true)
            .appendingPathComponent(sessionID).appendingPathExtension("json")
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? 0) <= 1_048_576,
              let data = try? Data(contentsOf: url, options: [.mappedIfSafe]),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let record = object["record"] as? [String: Any],
              let rows = record["rows"] as? [String: Any],
              let title = rows["title"] as? [String: Any],
              let raw = title["val"] as? String else { return nil }
        let cleaned = raw.unicodeScalars.map { scalar -> String in
            let code = scalar.value
            return (code < 0x20 || (0x7f...0x9f).contains(code)) ? " " : String(scalar)
        }.joined().trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : String(cleaned.prefix(90))
    }
}
