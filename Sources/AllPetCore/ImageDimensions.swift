import Foundation

/// 纯 Swift 的图片尺寸解析器：只读文件头部，不依赖 ImageIO/CoreGraphics，跨平台可用。
/// 用于在 Linux / Windows 上替代 ImageIO 读取 Codex 图集的宽高（PNG / WebP / GIF / JPEG）。
enum ImageDimensions {

    static func read(at url: URL) -> (width: Int, height: Int)? {
        guard let handle = FileHandle(forReadingAtPath: url.path) else { return nil }
        defer { try? handle.close() }
        let data = handle.readData(ofLength: 256 * 1_024)
        return read(from: data)
    }

    static func read(from data: Data) -> (width: Int, height: Int)? {
        let bytes = [UInt8](data)
        if let dims = png(bytes) { return dims }
        if let dims = gif(bytes) { return dims }
        if let dims = webp(bytes) { return dims }
        if let dims = jpeg(bytes) { return dims }
        return nil
    }

    // MARK: - PNG

    private static func png(_ b: [UInt8]) -> (Int, Int)? {
        guard b.count >= 24 else { return nil }
        guard b[0] == 0x89, b[1] == 0x50, b[2] == 0x4E, b[3] == 0x47, b[4] == 0x0D, b[5] == 0x0A, b[6] == 0x1A, b[7] == 0x0A else { return nil }
        guard b[12] == 0x49, b[13] == 0x48, b[14] == 0x44, b[15] == 0x52 else { return nil } // "IHDR"
        let width = Int(b[16]) << 24 | Int(b[17]) << 16 | Int(b[18]) << 8 | Int(b[19])
        let height = Int(b[20]) << 24 | Int(b[21]) << 16 | Int(b[22]) << 8 | Int(b[23])
        return (width, height)
    }

    // MARK: - GIF

    private static func gif(_ b: [UInt8]) -> (Int, Int)? {
        guard b.count >= 10 else { return nil }
        guard let header = String(bytes: b[0..<6], encoding: .ascii),
              header == "GIF87a" || header == "GIF89a" else { return nil }
        let width = Int(b[6]) | Int(b[7]) << 8
        let height = Int(b[8]) | Int(b[9]) << 8
        return (width, height)
    }

    // MARK: - WebP

    private static func webp(_ b: [UInt8]) -> (Int, Int)? {
        guard b.count >= 30 else { return nil }
        guard b[0] == 0x52, b[1] == 0x49, b[2] == 0x46, b[3] == 0x46 else { return nil } // "RIFF"
        guard b[8] == 0x57, b[9] == 0x45, b[10] == 0x42, b[11] == 0x50 else { return nil } // "WEBP"

        // "VP8 "（有损）
        if b[12] == 0x56, b[13] == 0x50, b[14] == 0x38, b[15] == 0x20 {
            let width = (Int(b[23]) | Int(b[24]) << 8) & 0x3FFF
            let height = (Int(b[25]) | Int(b[26]) << 8) & 0x3FFF
            return (width, height)
        }
        // "VP8L"（无损）
        if b[12] == 0x56, b[13] == 0x50, b[14] == 0x38, b[15] == 0x4C {
            guard b[20] == 0x2F else { return nil }
            let v = UInt32(b[21]) | UInt32(b[22]) << 8 | UInt32(b[23]) << 16 | UInt32(b[24]) << 24
            let width = Int(v & 0x3FFF) + 1
            let height = Int((v >> 14) & 0x3FFF) + 1
            return (width, height)
        }
        // "VP8X"（扩展）
        if b[12] == 0x56, b[13] == 0x50, b[14] == 0x38, b[15] == 0x58 {
            let width = Int(b[21]) | Int(b[22]) << 8 | Int(b[23]) << 16
            let height = Int(b[24]) | Int(b[25]) << 8 | Int(b[26]) << 16
            return (width + 1, height + 1)
        }
        return nil
    }

    // MARK: - JPEG

    private static func jpeg(_ b: [UInt8]) -> (Int, Int)? {
        guard b.count >= 4, b[0] == 0xFF, b[1] == 0xD8 else { return nil }
        var i = 2
        while i + 4 < b.count {
            guard b[i] == 0xFF else { i += 1; continue }
            let marker = b[i + 1]
            if marker == 0xD9 || marker == 0xDA { return nil } // EOI / SOS（之后是压缩数据）
            if marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x00 || marker == 0x01 {
                i += 2
                continue
            }
            guard i + 4 <= b.count else { return nil }
            let length = Int(b[i + 2]) << 8 | Int(b[i + 3])
            guard length >= 2, i + 2 + length <= b.count else { return nil }
            if marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
                let height = Int(b[i + 5]) << 8 | Int(b[i + 6])
                let width = Int(b[i + 7]) << 8 | Int(b[i + 8])
                return (width, height)
            }
            i += 2 + length
        }
        return nil
    }
}
