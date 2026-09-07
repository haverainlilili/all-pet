import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// 远程宠物源：无需 git clone，直接下载 `pet.json` + 精灵图即可安装的社区目录。
public enum RemotePetSource: String, CaseIterable, Sendable {
    case awesomeCodexPet
    case petdex

    public var label: String {
        switch self {
        case .awesomeCodexPet: "Awesome Codex Pet"
        case .petdex: "Petdex"
        }
    }

    public var repositoryURL: String {
        switch self {
        case .awesomeCodexPet: "https://github.com/legeling/awesome-codex-pet"
        case .petdex: "https://github.com/crafter-station/petdex"
        }
    }

    /// 在安装输入框中可直接粘贴的官方命令示例。
    public var usageHint: String {
        switch self {
        case .awesomeCodexPet: "firefly--lingxiaotian"
        case .petdex: "petdex install boba"
        }
    }
}

public struct RemotePetSourceMatch: Sendable {
    public var source: RemotePetSource
    public var slug: String
}

/// 把用户输入识别为某个远程源的官方命令。
public enum PetRemoteSourceResolver {

    public static func parse(_ input: String) -> RemotePetSourceMatch? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // 先剥掉可选的 npx 前缀。
        var command = trimmed
        for prefix in ["npx -y ", "npx "] {
            if command.lowercased().hasPrefix(prefix) {
                command = String(command.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
                break
            }
        }

        let lower = command.lowercased()
        if lower.hasPrefix("petdex") {
            let rest = String(command.dropFirst("petdex".count))
            let cleaned = rest.first == ":" ? String(rest.dropFirst()) : rest
            if let slug = slug(fromTokens: cleaned) {
                return RemotePetSourceMatch(source: .petdex, slug: slug)
            }
            return nil
        }

        if lower.hasPrefix("awesome-codex-pet") {
            let rest = String(command.dropFirst("awesome-codex-pet".count))
            let cleaned = rest.first == ":" ? String(rest.dropFirst()) : rest
            if let slug = slug(fromTokens: cleaned) {
                return RemotePetSourceMatch(source: .awesomeCodexPet, slug: slug)
            }
            return nil
        }

        // 裸 slug：awesome-codex-pet 的 pet id 形如 `<name>--<author>`。
        if !trimmed.contains(" "), trimmed.contains("--"), !trimmed.contains("://") {
            return RemotePetSourceMatch(source: .awesomeCodexPet, slug: trimmed)
        }

        return nil
    }

