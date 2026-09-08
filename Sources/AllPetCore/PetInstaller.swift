import Foundation

public struct PetInstallOutcome: Sendable {
    public var preset: PetPreset?
    public var repositoryURL: String
    public var sourceKind: PetModelSourceKind
    public var bundle: PetBundle
    public var installedBundles: [PetBundle]
    public var note: String
}

public enum PetInstallError: Error, LocalizedError {
    case unresolvedSource(String)
    case gitUnavailable
    case cloneFailed(String)
    case noEntrypoint(String)
    case unsafeSourcePath(String)
    case downloadFailed(String, String)

    public var errorDescription: String? {
        switch self {
        case .unresolvedSource(let s): "无法识别的宠物来源：\(s)"
        case .gitUnavailable: "未找到 git，无法从 GitHub 安装宠物"
        case .cloneFailed(let s): "克隆仓库失败：\(s)"
        case .noEntrypoint(let s): "仓库里未找到可导入的宠物入口（pet.json / theme.json / settings.yml）：\(s)"
        case .unsafeSourcePath(let s): "拒绝不安全的来源路径：\(s)"
        case .downloadFailed(let s, let reason): "下载宠物失败（\(s)）：\(reason)"
        }
    }
}

/// 从 GitHub 仓库（内置预设或任意 URL）浅克隆到本地缓存，再复用 PetModelImporter 导入为默认宠物。
/// 只拉取用户明确选择的素材，不内置或重新分发第三方宠物。
public enum PetInstaller {
    public static func install(source: String, home: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> PetInstallOutcome {
        if let match = PetRemoteSourceResolver.parse(source) {
            return try installRemote(match: match, home: home)
        }
        // 内置默认宠物：支持裸 slug / 显示名直接安装（如 `hoops`、`奶龙`）。
        if let defaultPet = DefaultPets.match(source) {
            return try installRemote(
                match: RemotePetSourceMatch(source: defaultPet.source, slug: defaultPet.slug),
                home: home
            )
        }

        let preset = PetRegistry.preset(matching: source)
        let repoURL: String
        let kind: PetModelSourceKind
        if let preset {
            repoURL = preset.repositoryURL
            kind = preset.kind
        } else if source.hasPrefix("https://") || source.hasPrefix("git@") || source.hasPrefix("http://") {
            repoURL = source
            kind = .codexAtlas
        } else {
            throw PetInstallError.unresolvedSource(source)
        }

        let slug = preset?.id ?? Self.slug(from: repoURL)
        let cacheRoot = home.appendingPathComponent(".config/all-pet/pet-sources", isDirectory: true)
        try FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
        let destination = cacheRoot.appendingPathComponent(slug, isDirectory: true)
        try clone(repositoryURL: repoURL, to: destination)

        let imported: [PetModelImportResult]
        if kind == .ccHaha {
            imported = try importCcHahaSpritesheets(in: destination, home: home)
        } else {
            guard let entrypoint = PetRegistry.entrypoint(in: destination, kind: kind) else {
                throw PetInstallError.noEntrypoint(destination.path)
            }
            if kind == .lingChat {
                try hydrateLingChatLFSAssets(entrypoint: entrypoint, repositoryRoot: destination, repositoryURL: repoURL)
            }
            imported = [try PetModelImporter.importModel(from: entrypoint, home: home)]
        }
        guard let primary = imported.first else { throw PetInstallError.noEntrypoint(destination.path) }
        return PetInstallOutcome(
            preset: preset,
            repositoryURL: repoURL,
            sourceKind: primary.sourceKind,
            bundle: primary.bundle,
            installedBundles: imported.map(\.bundle),
            note: imported.count > 1 ? "已导入 \(imported.count) 个宠物；当前使用 \(primary.bundle.manifest.displayName)" : primary.note
        )
    }

    private static func installRemote(match: RemotePetSourceMatch, home: URL) throws -> PetInstallOutcome {
        let bundle = try PetRemoteSourceInstaller.install(match: match, home: home)
        return PetInstallOutcome(
            preset: nil,
            repositoryURL: match.source.repositoryURL,
            sourceKind: .codexAtlas,
            bundle: bundle,
            installedBundles: [bundle],
            note: "已从 \(match.source.label) 安装宠物「\(bundle.manifest.displayName)」"
        )
    }

    private static func hydrateLingChatLFSAssets(entrypoint: URL, repositoryRoot: URL, repositoryURL: String) throws {
        let avatar = entrypoint.deletingLastPathComponent().appendingPathComponent("avatar", isDirectory: true)
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: avatar, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        let pointers = files.filter { isLFSPointer($0) }
        guard !pointers.isEmpty else { return }
        guard let commit = gitOutput(arguments: ["-C", repositoryRoot.path, "rev-parse", "HEAD"]),
              let repository = githubRepositoryParts(repositoryURL) else {
            throw PetInstallError.cloneFailed("无法解析 LingChat Git LFS 资源地址")
        }
        for pointer in pointers.prefix(128) {
            let relative = String(pointer.path.dropFirst(repositoryRoot.path.count + 1))
            var components = URLComponents()
            components.scheme = "https"
            components.host = "media.githubusercontent.com"
            components.path = "/media/\(repository.owner)/\(repository.name)/\(commit)/\(relative)"
            guard let remote = components.url else { throw PetInstallError.unsafeSourcePath(relative) }
            let temporary = pointer.deletingLastPathComponent().appendingPathComponent(".allpet-lfs-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: temporary) }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
            process.arguments = ["-L", "--fail", "--silent", "--show-error", "--max-time", "120", "-o", temporary.path, remote.absoluteString]
            let pipe = Pipe()
            process.standardError = pipe
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0, !isLFSPointer(temporary),
                  let size = try? temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0, size <= 128 * 1_024 * 1_024 else {
                let message = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "下载失败"
                throw PetInstallError.cloneFailed("LingChat 素材下载失败：\(message.trimmingCharacters(in: .whitespacesAndNewlines))")
            }
            try FileManager.default.removeItem(at: pointer)
            try FileManager.default.moveItem(at: temporary, to: pointer)
        }
    }

    private static func isLFSPointer(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true, (values.fileSize ?? 0) <= 1_024,
              let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else { return false }
        return text.hasPrefix("version https://git-lfs.github.com/spec/v1")
    }

    private static func gitOutput(arguments: [String]) -> String? {
        guard let git = findGit() else { return nil }
        let process = Process()
        process.executableURL = git
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        guard (try? process.run()) != nil else { return nil }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func githubRepositoryParts(_ input: String) -> (owner: String, name: String)? {
        let cleaned = input.replacingOccurrences(of: "git@github.com:", with: "https://github.com/")
            .replacingOccurrences(of: ".git", with: "")
        guard let url = URL(string: cleaned), url.host == "github.com" else { return nil }
        let parts = url.path.split(separator: "/")
        guard parts.count >= 2 else { return nil }
        return (String(parts[0]), String(parts[1]))
    }

    private static func importCcHahaSpritesheets(in root: URL, home: URL) throws -> [PetModelImportResult] {
        let names: [String: String] = [
            "dada-code": "搭搭 Dada", "huhu-plan": "弧弧 Huhu",
            "bubu-fix": "补补 Bubu", "huihui-build": "回回 Huihui"
        ]
        guard let enumerator = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { throw PetInstallError.noEntrypoint(root.path) }
        var sheets: [URL] = []
        var visited = 0
        for case let url as URL in enumerator {
            visited += 1
            guard visited <= 8_000 else { break }
            guard url.lastPathComponent == "spritesheet.webp",
                  url.path.lowercased().contains("/assets/pets/"),
                  let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
                  values.isRegularFile == true, values.isSymbolicLink != true,
                  (values.fileSize ?? 0) <= 128 * 1_024 * 1_024 else { continue }
            sheets.append(url)
        }
        guard !sheets.isEmpty else { throw PetInstallError.noEntrypoint(root.path) }
        let preferred = ["dada-code", "huhu-plan", "bubu-fix", "huihui-build"]
        sheets.sort { a, b in
            let ai = preferred.firstIndex(of: a.deletingLastPathComponent().lastPathComponent) ?? .max
            let bi = preferred.firstIndex(of: b.deletingLastPathComponent().lastPathComponent) ?? .max
            return ai == bi ? a.path < b.path : ai < bi
        }
        var imported: [PetModelImportResult] = []
        for sheet in sheets.prefix(32) {
            let dir = sheet.deletingLastPathComponent()
            let id = dir.lastPathComponent
            let manifest: [String: Any] = [
                "id": "cc-haha-\(id)",
                "displayName": names[id] ?? id,
                "description": "cc-haha 内置宠物",
                "spritesheetPath": sheet.lastPathComponent,
                "sourceProject": "https://github.com/NanmiCoder/cc-haha",
                "sourceLicense": PetModelSourceKind.ccHaha.licenseNotice
            ]
            let manifestURL = dir.appendingPathComponent("pet.json")
            try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
                .write(to: manifestURL, options: .atomic)
            imported.append(try PetModelImporter.importModel(from: manifestURL, home: home))
        }
        return imported
    }

    private static func clone(repositoryURL: String, to destination: URL) throws {
        guard let git = findGit() else { throw PetInstallError.gitUnavailable }
        if FileManager.default.fileExists(atPath: destination.path) {
            try? FileManager.default.removeItem(at: destination)
        }
        let process = Process()
        process.executableURL = git
        process.arguments = ["clone", "--depth", "1", "--single-branch", repositoryURL, destination.path]
        process.currentDirectoryURL = destination.deletingLastPathComponent()

        let pipe = Pipe()
        process.standardError = pipe
        process.standardOutput = pipe
        do {
            try process.run()
        } catch {
            throw PetInstallError.gitUnavailable
        }
        // 有限等待，避免克隆挂起。
        let deadline = Date().addingTimeInterval(180)
        while process.isRunning {
            if Date() >= deadline {
                process.terminate()
                throw PetInstallError.cloneFailed("克隆超时（>180s）")
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        guard process.terminationStatus == 0 else {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let message = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            throw PetInstallError.cloneFailed(message ?? "git 返回非零退出码")
        }
    }

    private static func findGit() -> URL? {
        for path in ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"] {
            let url = URL(fileURLWithPath: path)
            if FileManager.default.isExecutableFile(atPath: url.path) { return url }
        }
        return nil
    }

    private static func slug(from repositoryURL: String) -> String {
        let cleaned = repositoryURL
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
            .replacingOccurrences(of: "git@", with: "")
            .replacingOccurrences(of: ".git", with: "")
            .replacingOccurrences(of: "github.com/", with: "")
            .replacingOccurrences(of: ":", with: "/")
        let components = cleaned.split(separator: "/").suffix(2).joined(separator: "-")
        let folded = components.folding(options: [.diacriticInsensitive, .widthInsensitive], locale: .current).lowercased()
        let slug = folded.replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return String((slug.isEmpty ? "pet-source" : slug).prefix(64))
    }
}
