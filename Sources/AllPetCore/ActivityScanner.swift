import Foundation

/// 一次目录/文件扫描结果。
public struct ScanResult: Sendable {
    public var newestPath: String?
    public var newestMtime: Date?
    public var recentCount: Int = 0

    public init() {}
}

/// 活动检测工具：递归扫描目录、读文件尾部、按日志文本识别错误、解析 JSON 字段。
public enum ActivityScanner {

    /// 扫描一组根路径（目录递归 / 文件直接），返回最近修改文件与「recentWindow 内」文件数。
    public static func scan(
        roots: [String],
        isIncluded: (String) -> Bool,
        recentWindow: TimeInterval,
        now: Date
    ) -> ScanResult {
        var result = ScanResult()
        let fm = FileManager.default

        for root in roots {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: root, isDirectory: &isDir) else { continue }

            var filePaths: [String] = []
            if isDir.boolValue {
                guard let enumerator = fm.enumerator(atPath: root) else { continue }
                for case let rel as String in enumerator {
                    if rel.hasPrefix(".") { continue }
                    let full = root.hasSuffix("/") ? root + rel : root + "/" + rel
                    filePaths.append(full)
                }
            } else {
                filePaths = [root]
            }

            for path in filePaths {
                guard isIncluded(path) else { continue }
                guard let attrs = try? fm.attributesOfItem(atPath: path),
                      let mtime = attrs[.modificationDate] as? Date else { continue }

                if result.newestMtime == nil || mtime > result.newestMtime! {
                    result.newestMtime = mtime
                    result.newestPath = path
                }
                if now.timeIntervalSince(mtime) <= recentWindow {
                    result.recentCount += 1
                }
            }
        }
        return result
    }

    /// 读取文件末尾最多 `maxBytes` 字节（文本）。
    public static func readTail(_ path: String, maxBytes: Int = 32_768) -> String {
        guard let handle = FileHandle(forReadingAtPath: path) else { return "" }
        defer { try? handle.close() }

        let size: UInt64
        do {
            size = try handle.seekToEnd()
        } catch {
            return ""
        }
        let readLen = min(UInt64(maxBytes), size)
        let offset = size - readLen
        do {
            try handle.seek(toOffset: offset)
            guard let data = try handle.read(upToCount: Int(readLen)) else { return "" }
            return String(data: data, encoding: .utf8) ?? ""
        } catch {
            return ""
        }
    }

    /// 提取文本中最后一个 `"name":"value"` 字段值（最多 80 字符）。
    public static func lastJSONStringField(_ name: String, in text: String) -> String? {
        let pattern = "\"" + name + "\"\\s*:\\s*\"([^\"]{0,80})\""
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let ns = text as NSString
        let range = NSRange(location: 0, length: ns.length)
        let matches = regex.matches(in: text, range: range)
        guard let last = matches.last, last.numberOfRanges > 1 else { return nil }
        return ns.substring(with: last.range(at: 1))
    }

    /// 粗粒度错误识别（跨平台日志尾部文本）。
    public static func containsError(_ text: String) -> Bool {
        let lower = text.lowercased()
        if lower.contains("\"lvl\":\"error\"") { return true }
        if lower.contains("\"is_error\":true") { return true }
        if lower.contains("\"is_error\": true") { return true }
        if lower.contains("\"type\":\"error\"") { return true }
        if lower.contains("\"kind\":\"error\"") { return true }
        return false
    }
}