    private static func slug(fromTokens input: String) -> String? {
        let excluded: Set<String> = ["install", "petdex", "awesome-codex-pet", "npx"]
        guard let token = input.split(separator: " ").map(String.init).first(where: { token in
            let t = token.lowercased()
            return !t.hasPrefix("-") && !excluded.contains(t)
        }) else { return nil }
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// 从远程源下载并安装为 Codex 图集宠物。
public enum PetRemoteSourceInstaller {

    private struct PetdexPet {
        var slug: String
        var petJsonURL: URL
        var spritesheetURL: URL
    }

    public static func install(match: RemotePetSourceMatch, home: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> PetBundle {
        switch match.source {
        case .awesomeCodexPet:
            return try installAwesome(slug: match.slug, home: home)
        case .petdex:
            return try installPetdex(slug: match.slug, home: home)
        }
    }

    // MARK: - Awesome Codex Pet

    private static func installAwesome(slug: String, home: URL) throws -> PetBundle {
        let rawBase = "https://raw.githubusercontent.com/legeling/awesome-codex-pet/main"
        guard let petJSONURL = URL(string: "\(rawBase)/pets/\(slug)/pet.json") else {
            throw PetInstallError.downloadFailed(slug, "无效的宠物地址")
        }
        let petJSONData = try download(petJSONURL, maxBytes: 256 * 1_024, allowedHosts: ["raw.githubusercontent.com"])
        let spritesheetName = spritesheetName(fromPetJSON: petJSONData) ?? "spritesheet.webp"
        guard let spritesheetURL = URL(string: "\(rawBase)/pets/\(slug)/\(spritesheetName)") else {
            throw PetInstallError.downloadFailed(slug, "无效的精灵图地址")
        }
        let spritesheetData = try download(spritesheetURL, maxBytes: 128 * 1_024 * 1_024, allowedHosts: ["raw.githubusercontent.com"])
        return try installFiles(
            slug: slug, petJSON: petJSONData, spritesheet: spritesheetData,
            spritesheetName: spritesheetName, home: home
        )
    }

    // MARK: - Petdex

    private static func installPetdex(slug: String, home: URL) throws -> PetBundle {
        let base = "https://petdex.dev"
        let pet = try petdexPet(slug: slug, base: base)
        let petJSONData = try download(pet.petJsonURL, maxBytes: 256 * 1_024, allowedHosts: ["assets.petdex.dev"])
        let spritesheetName = spritesheetName(fromPetJSON: petJSONData)
            ?? (pet.spritesheetURL.pathExtension.isEmpty ? "spritesheet.webp" : "spritesheet.\(pet.spritesheetURL.pathExtension)")
        let spritesheetData = try download(pet.spritesheetURL, maxBytes: 128 * 1_024 * 1_024, allowedHosts: ["assets.petdex.dev"])
        return try installFiles(
            slug: slug, petJSON: petJSONData, spritesheet: spritesheetData,
            spritesheetName: spritesheetName, home: home
        )
    }

    private static func petdexPet(slug: String, base: String) throws -> PetdexPet {
        for manifestPath in ["/api/manifest/v2", "/api/manifest"] {
            guard let url = URL(string: "\(base)\(manifestPath)"),
                  let object = try? fetchJSON(url, maxBytes: 32 * 1_024 * 1_024) else { continue }
            if let pet = parsePetdexManifest(object, assetBase: object["assetBase"] as? String, slug: slug) {
                return pet
            }
        }
        throw PetInstallError.downloadFailed(slug, "在 Petdex 目录中未找到该宠物")
    }

    private static func parsePetdexManifest(_ object: [String: Any], assetBase: String?, slug: String) -> PetdexPet? {
        if (object["v"] as? Int) == 2, let pets = object["pets"] as? [[Any]] {
            for pet in pets where pet.count == 8 {
                guard let petSlug = pet[0] as? String, petSlug == slug,
                      let spritesheetRaw = pet[4] as? String,
                      let petJSONRaw = pet[5] as? String,
                      let spritesheetURL = resolve(spritesheetRaw, assetBase: assetBase),
                      let petJSONURL = resolve(petJSONRaw, assetBase: assetBase) else { continue }
                return PetdexPet(slug: slug, petJsonURL: petJSONURL, spritesheetURL: spritesheetURL)
            }
            return nil
        }
        if let pets = object["pets"] as? [[String: Any]] {
            for pet in pets {
                guard let petSlug = pet["slug"] as? String, petSlug == slug,
                      let spritesheetRaw = pet["spritesheetUrl"] as? String,
                      let petJSONRaw = pet["petJsonUrl"] as? String,
                      let spritesheetURL = resolve(spritesheetRaw, assetBase: nil),
                      let petJSONURL = resolve(petJSONRaw, assetBase: nil) else { continue }
                return PetdexPet(slug: slug, petJsonURL: petJSONURL, spritesheetURL: spritesheetURL)
            }
        }
        return nil
    }

    private static func resolve(_ raw: String, assetBase: String?) -> URL? {
        if let url = URL(string: raw), url.scheme != nil { return url }
        if let assetBase {
            let baseString = assetBase.hasSuffix("/") ? assetBase : assetBase + "/"
            if let base = URL(string: baseString) {
                return URL(string: raw, relativeTo: base)?.absoluteURL
            }
        }
        return nil
    }

    // MARK: - Shared install helpers

    private static func spritesheetName(fromPetJSON data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let path = object["spritesheetPath"] as? String else { return nil }
        let name = (path as NSString).lastPathComponent
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\\") else { return nil }
        return name
    }

    private static func installFiles(
        slug: String, petJSON: Data, spritesheet: Data, spritesheetName: String, home: URL
    ) throws -> PetBundle {
        let root = home.appendingPathComponent(".config/all-pet/pets", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let destination = root.appendingPathComponent(sanitizeSlug(slug), isDirectory: true)
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: destination.path)
        try petJSON.write(to: destination.appendingPathComponent("pet.json"), options: .atomic)
        try spritesheet.write(to: destination.appendingPathComponent(spritesheetName), options: .atomic)
        return try PetBundle.load(from: destination)
    }

    private static func sanitizeSlug(_ input: String) -> String {
        let folded = input.folding(options: [.diacriticInsensitive, .widthInsensitive], locale: .current).lowercased()
        let slug = folded.replacingOccurrences(of: "[^a-z0-9._-]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-."))
        return String((slug.isEmpty ? "remote-pet" : slug).prefix(96))
    }

    // MARK: - Networking

    private static func fetchJSON(_ url: URL, maxBytes: Int) throws -> [String: Any] {
        let data = try download(url, maxBytes: maxBytes, allowedHosts: ["petdex.dev", "assets.petdex.dev", "raw.githubusercontent.com"])
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw PetInstallError.downloadFailed(url.absoluteString, "返回内容不是 JSON")
        }
        return object
    }

    private static func download(_ url: URL, maxBytes: Int, allowedHosts: Set<String>) throws -> Data {
        guard url.scheme == "https", let host = url.host, allowedHosts.contains(host) else {
            throw PetInstallError.downloadFailed(url.absoluteString, "不允许的下载地址")
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("allpet/1.0", forHTTPHeaderField: "User-Agent")
        if host == "assets.petdex.dev" {
            request.setValue("https://petdex.dev/", forHTTPHeaderField: "Referer")
        }

        let semaphore = DispatchSemaphore(value: 0)
        var result: Data?
        var failure: Error?
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                failure = error
            } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                failure = PetInstallError.downloadFailed(url.absoluteString, "HTTP \(http.statusCode)")
            } else if let data, !data.isEmpty, data.count <= maxBytes {
                result = data
            } else {
                failure = PetInstallError.downloadFailed(url.absoluteString, "文件为空或超出大小限制")
            }
            semaphore.signal()
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + 60)
        task.cancel()
        if let result { return result }
        throw failure ?? PetInstallError.downloadFailed(url.absoluteString, "下载超时")
    }
}
