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
        let action = isDelete ? onDelete : onSelect
        enclosingMenuItem?.menu?.cancelTracking()
        if let action {
            DispatchQueue.main.async { action() }
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
#endif
