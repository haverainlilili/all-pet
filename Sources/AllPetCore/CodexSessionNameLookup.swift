import Foundation

/// Resolves Codex's stable thread name from session_index.jsonl; the latest rename wins.
public enum CodexSessionNameLookup {
    public static func name(for sessionID: String, transcriptPath: String? = nil, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> String? {
        guard !sessionID.isEmpty else { return nil }
        let candidates = indexCandidates(transcriptPath: transcriptPath, home: home)
        for url in candidates {
            guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
                  values.isRegularFile == true,
                  values.isSymbolicLink != true,
                  (values.fileSize ?? 0) <= 4_194_304,
                  let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else { continue }
            var result: String?
            for line in data.split(separator: 0x0A) {
                guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                      object["id"] as? String == sessionID,
                      let raw = object["thread_name"] as? String else { continue }
                let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty { result = String(value.prefix(90)) }
            }
            if let result { return result }
        }
        return nil
    }

    public static func isUnique(
        _ name: String,
        for sessionID: String,
        transcriptPath: String? = nil,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> Bool {
        let expected = normalized(name)
        guard !expected.isEmpty, !sessionID.isEmpty else { return false }
        for url in indexCandidates(transcriptPath: transcriptPath, home: home) {
            guard let names = latestNames(in: url) else { continue }
            let matches = names.filter { normalized($0.value) == expected }.map(\.key)
            return matches.count == 1 && matches[0] == sessionID
        }
        return false
    }

    private static func latestNames(in url: URL) -> [String: String]? {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? 0) <= 4_194_304,
              let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else { return nil }
        var result: [String: String] = [:]
        for line in data.split(separator: 0x0A) {
            guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  let id = object["id"] as? String, let raw = object["thread_name"] as? String else { continue }
            let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { result[id] = value }
        }
        return result
    }

    private static func normalized(_ value: String) -> String {
        value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    private static func indexCandidates(transcriptPath: String?, home: URL) -> [URL] {
        var urls: [URL] = []
        if let transcriptPath {
            var cursor = URL(fileURLWithPath: transcriptPath).deletingLastPathComponent()
            while cursor.path != "/" {
                if cursor.lastPathComponent == "sessions", cursor.deletingLastPathComponent().lastPathComponent == ".codex" {
                    urls.append(cursor.deletingLastPathComponent().appendingPathComponent("session_index.jsonl"))
                    break
                }
                cursor.deleteLastPathComponent()
            }
        }
        let standard = home.appendingPathComponent(".codex/session_index.jsonl")
        if !urls.contains(standard) { urls.append(standard) }
        return urls
    }
}
