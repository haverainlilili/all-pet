import AppKit
import Foundation
import ImageIO

public enum PetModelSourceKind: String, Codable, Sendable {
    case codexAtlas = "codex-atlas"
    case localSingleImage = "local-single-image"
    case ccHaha = "cc-haha"
    case clawdOnDesk = "clawd-on-desk"
    case lingChat = "lingchat"

    public var label: String {
        switch self {
        case .codexAtlas: "Codex / OpenPets 图集"
        case .localSingleImage: "本地单图宠物"
        case .ccHaha: "cc-haha"
        case .clawdOnDesk: "clawd-on-desk"
        case .lingChat: "LingChat"
        }
    }
    public var repositoryURL: String {
        switch self {
        case .codexAtlas: "https://github.com/openai/codex"
        case .localSingleImage: "local-user-supplied"
        case .ccHaha: "https://github.com/NanmiCoder/cc-haha"
        case .clawdOnDesk: "https://github.com/rullerzhou-afk/clawd-on-desk"
        case .lingChat: "https://github.com/SlimeBoyOwO/LingChat"
        }
    }
    public var licenseNotice: String {
        switch self {
        case .codexAtlas: "保留原宠物包许可证"
        case .localSingleImage: "保留原清单与素材许可证；AllPet 不推定授权"
        case .ccHaha: "代码 MIT；宠物素材仍以原作者授权为准"
        case .clawdOnDesk: "AGPL-3.0；仅消费用户本地素材，不随 AllPet 分发"
        case .lingChat: "AGPL-3.0；角色、Live2D 模型及 Cubism 授权独立"
        }
    }
}

public struct PetModelImportResult: Sendable {
    public var sourceKind: PetModelSourceKind
    public var bundle: PetBundle
    public var normalized: Bool
    public var note: String
}

public enum PetModelImportError: Error, LocalizedError {
    case unsupported(URL), unsafePath(String), invalidManifest(String), missingAsset(String)
    case invalidImage(URL), tooLarge(URL), noFrames(String), installFailed(String)
    public var errorDescription: String? {
        switch self {
        case .unsupported(let u): "无法识别宠物模型格式：\(u.path)"
        case .unsafePath(let s): "拒绝不安全的素材路径：\(s)"
        case .invalidManifest(let s): "宠物清单无效：\(s)"
        case .missingAsset(let s): "缺少宠物素材：\(s)"
        case .invalidImage(let u): "无法读取宠物图片：\(u.path)"
        case .tooLarge(let u): "宠物素材超出大小限制：\(u.path)"
        case .noFrames(let s): "没有可用的宠物帧：\(s)"
        case .installFailed(let s): "导入宠物失败：\(s)"
        }
    }
}

/// 只读取用户明确选择的本地素材，不下载、内置或重新分发第三方宠物。
public enum PetModelImporter {
    private static let columns = 8, rows = 9, cellWidth = 192, cellHeight = 208
    private static let maxManifest = 262_144, maxAsset = 128 * 1_024 * 1_024, maxPixels = 40_000_000
    private static let maxDecodedPixelsPerImport = 32_000_000

    private final class DecodeBudget {
        var remaining = maxDecodedPixelsPerImport
        func consume(width: Int, height: Int, source: URL) throws {
            let (pixels, overflow) = width.multipliedReportingOverflow(by: height)
            guard !overflow, pixels > 0, pixels <= remaining else { throw PetModelImportError.tooLarge(source) }
            remaining -= pixels
        }
    }

