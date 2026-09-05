import Foundation

/// 宠物清单 `pet.json`（Codex Pets 格式，与 openpets PetManifest 兼容）。
public struct PetManifest: Codable, Sendable {
    public var id: String
    public var displayName: String
    public var description: String
    public var spritesheetPath: String

    public init(id: String, displayName: String, description: String, spritesheetPath: String) {
        self.id = id
        self.displayName = displayName
        self.description = description
        self.spritesheetPath = spritesheetPath
    }

    private enum CodingKeys: String, CodingKey {
        case id, displayName, description, spritesheetPath
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? id
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        spritesheetPath = try c.decodeIfPresent(String.self, forKey: .spritesheetPath) ?? "spritesheet.webp"
    }
}

/// 图集几何信息。Codex 标准图集为 8 列 × 9 行（v1）；v2 为 8 列 × 11 行（含注视帧）。
public struct PetAtlas: Codable, Sendable {
    public static let codexColumns = 8
    public static let codexRowsV1 = 9
    public static let codexRowsV2 = 11

    public var columns: Int
    public var rows: Int
    public var cellWidth: Int
    public var cellHeight: Int
    public var pixelWidth: Int
    public var pixelHeight: Int

    public init(columns: Int, rows: Int, cellWidth: Int, cellHeight: Int, pixelWidth: Int, pixelHeight: Int) {
        self.columns = columns
        self.rows = rows
        self.cellWidth = cellWidth
        self.cellHeight = cellHeight
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
    }
}
