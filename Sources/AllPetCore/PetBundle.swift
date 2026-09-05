import Foundation
import ImageIO

public enum PetError: Error, LocalizedError {
    case missingManifest(URL)
    case missingSpritesheet(URL)
    case invalidSpritesheet(URL)
    case invalidAtlasDimensions(width: Int, height: Int)

    public var errorDescription: String? {
        switch self {
        case .missingManifest(let url): "缺少宠物清单 pet.json：\(url.path)"
        case .missingSpritesheet(let url): "缺少精灵图：\(url.path)"
        case .invalidSpritesheet(let url): "无法读取精灵图：\(url.path)"
        case .invalidAtlasDimensions(let w, let h): "精灵图尺寸 \(w)x\(h) 无法整除为 8 列 × 9/11 行图集"
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
        let manifestURL = directoryURL.appendingPathComponent("pet.json")
        guard FileManager.default.fileExists(atPath: manifestURL.path) else {
            throw PetError.missingManifest(manifestURL)
        }
        let manifest = try JSONDecoder().decode(PetManifest.self, from: Data(contentsOf: manifestURL))

        let spritesheetURL = directoryURL.appendingPathComponent(manifest.spritesheetPath)
        guard FileManager.default.fileExists(atPath: spritesheetURL.path) else {
            throw PetError.missingSpritesheet(spritesheetURL)
        }
        let atlas = try readAtlas(from: spritesheetURL)

        return PetBundle(directoryURL: directoryURL, manifest: manifest, spritesheetURL: spritesheetURL, atlas: atlas)
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
