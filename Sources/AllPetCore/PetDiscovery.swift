import Foundation

/// 宠物发现：扫描常见 Codex 宠物目录，返回可用的宠物包。
public enum PetDiscovery {

    public static func discover(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [PetBundle] {
        let claudeConfigRoot: URL = {
            guard let configured = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"], !configured.isEmpty else {
                return home.appendingPathComponent(".claude", isDirectory: true)
            }
            if configured == "~" { return home }
            if configured.hasPrefix("~/") { return home.appendingPathComponent(String(configured.dropFirst(2)), isDirectory: true) }
            return URL(fileURLWithPath: configured, isDirectory: true)
        }()
        let roots: [URL] = [
            home.appendingPathComponent(".codex/pets"),
            home.appendingPathComponent(".local/share/openpets/pets"),
            home.appendingPathComponent(".config/openpets/pets"),
            home.appendingPathComponent(".config/openpets/Pets"),
            home.appendingPathComponent(".config/all-pet/pets"),
            home.appendingPathComponent(".config/all-pet/pet-sources"),
            home.appendingPathComponent(".dsh/pets"),
            claudeConfigRoot.appendingPathComponent("cc-haha/pets")
        ]

        var bundles: [PetBundle] = []
        for root in roots {
            guard let enumerator = FileManager.default.enumerator(atPath: root.path) else { continue }
            for case let rel as String in enumerator {
                let components = (rel as NSString).pathComponents
                if components.contains(where: { $0.hasPrefix(".") }) { continue }
                let lower = components.map { $0.lowercased() }
                if lower.contains(where: { ["test", "tests", "fixtures", "fixture", "node_modules", "examples", "example"].contains($0) }) { continue }
                if (rel as NSString).lastPathComponent == "pet.json" {
                    let dir = root.appendingPathComponent((rel as NSString).deletingLastPathComponent)
                    if let bundle = try? PetBundle.load(from: dir) {
                        bundles.append(bundle)
                    }
                }
            }
        }
        return bundles
    }
}
