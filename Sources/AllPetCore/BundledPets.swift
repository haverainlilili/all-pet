import Foundation

/// 随 AllPet 分发的内置宠物：用户无需联网即可使用。
/// 首次运行时物化到 `~/.config/all-pet/pets/`，之后交由 PetDiscovery 正常发现。
public enum BundledPets {
    /// 内置宠物 slug，按默认展示顺序排列；首个是全新用户的开箱默认宠物。
    public static let slugs: [String] = ["boba", "tiko", "cat-hamster-duo", "hoops", "watermelon"]

    /// 物化标记：成功物化一次后不再自动补齐，尊重用户对内置宠物的删除。
    private static let markerName = ".bundled-pets.v1"

    /// 把内置宠物物化到 `~/.config/all-pet/pets/`（幂等；首次成功后写标记）。
    public static func materialize(home: URL) {
        let configDir = home.appendingPathComponent(".config/all-pet", isDirectory: true)
        let marker = configDir.appendingPathComponent(markerName)
        guard !FileManager.default.fileExists(atPath: marker.path) else { return }

        let root = configDir.appendingPathComponent("pets", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var allMaterialized = true
        for slug in slugs {
            if !materialize(slug: slug, into: root) { allMaterialized = false }
        }
        guard allMaterialized else { return }
        try? FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)
        try? Data().write(to: marker)
    }

    /// 物化单个内置宠物；目标已存在则视为完成（不覆盖用户现有宠物）。
    private static func materialize(slug: String, into root: URL) -> Bool {
        let destDir = root.appendingPathComponent(slug, isDirectory: true)
        let destManifest = destDir.appendingPathComponent("pet.json")
        if FileManager.default.fileExists(atPath: destManifest.path) { return true }

        guard let resourceRoot = Bundle.module.resourceURL else { return false }
        let srcDir = resourceRoot.appendingPathComponent("BundledPets").appendingPathComponent(slug)
        let fm = FileManager.default
        guard fm.fileExists(atPath: srcDir.path) else { return false }
        do {
            try fm.createDirectory(at: destDir, withIntermediateDirectories: true)
            for name in ["pet.json", "spritesheet.webp"] {
                let src = srcDir.appendingPathComponent(name)
                guard fm.fileExists(atPath: src.path) else { continue }
                try fm.copyItem(at: src, to: destDir.appendingPathComponent(name))
            }
            return fm.fileExists(atPath: destManifest.path)
        } catch {
            return false
        }
    }
}
