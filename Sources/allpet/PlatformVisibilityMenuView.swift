#if canImport(AppKit)
import AppKit

/// Native controls handle clicks without ending menu tracking.
final class PlatformVisibilityMenuView: NSView {
    private let button = NSButton()
    var onActivate: (() -> Void)?

    var isChecked: Bool {
        get { button.state == .on }
        set { button.state = newValue ? .on : .off }
    }

    init(title: String, checked: Bool? = nil, onActivate: @escaping () -> Void) {
        super.init(frame: NSRect(x: 0, y: 0, width: 250, height: 26))
        self.onActivate = onActivate
        autoresizingMask = [.width]
        button.title = title
        button.font = NSFont.menuFont(ofSize: 0)
        button.target = self
        button.action = #selector(activate)
        button.autoresizingMask = [.width]
        if let checked {
            button.setButtonType(.switch)
            button.state = checked ? .on : .off
            button.frame = NSRect(x: 12, y: 2, width: 226, height: 22)
        } else {
            button.setButtonType(.momentaryPushIn)
            button.isBordered = false
            button.alignment = .left
            button.frame = NSRect(x: 30, y: 2, width: 208, height: 22)
        }
        addSubview(button)
    }

    required init?(coder: NSCoder) { nil }

    @objc private func activate() {
        onActivate?()
        // Do not cancel menu tracking: the user can change another platform.
    }

    static func update(_ item: NSMenuItem, checked: Bool) {
        item.state = checked ? .on : .off
        (item.view as? PlatformVisibilityMenuView)?.isChecked = checked
    }
}
#endif
