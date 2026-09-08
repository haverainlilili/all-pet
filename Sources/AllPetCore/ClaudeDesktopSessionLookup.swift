import Foundation

public struct ClaudeDesktopSessionRecord: Sendable, Equatable {
    public var sessionID: String
    public var cliSessionID: String
    public var metadataURL: URL
    public var createdAt: Double
    public var lastFocusedAt: Double
    public var isArchived: Bool
    public var title: String?
}

/// Resolves a Claude Code transcript UUID to the already-existing Claude Desktop task that owns it.
/// `claude://resume` imports a new task, so callers must navigate with the returned `local_*` ID instead.
public enum ClaudeDesktopSessionLookup {
    public static func defaultRoots(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [URL] {
        [
            home.appendingPathComponent("Library/Application Support/Claude-3p/claude-code-sessions"),
            home.appendingPathComponent("Library/Application Support/Claude/claude-code-sessions")
        ]
    }

    public static func originalSession(
        forCLI cliSessionID: String,
        roots: [URL],
        maximumFiles: Int = 4_000
    ) -> ClaudeDesktopSessionRecord? {
        records(roots: roots, maximumFiles: maximumFiles)
            .filter { !$0.isArchived && $0.cliSessionID == cliSessionID }
            .sorted {
                if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
                return $0.sessionID < $1.sessionID
            }
            .first
    }

    public static func originalSessionID(
        forCLI cliSessionID: String,
        roots: [URL],
        maximumFiles: Int = 4_000
    ) -> String? {
        originalSession(forCLI: cliSessionID, roots: roots, maximumFiles: maximumFiles)?.sessionID
    }

    public static func session(
        withID sessionID: String,
        roots: [URL],
        maximumFiles: Int = 4_000
    ) -> ClaudeDesktopSessionRecord? {
        records(roots: roots, maximumFiles: maximumFiles)
            .filter { !$0.isArchived && $0.sessionID == sessionID }
            .sorted {
                if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
                return $0.metadataURL.path < $1.metadataURL.path
            }
            .first
    }

    /// 当前焦点会话：全部会话里 `lastFocusedAt` 最大的那一个。
    public static func mostRecentlyFocusedSession(
        roots: [URL],
        maximumFiles: Int = 4_000
    ) -> ClaudeDesktopSessionRecord? {
        records(roots: roots, maximumFiles: maximumFiles)
            .filter { !$0.isArchived }
            .max { $0.lastFocusedAt < $1.lastFocusedAt }
    }

    private static func records(roots: [URL], maximumFiles: Int) -> [ClaudeDesktopSessionRecord] {
        guard maximumFiles > 0 else { return [] }
        var records: [ClaudeDesktopSessionRecord] = []
        var inspected = 0

        for root in roots {
            guard let enumerator = FileManager.default.enumerator(
                at: root,
                includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey],
                options: [.skipsHiddenFiles, .skipsPackageDescendants]
            ) else { continue }

            for case let url as URL in enumerator {
                guard url.pathExtension.lowercased() == "json" else { continue }
                // Never pick an apparent "oldest" record from a truncated, filesystem-order subset.
                guard inspected < maximumFiles else { return [] }
                inspected += 1
                guard
                    let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
                    values.isRegularFile == true,
                    values.isSymbolicLink != true,
                    (values.fileSize ?? 0) <= 131_072,
                    let data = try? Data(contentsOf: url),
                    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    let cliSessionID = object["cliSessionId"] as? String,
                    let sessionID = object["sessionId"] as? String,
                    sessionID.hasPrefix("local_")
                else { continue }

                records.append(ClaudeDesktopSessionRecord(
                    sessionID: sessionID,
                    cliSessionID: cliSessionID,
                    metadataURL: url,
                    createdAt: (object["createdAt"] as? NSNumber)?.doubleValue ?? .greatestFiniteMagnitude,
                    lastFocusedAt: (object["lastFocusedAt"] as? NSNumber)?.doubleValue ?? 0,
                    isArchived: object["isArchived"] as? Bool == true,
                    title: object["title"] as? String
                ))
            }
        }
        return records
    }
}