    public static func importModel(from inputURL: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> PetModelImportResult {
        let input = try checkedInput(inputURL)
        let directory = input.hasDirectoryPath ? input : input.deletingLastPathComponent()
        let name = input.lastPathComponent.lowercased()
        if !input.hasDirectoryPath {
            if name == "pet.json" { return try importPetJSON(input, home: home) }
            if name == "settings.yml" || name == "settings.yaml" { return try importLingChat(directory, home: home) }
            if name == "theme.json" { return try importClawd(directory, selected: directory, home: home) }
            throw PetModelImportError.unsupported(input)
        }
        let petJSON = directory.appendingPathComponent("pet.json")
        if FileManager.default.fileExists(atPath: petJSON.path) { return try importPetJSON(petJSON, home: home) }
        if hasSettings(directory) { return try importLingChat(directory, home: home) }
        if FileManager.default.fileExists(atPath: directory.appendingPathComponent("theme.json").path) {
            return try importClawd(directory, selected: directory, home: home)
        }
        if let theme = preferredTheme(in: directory) { return try importClawd(theme, selected: directory, home: home) }
        throw PetModelImportError.unsupported(input)
    }

    private static func importPetJSON(_ url: URL, home: URL) throws -> PetModelImportResult {
        let dir = try checkedDirectory(url.deletingLastPathComponent())
        let json = try readObject(url)
        let declaredID = (json["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = (declaredID?.isEmpty == false ? declaredID : nil) ?? safeSlug(dir.lastPathComponent)
        if let relative = json["spritesheetPath"] as? String {
            _ = try checkedAsset(relative, in: dir)
            let bundle = try PetBundle.load(from: dir)
            let text = ((json["sourceProject"] as? String) ?? "") + dir.path
            let kind: PetModelSourceKind = text.localizedCaseInsensitiveContains("cc-haha") ? .ccHaha : (text.localizedCaseInsensitiveContains("clawd-on-desk") ? .clawdOnDesk : .codexAtlas)
            return .init(sourceKind: kind, bundle: bundle, normalized: false, note: "直接复用原生 Codex 图集，未复制素材")
        }
        guard (json["manifestVersion"] as? NSNumber)?.intValue == 1,
              let renderer = json["renderer"] as? [String: Any],
              renderer["kind"] as? String == "single-image",
              (renderer["version"] as? NSNumber)?.intValue == 1,
              let relative = renderer["imagePath"] as? String else {
            throw PetModelImportError.invalidManifest("不支持的 pet.json renderer/version")
        }
        if let motionProfile = renderer["motionProfile"] as? String, motionProfile != "soft-spring-v1" {
            throw PetModelImportError.invalidManifest("不支持的 motionProfile：\(motionProfile)")
        }
        let provenance = (json["sourceProject"] as? String ?? "").lowercased()
        let isCcHaha = provenance.contains("cc-haha") || dir.path.lowercased().contains("/cc-haha/")
        let kind: PetModelSourceKind = isCcHaha ? .ccHaha : .localSingleImage
        let budget = DecodeBudget()
        let source = try checkedAsset(relative, in: dir)
        let mapped = try PetAnimation.allCases.sorted { $0.row < $1.row }.map { animation in
            try imageFrames(source, targetFrameCount: animation.actionFrameDurationsMilliseconds.count, budget: budget)
        }
        let bundle = try install(rows: mapped, mirrorRows: [2],
            id: "\(isCcHaha ? "cc-haha" : "single-image")-\(id)",
            name: json["displayName"] as? String ?? id,
            description: json["description"] as? String ?? (isCcHaha ? "cc-haha 单图宠物" : "本地单图宠物"),
            kind: kind, source: dir, mode: isCcHaha ? "single-image/static-motion-adapter" : "compatible-single-image/static-adapter",
            home: home, declaredProject: json["sourceProject"] as? String, declaredLicense: json["sourceLicense"] as? String)
        return .init(sourceKind: kind, bundle: bundle, normalized: true,
            note: isCcHaha ? "按 cc-haha single-image 语义映射到 AllPet 状态" : "按兼容 single-image 清单映射；保留原素材授权")
    }

    private static func importClawd(_ theme: URL, selected: URL, home: URL) throws -> PetModelImportResult {
        let json = try readObject(theme.appendingPathComponent("theme.json"))
        guard let states = json["states"] as? [String: Any] else { throw PetModelImportError.invalidManifest("theme.json 缺少 states") }
        var selectionBoundary = try checkedDirectory(selected.hasDirectoryPath ? selected : selected.deletingLastPathComponent())
        if selectionBoundary.path == theme.standardizedFileURL.path,
           theme.deletingLastPathComponent().lastPathComponent == "themes" {
            // Selecting canonical <checkout>/themes/<name> explicitly also authorizes that checkout's assets/.
            selectionBoundary = try checkedDirectory(theme.deletingLastPathComponent().deletingLastPathComponent())
        }
        let theme = try checkedDirectory(theme, within: selectionBoundary)
        let root = try clawdRoot(from: theme, within: selectionBoundary)
        let gifs = try root.map { try checkedDirectory($0.appendingPathComponent("assets/gif", isDirectory: true), within: selectionBoundary) }
        let themeAssetsURL = theme.appendingPathComponent("assets", isDirectory: true)
        let themeAssets = FileManager.default.fileExists(atPath: themeAssetsURL.path)
            ? try checkedDirectory(themeAssetsURL, within: selectionBoundary) : nil
        let prefix = theme.lastPathComponent.lowercased()
        func stateAsset(_ names: [String], _ suffixes: [String]) -> URL? {
            for state in names {
                for case let relative as String in (states[state] as? [Any] ?? []) {
                    let base = URL(fileURLWithPath: relative).deletingPathExtension().lastPathComponent
                    if let gifs, let gif = try? checkedAsset("\(base).gif", in: gifs) { return gif }
                    if let themeAssets, let direct = try? checkedAsset(relative, in: themeAssets) { return direct }
                    if let direct = try? checkedAsset(relative, in: theme) { return direct }
                }
            }
            if let gifs {
                for suffix in suffixes { if let gif = try? checkedAsset("\(prefix)-\(suffix).gif", in: gifs) { return gif } }
            }
            return nil
        }
        let specs: [([String], [String])] = [
            (["idle"], ["idle"]), (["roam"], ["mini-crabwalk", "idle"]), (["roam"], ["mini-crabwalk", "idle"]),
            (["attention"], ["happy", "mini-happy", "attention"]), (["waking"], ["react-double-jump", "mini-peek", "happy"]),
            (["error"], ["error"]), (["thinking", "notification"], ["thinking", "notification"]),
            (["working"], ["typing", "building"]), (["attention", "notification"], ["attention", "happy", "notification"])
        ]
        var mapped: [[CGImage]] = []
        var idleAsset: URL?
        let budget = DecodeBudget()
        for (row, spec) in specs.enumerated() {
            let (names, suffixes) = spec
            let frameCount = PetAnimation.allCases.first(where: { $0.row == row })?.actionFrameDurationsMilliseconds.count ?? columns
            if let asset = stateAsset(names, suffixes) {
                if row == 0 { idleAsset = asset }
                mapped.append(try imageFrames(asset, targetFrameCount: frameCount, budget: budget))
            } else if let idleAsset {
                mapped.append(try imageFrames(idleAsset, targetFrameCount: frameCount, budget: budget))
            } else {
                throw PetModelImportError.noFrames(theme.lastPathComponent)
            }
        }
        let title = json["name"] as? String ?? theme.lastPathComponent
        let bundle = try install(rows: mapped, mirrorRows: [2], id: "clawd-\(theme.lastPathComponent)", name: "\(title) · clawd-on-desk",
            description: "clawd-on-desk 原生 theme.json 状态适配", kind: .clawdOnDesk, source: theme,
            mode: "native-theme/static-atlas-adapter", home: home)
        return .init(sourceKind: .clawdOnDesk, bundle: bundle, normalized: true,
            note: "读取本地 theme.json 与 GIF/SVG；不执行第三方脚本")
    }

    private static func importLingChat(_ inputDirectory: URL, home: URL) throws -> PetModelImportResult {
        let dir = try checkedDirectory(inputDirectory)
        guard let settingsURL = ["settings.yml", "settings.yaml"].map({ dir.appendingPathComponent($0) }).first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
            throw PetModelImportError.missingAsset("settings.yml")
        }
        let settings = try readTextManifest(settingsURL)
        let avatars = try safeImages(in: dir.appendingPathComponent("avatar", isDirectory: true))
        guard let first = avatars.first else { throw PetModelImportError.noFrames("avatar/") }
        func pick(_ words: [String]) -> URL {
            avatars.first(where: { url in words.contains(where: { url.deletingPathExtension().lastPathComponent.localizedCaseInsensitiveContains($0) }) }) ?? first
        }
        let words = [
            ["平静", "正常", "默认", "neutral"], ["认真", "工作", "serious"], ["认真", "工作", "serious"],
            ["高兴", "开心", "happy"], ["兴奋", "惊喜", "excited"], ["伤心", "难过", "sad"],
            ["疑惑", "担心", "worried", "confused"], ["认真", "工作", "serious"], ["高兴", "开心", "happy"]
        ]
        let budget = DecodeBudget()
        let mapped = try words.enumerated().map { row, words in
            let frameCount = PetAnimation.allCases.first(where: { $0.row == row })?.actionFrameDurationsMilliseconds.count ?? columns
            return try imageFrames(pick(words), targetFrameCount: frameCount, budget: budget)
        }
        let title = yamlName(settings) ?? dir.lastPathComponent
        let bundle = try install(rows: mapped, mirrorRows: [2], id: "lingchat-\(dir.lastPathComponent)", name: "\(title) · LingChat",
            description: "LingChat avatar 表情适配（静态回退）", kind: .lingChat, source: dir,
            mode: "avatar/static-fallback", home: home)
        return .init(sourceKind: .lingChat, bundle: bundle, normalized: true,
            note: "复用本地 avatar；Live2D/Cubism 授权独立，未加载其运行时")
    }

    private static func install(rows images: [[CGImage]], mirrorRows: Set<Int>, id: String, name: String,
                                description: String, kind: PetModelSourceKind, source: URL, mode: String, home: URL,
                                declaredProject: String? = nil, declaredLicense: String? = nil) throws -> PetBundle {
        guard images.count == rows, images.allSatisfy({ !$0.isEmpty }) else { throw PetModelImportError.noFrames(name) }
        let configRoot = home.appendingPathComponent(".config/all-pet", isDirectory: true)
        let root = configRoot.appendingPathComponent("pets", isDirectory: true)
        let stagingRoot = configRoot.appendingPathComponent(".pet-import-staging", isDirectory: true)
        for directory in [configRoot, root, stagingRoot] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        }
        pruneStaleStaging(in: stagingRoot)
        let destination = availableDestination(root, safeSlug(id))
        let staging = stagingRoot.appendingPathComponent("import-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: staging.path)
            let atlasURL = staging.appendingPathComponent("spritesheet.png")
            try writeAtlas(images, mirrorRows: mirrorRows, to: atlasURL)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: atlasURL.path)
            let manifest: [String: Any] = [
                "id": destination.lastPathComponent, "displayName": name, "description": description,
                "spritesheetPath": "spritesheet.png", "spriteVersionNumber": 1, "adapter": "allpet-pet-model-v1",
                "sourceProject": declaredProject ?? kind.repositoryURL, "sourceLicense": declaredLicense ?? kind.licenseNotice,
                "sourcePath": source.path, "sourceMode": mode
            ]
            let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
            let manifestURL = staging.appendingPathComponent("pet.json")
            try data.write(to: manifestURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: manifestURL.path)
            _ = try PetBundle.load(from: staging)
            try FileManager.default.moveItem(at: staging, to: destination)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: destination.path)
            return try PetBundle.load(from: destination)
        } catch {
            try? FileManager.default.removeItem(at: staging)
            if let known = error as? PetModelImportError { throw known }
            throw PetModelImportError.installFailed(error.localizedDescription)
        }
    }

    private static func writeAtlas(_ images: [[CGImage]], mirrorRows: Set<Int>, to url: URL) throws {
        let width = columns * cellWidth, height = rows * cellHeight
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
            throw PetModelImportError.installFailed("无法创建透明图集")
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = graphics
        NSColor.clear.setFill()
        NSRect(x: 0, y: 0, width: width, height: height).fill(using: .copy)
        graphics.imageInterpolation = .high
        for row in 0..<rows {
            for column in 0..<columns {
                let frames = images[row]
                // Runtime plays only each state's declared prefix; unused columns repeat its final frame.
                let frame = frames[min(frames.count - 1, column)]
                let cell = NSRect(x: column * cellWidth, y: height - (row + 1) * cellHeight,
                                  width: cellWidth, height: cellHeight).insetBy(dx: 6, dy: 6)
                let scale = min(cell.width / CGFloat(frame.width), cell.height / CGFloat(frame.height))
                let size = NSSize(width: CGFloat(frame.width) * scale, height: CGFloat(frame.height) * scale)
                let target = NSRect(x: cell.midX - size.width / 2, y: cell.midY - size.height / 2,
                                    width: size.width, height: size.height)
                graphics.saveGraphicsState()
                if mirrorRows.contains(row) {
                    graphics.cgContext.translateBy(x: target.minX + target.maxX, y: 0)
                    graphics.cgContext.scaleBy(x: -1, y: 1)
                }
                NSImage(cgImage: frame, size: NSSize(width: frame.width, height: frame.height))
                    .draw(in: target, from: .zero, operation: .sourceOver, fraction: 1)
                graphics.restoreGraphicsState()
            }
        }
        NSGraphicsContext.restoreGraphicsState()
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw PetModelImportError.installFailed("图集 PNG 编码失败")
        }
        try data.write(to: url, options: .atomic)
    }

    private static func imageFrames(_ url: URL, targetFrameCount: Int, budget: DecodeBudget) throws -> [CGImage] {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else { throw PetModelImportError.unsafePath(url.path) }
        guard (values.fileSize ?? 0) <= maxAsset else { throw PetModelImportError.tooLarge(url) }
        if let source = CGImageSourceCreateWithURL(url as CFURL, nil) {
            let sourceCount = CGImageSourceGetCount(source)
            if sourceCount > 1_024 { throw PetModelImportError.tooLarge(url) }
            if sourceCount == 0 {
                // ImageIO can recognize vector containers without exposing raster frames; use bounded SVG fallback below.
            } else {
            let wanted = max(1, min(columns, targetFrameCount))
            let indices: [Int]
            if sourceCount == 1 || wanted == 1 {
                indices = [0]
            } else {
                indices = (0..<wanted).map { $0 * (sourceCount - 1) / (wanted - 1) }
            }
            var cache: [Int: CGImage] = [:]
            var result: [CGImage] = []
            for index in indices {
                if let cached = cache[index] { result.append(cached); continue }
                guard let props = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any],
                      let width = props[kCGImagePropertyPixelWidth] as? Int,
                      let height = props[kCGImagePropertyPixelHeight] as? Int else { continue }
                let (sourcePixels, overflow) = width.multipliedReportingOverflow(by: height)
                guard !overflow, width > 0, height > 0, width <= 16_384, height <= 16_384, sourcePixels <= maxPixels else {
                    throw PetModelImportError.tooLarge(url)
                }
                let options: [CFString: Any] = [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 512
                ]
                guard let frame = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary)
                    ?? CGImageSourceCreateImageAtIndex(source, index, nil) else { continue }
                try budget.consume(width: frame.width, height: frame.height, source: url)
                cache[index] = frame
                result.append(frame)
            }
            if !result.isEmpty { return result }
            }
        }
        if url.pathExtension.lowercased() == "svg", let image = NSImage(contentsOf: url) {
            var rect = NSRect(origin: .zero, size: image.size)
            if let frame = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) {
                let (pixels, overflow) = frame.width.multipliedReportingOverflow(by: frame.height)
                guard !overflow, pixels <= maxPixels else { throw PetModelImportError.tooLarge(url) }
                try budget.consume(width: frame.width, height: frame.height, source: url)
                return [frame]
            }
        }
        throw PetModelImportError.invalidImage(url)
    }

    private static func readTextManifest(_ url: URL) throws -> String {
        let v = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard v.isRegularFile == true, v.isSymbolicLink != true else { throw PetModelImportError.unsafePath(url.path) }
        guard (v.fileSize ?? 0) <= maxManifest else { throw PetModelImportError.tooLarge(url) }
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        guard let text = String(data: data, encoding: .utf8) else {
            throw PetModelImportError.invalidManifest("settings.yml 不是 UTF-8")
        }
        return text
    }

    private static func readObject(_ url: URL) throws -> [String: Any] {
        let v = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard v.isRegularFile == true, v.isSymbolicLink != true else { throw PetModelImportError.unsafePath(url.path) }
        guard (v.fileSize ?? 0) <= maxManifest else { throw PetModelImportError.tooLarge(url) }
        guard let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
            throw PetModelImportError.invalidManifest(url.path)
        }
        return object
    }

    private static func checkedInput(_ input: URL) throws -> URL {
        let url = input.standardizedFileURL
        let v = try url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard v.isSymbolicLink != true, v.isDirectory == true || v.isRegularFile == true else {
            throw PetModelImportError.unsafePath(url.path)
        }
        return URL(fileURLWithPath: url.path, isDirectory: v.isDirectory == true)
    }

    private static func checkedDirectory(_ input: URL, within boundary: URL? = nil) throws -> URL {
        let url = input.standardizedFileURL
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true,
              url.resolvingSymlinksInPath().path == url.path else {
            throw PetModelImportError.unsafePath(url.path)
        }
        if let boundary {
            let base = try checkedDirectory(boundary)
            guard url.path == base.path || url.path.hasPrefix(base.path + "/") else {
                throw PetModelImportError.unsafePath(url.path)
            }
        }
        return url
    }

    private static func checkedAsset(_ relative: String, in root: URL) throws -> URL {
        guard !relative.isEmpty, !relative.hasPrefix("/"), !relative.contains("\\") else {
            throw PetModelImportError.unsafePath(relative)
        }
        let parts = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard !parts.contains(".."), !parts.contains("."), !parts.contains("") else {
            throw PetModelImportError.unsafePath(relative)
        }
        let base = try checkedDirectory(root)
        var cursor = base
        for (index, part) in parts.enumerated() {
            cursor.appendPathComponent(String(part), isDirectory: index < parts.count - 1)
            let values = try cursor.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isSymbolicLink != true else { throw PetModelImportError.unsafePath(relative) }
            if index < parts.count - 1 {
                guard values.isDirectory == true else { throw PetModelImportError.missingAsset(relative) }
            } else {
                guard values.isRegularFile == true else { throw PetModelImportError.missingAsset(relative) }
                guard (values.fileSize ?? 0) <= maxAsset else { throw PetModelImportError.tooLarge(cursor) }
            }
        }
        let asset = cursor.standardizedFileURL
        guard asset.path.hasPrefix(base.path + "/"), asset.resolvingSymlinksInPath().path == asset.path else {
            throw PetModelImportError.unsafePath(relative)
        }
        return asset
    }

    private static func safeImages(in directory: URL) throws -> [URL] {
        let d = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard d.isDirectory == true, d.isSymbolicLink != true else { throw PetModelImportError.unsafePath(directory.path) }
        let allowed = Set(["png", "webp", "jpg", "jpeg", "gif", "apng"])
        let urls = try FileManager.default.contentsOfDirectory(at: directory,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey], options: [.skipsHiddenFiles])
            .filter { allowed.contains($0.pathExtension.lowercased()) }
        guard urls.count <= 128 else { throw PetModelImportError.tooLarge(directory) }
        return try urls.filter { url in
            let v = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            return v.isRegularFile == true && v.isSymbolicLink != true && (v.fileSize ?? 0) <= maxAsset
        }.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
    }

    private static func hasSettings(_ directory: URL) -> Bool {
        ["settings.yml", "settings.yaml"].contains { name in
            let url = directory.appendingPathComponent(name)
            guard let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]) else { return false }
            return v.isRegularFile == true && v.isSymbolicLink != true && (v.fileSize ?? 0) <= maxManifest
        }
    }

    private static func preferredTheme(in root: URL) -> URL? {
        let themes = root.lastPathComponent == "themes" ? root : root.appendingPathComponent("themes", isDirectory: true)
        for name in ["clawd", "cloudling", "calico"] {
            let candidate = themes.appendingPathComponent(name, isDirectory: true)
            if FileManager.default.fileExists(atPath: candidate.appendingPathComponent("theme.json").path) { return candidate }
        }
        guard let dirs = try? FileManager.default.contentsOfDirectory(at: themes, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) else { return nil }
        return dirs.sorted { $0.lastPathComponent < $1.lastPathComponent }
            .first { FileManager.default.fileExists(atPath: $0.appendingPathComponent("theme.json").path) }
    }

    private static func clawdRoot(from directory: URL, within boundary: URL) throws -> URL? {
        let boundary = try checkedDirectory(boundary)
        var current = try checkedDirectory(directory, within: boundary)
        for _ in 0..<6 {
            let candidate = current.appendingPathComponent("assets/gif", isDirectory: true)
            if FileManager.default.fileExists(atPath: candidate.path) {
                _ = try checkedDirectory(candidate, within: boundary)
                return current
            }
            if current.path == boundary.path { break }
            let parent = current.deletingLastPathComponent()
            guard parent.path == boundary.path || parent.path.hasPrefix(boundary.path + "/") else { break }
            current = parent
        }
        return nil
    }

    private static func yamlName(_ text: String) -> String? {
        for line in text.split(separator: "\n", omittingEmptySubsequences: false).prefix(500) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            for key in ["display_name:", "ai_name:", "title:", "name:", "character_name:"] where trimmed.lowercased().hasPrefix(key) {
                let value = trimmed.dropFirst(key.count).trimmingCharacters(in: .whitespaces)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                if !value.isEmpty { return value }
            }
        }
        return nil
    }

    private static func safeSlug(_ input: String) -> String {
        let text = input.folding(options: [.diacriticInsensitive, .widthInsensitive], locale: .current).lowercased()
        let slug = text.replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return String((slug.isEmpty ? "imported-pet" : slug).prefix(64))
    }

    private static func pruneStaleStaging(in root: URL, now: Date = Date()) {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        for url in urls.prefix(128) where url.lastPathComponent.hasPrefix("import-") {
            guard let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey]),
                  values.isDirectory == true, values.isSymbolicLink != true,
                  url.standardizedFileURL.resolvingSymlinksInPath().path == url.standardizedFileURL.path,
                  let modified = values.contentModificationDate, now.timeIntervalSince(modified) > 86_400 else { continue }
            try? FileManager.default.removeItem(at: url)
        }
    }

    private static func availableDestination(_ root: URL, _ id: String) -> URL {
        for number in 1...9_999 {
            let name = number == 1 ? id : "\(id)-\(number)"
            let url = root.appendingPathComponent(name, isDirectory: true)
            if !FileManager.default.fileExists(atPath: url.path) { return url }
        }
        return root.appendingPathComponent("\(id)-\(UUID().uuidString.lowercased())", isDirectory: true)
    }
}
