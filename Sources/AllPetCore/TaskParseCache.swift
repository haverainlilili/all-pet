import Foundation

struct ParsedLogTail: Sendable {
    var text: String
    var task: ParsedTask
}

/// 按「路径 + mtime + 大小 + 解析变体」缓存文本日志尾部和解析结果。
final class TaskParseCache: @unchecked Sendable {
    private let lock = NSLock()
    private var path: String?
    private var mtime: Date?
    private var size: UInt64 = 0
    private var variant = ""
    private var value: ParsedLogTail?

    func parse(
        path: String,
        mtime: Date,
        size: UInt64,
        variant: String = "",
        maxBytes: Int,
        parser: (String) -> ParsedTask
    ) -> ParsedLogTail {
        lock.lock()
        if self.path == path,
           self.mtime == mtime,
           self.size == size,
           self.variant == variant,
           let value {
            lock.unlock()
            return value
        }
        lock.unlock()

        let text = ActivityScanner.readTail(path, maxBytes: maxBytes)
        let parsed = ParsedLogTail(text: text, task: parser(text))

        lock.lock()
        self.path = path
        self.mtime = mtime
        self.size = size
        self.variant = variant
        self.value = parsed
        lock.unlock()
        return parsed
    }
}
