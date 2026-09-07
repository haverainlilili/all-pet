import Foundation
import ImageIO

public enum PetError: Error, LocalizedError {
    case missingManifest(URL)
    case missingSpritesheet(URL)
    case invalidSpritesheet(URL)
    case invalidAtlasDimensions(width: Int, height: Int)
    case unsafeBundlePath(URL)
    case bundleResourceTooLarge(URL)

    public var errorDescription: String? {
        switch self {
        case .missingManifest(let url): "缺少宠物清单 pet.json：\(url.path)"
        case .missingSpritesheet(let url): "缺少精灵图：\(url.path)"
        case .invalidSpritesheet(let url): "无法读取精灵图：\(url.path)"
        case .invalidAtlasDimensions(let w, let h): "精灵图尺寸 \(w)x\(h) 无法整除为 8 列 × 9/11 行图集"
        case .unsafeBundlePath(let url): "宠物包包含不安全路径或符号链接：\(url.path)"
        case .bundleResourceTooLarge(let url): "宠物包资源超出安全限制：\(url.path)"
        }
    }
}

/// 一个已加载的宠物包（目录 + 清单 + 精灵图 + 图集几何）。
/// 图集读取复用 openpets 的 PetBundle 思路（ImageIO 读尺寸，支持 WebP）。
public struct PetBundle: Sendable {
    public let directoryURL: URL
    public let manifest: PetManifest
    public let spritesheetURL: URL
    public let atlas: PetAtlas

    public init(directoryURL: URL, manifest: PetManifest, spritesheetURL: URL, atlas: PetAtlas) {
        self.directoryURL = directoryURL
        self.manifest = manifest
        self.spritesheetURL = spritesheetURL
        self.atlas = atlas
    }

    public static func load(from directoryURL: URL) throws -> PetBundle {
        let directory = directoryURL.standardizedFileURL
        let directoryValues = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard directoryValues.isDirectory == true, directoryValues.isSymbolicLink != true,
              directory.resolvingSymlinksInPath().path == directory.path else {
            throw PetError.unsafeBundlePath(directory)
        }
        let manifestURL = directory.appendingPathComponent("pet.json")
        guard FileManager.default.fileExists(atPath: manifestURL.path) else { throw PetError.missingManifest(manifestURL) }
        let manifestValues = try manifestURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard manifestValues.isRegularFile == true, manifestValues.isSymbolicLink != true else { throw PetError.unsafeBundlePath(manifestURL) }
        guard (manifestValues.fileSize ?? 0) <= 262_144 else { throw PetError.bundleResourceTooLarge(manifestURL) }
        let manifestData = try Data(contentsOf: manifestURL, options: [.mappedIfSafe])
        let manifest: PetManifest
        if var object = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
           (object["id"] as? String)?.isEmpty != false {
            object["id"] = directory.lastPathComponent
            manifest = try JSONDecoder().decode(PetManifest.self, from: JSONSerialization.data(withJSONObject: object))
        } else {
            manifest = try JSONDecoder().decode(PetManifest.self, from: manifestData)
        }

        guard !manifest.id.isEmpty else { throw PetError.unsafeBundlePath(manifestURL) }
        let relative = manifest.spritesheetPath
        guard !relative.isEmpty, !relative.hasPrefix("/"), !relative.contains("\\") else {
            throw PetError.unsafeBundlePath(URL(fileURLWithPath: relative))
        }
        let parts = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard !parts.contains(".."), !parts.contains("."), !parts.contains("") else {
            throw PetError.unsafeBundlePath(URL(fileURLWithPath: relative))
        }
        var spritesheetURL = directory
        for (index, part) in parts.enumerated() {
            spritesheetURL.appendPathComponent(String(part), isDirectory: index < parts.count - 1)
            let values = try spritesheetURL.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isSymbolicLink != true else { throw PetError.unsafeBundlePath(spritesheetURL) }
            if index < parts.count - 1 {
                guard values.isDirectory == true else { throw PetError.missingSpritesheet(spritesheetURL) }
            } else {
                guard values.isRegularFile == true else { throw PetError.missingSpritesheet(spritesheetURL) }
                guard (values.fileSize ?? 0) <= 128 * 1_024 * 1_024 else { throw PetError.bundleResourceTooLarge(spritesheetURL) }
            }
        }
        guard spritesheetURL.resolvingSymlinksInPath().path == spritesheetURL.path,
              spritesheetURL.path.hasPrefix(directory.path + "/") else { throw PetError.unsafeBundlePath(spritesheetURL) }
        let atlas = try readAtlas(from: spritesheetURL)

        return PetBundle(directoryURL: directory, manifest: manifest, spritesheetURL: spritesheetURL, atlas: atlas)
    }

    private static func readAtlas(from url: URL) throws -> PetAtlas {
        guard
            let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = props[kCGImagePropertyPixelWidth] as? Int,
            let height = props[kCGImagePropertyPixelHeight] as? Int
        else {
            throw PetError.invalidSpritesheet(url)
        }

        let (pixels, overflow) = width.multipliedReportingOverflow(by: height)
        guard !overflow, width > 0, height > 0, width <= 16_384, height <= 16_384, pixels <= 40_000_000 else {
            throw PetError.bundleResourceTooLarge(url)
        }

        let columns = PetAtlas.codexColumns
        // v2（11 行）优先；否则 v1（9 行）。与 codex-to-dsh-pet 的版本识别一致。
        let rows: Int
        if width % columns == 0 && height % PetAtlas.codexRowsV2 == 0 && height % PetAtlas.codexRowsV1 != 0 {
            rows = PetAtlas.codexRowsV2
        } else if width % columns == 0 && height % PetAtlas.codexRowsV1 == 0 {
            rows = PetAtlas.codexRowsV1
        } else {
            throw PetError.invalidAtlasDimensions(width: width, height: height)
        }

        return PetAtlas(
            columns: columns,
            rows: rows,
            cellWidth: width / columns,
            cellHeight: height / rows,
            pixelWidth: width,
            pixelHeight: height
        )
    }
}
