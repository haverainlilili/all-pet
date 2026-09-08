import Foundation

/// 内置「默认宠物」目录中的一项：开箱即可一键安装的社区宠物。
/// 素材只会在用户机器上运行时按需从远程源拉取，不随 AllPet 分发。
public struct DefaultPet: Sendable, Equatable {
    public var slug: String
    public var displayName: String
    public var source: RemotePetSource

    public init(slug: String, displayName: String, source: RemotePetSource = .petdex) {
        self.slug = slug
        self.displayName = displayName
        self.source = source
    }

    /// 可直接粘贴进安装输入框 / `pet install` 的官方命令。
    public var installCommand: String {
        switch source {
        case .petdex: "petdex install \(slug)"
        case .awesomeCodexPet: slug
        }
    }

    /// 该宠物在官方目录中的详情页地址。
    public var pageURL: String {
        switch source {
        case .petdex: "https://petdex.dev/pets/\(slug)"
        case .awesomeCodexPet: "https://github.com/legeling/awesome-codex-pet/tree/main/pets/\(slug)"
        }
    }
}

/// 开箱默认宠物目录：让常用社区宠物无需手动记命令即可安装。
public enum DefaultPets {
    public static let catalog: [DefaultPet] = [
        DefaultPet(slug: "hoops", displayName: "Hoops"),
        DefaultPet(slug: "nai-long-2", displayName: "奶龙"),
        DefaultPet(slug: "doraemon", displayName: "Doraemon"),
        DefaultPet(slug: "lulu-capybara-2", displayName: "噜噜"),
        DefaultPet(slug: "tiko", displayName: "Tiko"),
        DefaultPet(slug: "wangcai", displayName: "Wangcai"),
        DefaultPet(slug: "hachiware-2", displayName: "小八"),
        DefaultPet(slug: "deepseek", displayName: "deepseek酱")
    ]

    /// 按 slug、显示名或官方命令匹配默认宠物（忽略大小写/连字符/空格/下划线）。
    public static func match(_ input: String) -> DefaultPet? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // 先让官方命令（如 `petdex install hoops`）命中，再退回裸 slug/显示名匹配。
        if let remoteMatch = PetRemoteSourceResolver.parse(trimmed), remoteMatch.source == .petdex {
            return catalog.first { $0.slug == remoteMatch.slug }
        }

        let key = normalizedKey(trimmed)
        return catalog.first {
            normalizedKey($0.slug) == key || normalizedKey($0.displayName) == key
        }
    }

    private static func normalizedKey(_ value: String) -> String {
        value.folding(options: [.diacriticInsensitive, .widthInsensitive], locale: .current)
            .lowercased()
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: "_", with: "")
    }
}
