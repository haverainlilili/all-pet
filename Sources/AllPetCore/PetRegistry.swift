import Foundation

/// 一个可直接安装的 GitHub 宠物预设。素材只会在用户机器上运行时拉取，不随 AllPet 分发。
public struct PetPreset: Codable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var repositoryURL: String
    public var kind: PetModelSourceKind
    public var entrypointHint: String
    public var description: String
    public var licenseNotice: String

    public init(id: String, name: String, repositoryURL: String, kind: PetModelSourceKind,
                entrypointHint: String, description: String, licenseNotice: String) {
        self.id = id
        self.name = name
        self.repositoryURL = repositoryURL
        self.kind = kind
        self.entrypointHint = entrypointHint
        self.description = description
        self.licenseNotice = licenseNotice
    }
}

/// 内置的「热门项目宠物」注册表：一条命令即可从对应 GitHub 仓库安装为默认宠物。
public enum PetRegistry {
    public static let presets: [PetPreset] = [
        PetPreset(
            id: "cc-haha",
            name: "cc-haha",
            repositoryURL: "https://github.com/NanmiCoder/cc-haha",
            kind: .ccHaha,
            entrypointHint: "pet.json",
            description: "Claude Code 桌面宠物的 cc-haha 包（Codex 图集格式）。",
            licenseNotice: "代码 MIT；宠物素材仍以原作者授权为准"
        ),
        PetPreset(
            id: "clawd-on-desk",
            name: "clawd-on-desk",
            repositoryURL: "https://github.com/rullerzhou-afk/clawd-on-desk",
            kind: .clawdOnDesk,
            entrypointHint: "theme.json",
            description: "clawd-on-desk 的 theme.json 主题（clawd / cloudling / calico）。",
            licenseNotice: "AGPL-3.0；仅消费用户本地素材，不随 AllPet 分发"
        ),
        PetPreset(
            id: "lingchat",
            name: "LingChat",
            repositoryURL: "https://github.com/SlimeBoyOwO/LingChat",
            kind: .lingChat,
            entrypointHint: "settings.yml",
            description: "LingChat 角色包（settings.yml + avatar 表情）。",
            licenseNotice: "AGPL-3.0；角色、Live2D 模型及 Cubism 授权独立"
        )
    ]

    /// 按预设 id（忽略大小写/下划线/连字符）或 GitHub 仓库 URL 匹配预设。
    public static func preset(matching input: String) -> PetPreset? {
        let key = normalizedKey(input)
        if let byID = presets.first(where: { normalizedKey($0.id) == key }) { return byID }
        if let byName = presets.first(where: { normalizedKey($0.name) == key }) { return byName }
        if let byRepo = presets.first(where: { normalizedKey($0.repositoryURL) == key
            || $0.repositoryURL.localizedCaseInsensitiveContains(input) }) {
            return byRepo
        }
        return nil
    }

    /// 在克隆出来的仓库目录里找到该预设的入口文件（pet.json / theme.json / settings.yml）。
    public static func entrypoint(in root: URL, kind: PetModelSourceKind) -> URL? {
        let files = candidateFiles(in: root)
        switch kind {
        case .clawdOnDesk:
            return files.filter { $0.lastPathComponent == "theme.json" }.sorted { a, b in
                rankClawdTheme(a) > rankClawdTheme(b)
            }.first
        case .lingChat:
            return files.first { $0.lastPathComponent == "settings.yml" || $0.lastPathComponent == "settings.yaml" }
        case .ccHaha:
            return files.filter { $0.lastPathComponent == "pet.json" }.sorted { a, b in
                rankPetJSON(a) > rankPetJSON(b)
            }.first
        case .codexAtlas:
            return files.filter { $0.lastPathComponent == "pet.json" }.sorted { a, b in
                rankPetJSON(a) > rankPetJSON(b)
            }.first
        case .localSingleImage:
            return files.first { $0.lastPathComponent == "pet.json" }
        }
    }

    private static func rankPetJSON(_ url: URL) -> Int {
        let path = url.deletingLastPathComponent().path.lowercased()
        if path.contains("/pets/") || path.hasSuffix("/pets") { return 3 }
        if path.contains("/pet/") { return 2 }
        if path.hasSuffix("/assets") { return 1 }
        return 0
    }

    private static func rankClawdTheme(_ url: URL) -> Int {
        let parent = url.deletingLastPathComponent().lastPathComponent.lowercased()
        if parent == "clawd" { return 3 }
        if parent == "cloudling" || parent == "calico" { return 2 }
        return 1
    }

    private static func normalizedKey(_ value: String) -> String {
        value.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
            .replacingOccurrences(of: "www.", with: "")
            .replacingOccurrences(of: ".git", with: "")
            .replacingOccurrences(of: "github.com/", with: "")
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: "_", with: "-")
    }

    /// 有界遍历仓库，收集可能的入口文件。拒绝符号链接逃逸。
    private static func candidateFiles(in root: URL) -> [URL] {
        let names: Set<String> = ["pet.json", "theme.json", "settings.yml", "settings.yaml"]
        guard let enumerator = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }

        var result: [URL] = []
        var visited = 0
        for case let url as URL in enumerator {
            visited += 1
            guard visited <= 2_048 else { break }
            let rel = url.path.hasPrefix(root.path + "/") ? String(url.path.dropFirst(root.path.count + 1)) : ""
            guard rel.split(separator: "/").count <= 8 else { continue }
            guard names.contains(url.lastPathComponent) else { continue }
            guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
                  values.isRegularFile == true, values.isSymbolicLink != true,
                  url.standardizedFileURL.resolvingSymlinksInPath().path == url.standardizedFileURL.path,
                  (values.fileSize ?? 0) <= 262_144 else { continue }
            result.append(url)
        }
        return result
    }
}
