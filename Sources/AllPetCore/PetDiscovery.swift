import Foundation

/// 宠物发现：扫描常见 Codex 宠物目录，返回可用的宠物包。
public enum PetDiscovery {

    public static func discover(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [PetBundle] {
        let roots: [URL] = [
            home.appendingPathComponent(".codex/pets"),
            home.appendingPathComponent(".local/share/openpets/pets"),
            home.appendingPathComponent(".config/openpets/pets"),
            home.appendingPathComponent(".config/openpets/Pets"),
            home.appendingPathComponent(".dsh/pets")
        ]

        var bundles: [PetBundle] = []
        for root in roots {
            guard let enumerator = FileManager.default.enumerator(atPath: root.path) else { continue }
            for case let rel as String in enumerator {
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
