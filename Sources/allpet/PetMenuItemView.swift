#if os(macOS)
import AppKit

/// 菜单栏「宠物」子菜单中单个宠物的自定义行视图：缩略图 + 名称 + 右侧删除按钮。
/// 点击行主体切换宠物；点击右侧 × 删除按钮弹出确认。
final class PetMenuItemView: NSView {
    var onSelect: (() -> Void)?
    var onDelete: (() -> Void)?

    private let thumbnail: NSImage?
    private let title: String
    private let isCurrent: Bool
    private let deleteButtonSize: CGFloat = 20

    private var trackingArea: NSTrackingArea?
    private var isHighlighted = false {
        didSet { if isHighlighted != oldValue { needsDisplay = true } }
    }
    private var isDeleteHovered = false {
        didSet { if isDeleteHovered != oldValue { needsDisplay = true } }
    }

    init(thumbnail: NSImage?, title: String, isCurrent: Bool) {
        self.thumbnail = thumbnail
        self.title = title
        self.isCurrent = isCurrent
        super.init(frame: NSRect(x: 0, y: 0, width: 288, height: 26))
    }

    required init?(coder: NSCoder) { nil }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private var deleteButtonRect: NSRect {
        NSRect(
            x: bounds.maxX - deleteButtonSize - 8,
            y: (bounds.height - deleteButtonSize) / 2,
            width: deleteButtonSize,
            height: deleteButtonSize
        )
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.activeInActiveApp, .mouseEnteredAndExited, .mouseMoved, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        isHighlighted = true
    }

    override func mouseExited(with event: NSEvent) {
        isHighlighted = false
        isDeleteHovered = false
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        isDeleteHovered = deleteButtonRect.insetBy(dx: -3, dy: -3).contains(point)
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let isDelete = deleteButtonRect.insetBy(dx: -4, dy: -4).contains(point)
        if isDelete {
            // 删除会弹确认框，先关闭菜单。
            enclosingMenuItem?.menu?.cancelTracking()
            if let onDelete { DispatchQueue.main.async { onDelete() } }
        } else {
            // 切换宠物：菜单保持打开（不 cancelTracking），方便连续切换。
            if let onSelect { DispatchQueue.main.async { onSelect() } }
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if isHighlighted {
            NSColor.selectedContentBackgroundColor.setFill()
            bounds.fill()
        }
        let textColor: NSColor = isHighlighted ? .selectedMenuItemTextColor : .labelColor

        // 缩略图
        if let thumbnail {
            let thumbRect = NSRect(x: 8, y: (bounds.height - 20) / 2, width: 20, height: 20)
            thumbnail.draw(in: thumbRect, from: .zero, operation: .sourceOver, fraction: 1)
        }

        // 名称（当前宠物加粗并带 ✓）
        let titleX: CGFloat = 32
        let titleRect = NSRect(
            x: titleX,
            y: 4,
            width: max(10, deleteButtonRect.minX - titleX - 10),
            height: 18
        )
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let prefix = isCurrent ? "✓ " : ""
        let display = prefix + title
        (display as NSString).draw(
            with: titleRect,
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
            attributes: [
                .font: NSFont.systemFont(ofSize: 13, weight: isCurrent ? .semibold : .regular),
                .foregroundColor: textColor,
                .paragraphStyle: paragraph
            ]
        )

        // 删除按钮
        let delRect = deleteButtonRect
        if isDeleteHovered {
            NSColor.systemRed.withAlphaComponent(0.18).setFill()
        } else {
            (isHighlighted ? NSColor.white.withAlphaComponent(0.14) : NSColor.black.withAlphaComponent(0.07)).setFill()
        }
        NSBezierPath(ovalIn: delRect).fill()
        let delColor: NSColor = isDeleteHovered
            ? .systemRed
            : (isHighlighted ? .selectedMenuItemTextColor : .tertiaryLabelColor)
        ("×" as NSString).draw(
            with: NSRect(x: delRect.minX, y: delRect.minY - 2, width: delRect.width, height: delRect.height),
            options: [.usesLineFragmentOrigin],
            attributes: [.font: NSFont.systemFont(ofSize: 14, weight: .medium), .foregroundColor: delColor]
        )
    }
}

/// 菜单栏「宠物大小」控件行：− 按钮 + 当前百分比 + ＋ 按钮。
/// 点击按钮调整大小但不关闭菜单（不 cancelTracking），方便连续加减。
final class PetSizeControlView: NSView {
    var onDecrease: (() -> Void)?
    var onIncrease: (() -> Void)?

    private var trackingArea: NSTrackingArea?
    private var hoveredButton: Int = 0 // -1 = 减号, 1 = 加号, 0 = 无
    private let buttonSize: CGFloat = 22

    var percentText: String = "100%" {
        didSet { if percentText != oldValue { needsDisplay = true } }
    }

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 288, height: 28))
    }

    required init?(coder: NSCoder) { nil }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private var minusRect: NSRect {
        NSRect(x: 8, y: (bounds.height - buttonSize) / 2, width: buttonSize, height: buttonSize)
    }

    private var plusRect: NSRect {
        NSRect(x: bounds.maxX - buttonSize - 8, y: (bounds.height - buttonSize) / 2, width: buttonSize, height: buttonSize)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.activeInActiveApp, .mouseEnteredAndExited, .mouseMoved, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        updateHover(with: event)
    }

    override func mouseExited(with event: NSEvent) {
        hoveredButton = 0
        needsDisplay = true
    }

    override func mouseMoved(with event: NSEvent) {
        updateHover(with: event)
    }

    private func updateHover(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let next: Int
        if minusRect.insetBy(dx: -3, dy: -3).contains(point) { next = -1 }
        else if plusRect.insetBy(dx: -3, dy: -3).contains(point) { next = 1 }
        else { next = 0 }
        if next != hoveredButton {
            hoveredButton = next
            needsDisplay = true
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if minusRect.insetBy(dx: -4, dy: -4).contains(point) {
            onDecrease?()
        } else if plusRect.insetBy(dx: -4, dy: -4).contains(point) {
            onIncrease?()
        }
        // 刻意不调用 cancelTracking()：让菜单在调节大小时保持打开，可连续点击。
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let buttonFill: NSColor
        switch hoveredButton {
        case -1: buttonFill = NSColor.systemBlue.withAlphaComponent(0.18)
        case 1: buttonFill = NSColor.systemBlue.withAlphaComponent(0.18)
        default: buttonFill = (isDark ? NSColor.white.withAlphaComponent(0.10) : NSColor.black.withAlphaComponent(0.06))
        }

        // 中间文本「宠物大小 100%」
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let labelRect = NSRect(x: minusRect.maxX + 4, y: 4, width: plusRect.minX - minusRect.maxX - 8, height: 20)
        ("宠物大小 \(percentText)" as NSString).draw(
            with: labelRect,
            options: [.usesLineFragmentOrigin],
            attributes: [
                .font: NSFont.systemFont(ofSize: 12, weight: .medium),
                .foregroundColor: NSColor.labelColor,
                .paragraphStyle: paragraph
            ]
        )

        // 减号按钮
        drawButton(minusRect, symbol: "−", fill: hoveredButton == -1 ? buttonFill : NSColor.black.withAlphaComponent(0.05))
        // 加号按钮
        drawButton(plusRect, symbol: "＋", fill: hoveredButton == 1 ? buttonFill : NSColor.black.withAlphaComponent(0.05))
    }

    private func drawButton(_ rect: NSRect, symbol: String, fill: NSColor) {
        fill.setFill()
        NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6).fill()
        let textColor: NSColor = hoveredButton != 0 ? .controlAccentColor : .secondaryLabelColor
        (symbol as NSString).draw(
            with: NSRect(x: rect.minX, y: rect.minY - 2, width: rect.width, height: rect.height),
            options: [.usesLineFragmentOrigin],
            attributes: [
                .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
                .foregroundColor: textColor
            ]
        )
    }
}

/// 菜单栏「宠物」子菜单中「未安装的默认宠物」行视图：缩略图 + 名称 + 右侧「下载」提示。
/// 点击整行即可自动下载并设为当前宠物；无需进入二级菜单或手动输入命令。
final class PetMenuDownloadItemView: NSView {
    var onDownload: (() -> Void)?

    private let title: String
    private let slug: String
    private var thumbnail: NSImage?

    private var trackingArea: NSTrackingArea?
    private var isHighlighted = false {
        didSet { if isHighlighted != oldValue { needsDisplay = true } }
    }

    init(thumbnail: NSImage?, title: String, slug: String) {
        self.thumbnail = thumbnail
        self.title = title
        self.slug = slug
        super.init(frame: NSRect(x: 0, y: 0, width: 288, height: 26))
    }

    required init?(coder: NSCoder) { nil }

    /// 缩略图按需异步加载完成后回填；加载前显示下载图标占位。
    func setThumbnail(_ image: NSImage?) {
        thumbnail = image
        needsDisplay = true
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.activeInActiveApp, .mouseEnteredAndExited, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { isHighlighted = true }
    override func mouseExited(with event: NSEvent) { isHighlighted = false }

    override func mouseDown(with event: NSEvent) {
        enclosingMenuItem?.menu?.cancelTracking()
        if let onDownload {
            DispatchQueue.main.async { onDownload() }
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if isHighlighted {
            NSColor.selectedContentBackgroundColor.setFill()
            bounds.fill()
        }
        let textColor: NSColor = isHighlighted ? .selectedMenuItemTextColor : .labelColor
        let secondary: NSColor = isHighlighted
            ? .selectedMenuItemTextColor.withAlphaComponent(0.72)
            : .secondaryLabelColor

        // 缩略图（未加载完成前用下载图标占位）
        if let thumbnail {
            let thumbRect = NSRect(x: 8, y: (bounds.height - 20) / 2, width: 20, height: 20)
            thumbnail.draw(in: thumbRect, from: .zero, operation: .sourceOver, fraction: 1)
        } else {
            let iconRect = NSRect(x: 8, y: (bounds.height - 16) / 2, width: 16, height: 16)
            ("↓" as NSString).draw(
                with: iconRect,
                options: [.usesLineFragmentOrigin],
                attributes: [
                    .font: NSFont.systemFont(ofSize: 13, weight: .medium),
                    .foregroundColor: textColor
                ]
            )
        }

        // 名称
        let titleRect = NSRect(x: 32, y: 4, width: 142, height: 18)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        (title as NSString).draw(
            with: titleRect,
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
            attributes: [
                .font: NSFont.systemFont(ofSize: 13, weight: .regular),
                .foregroundColor: textColor,
                .paragraphStyle: paragraph
            ]
        )

        // 右侧「下载」提示 + slug
        let hintText = "下载 · \(slug)"
        let hintRect = NSRect(x: 178, y: 4, width: max(10, bounds.maxX - 178 - 12), height: 18)
        (hintText as NSString).draw(
            with: hintRect,
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
            attributes: [
                .font: NSFont.systemFont(ofSize: 11, weight: .regular),
                .foregroundColor: secondary,
                .paragraphStyle: paragraph
            ]
        )
    }
}
#endif
