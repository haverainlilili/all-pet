import Foundation

/// 不依赖 AppKit/Electron 的窗口边界，用于保持精灵位置并将整个窗口限制在工作区内。
public struct PetWindowBounds: Equatable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public enum PetWindowLayout {
    public static func clamped(
        _ bounds: PetWindowBounds,
        in workArea: PetWindowBounds,
        margin: Double = 20
    ) -> PetWindowBounds {
        let minX = workArea.x + margin
        let maxX = workArea.x + workArea.width - bounds.width - margin
        let minY = workArea.y + margin
        let maxY = workArea.y + workArea.height - bounds.height - margin
        let x = maxX < minX ? workArea.x : min(maxX, max(minX, bounds.x))
        let y = maxY < minY ? workArea.y : min(maxY, max(minY, bounds.y))
        return PetWindowBounds(x: x, y: y, width: bounds.width, height: bounds.height)
    }

    /// 先保持精灵在屏幕中的绝对左下角，再将扩缩后的完整窗口夹回原显示器工作区。
    public static func preservingSprite(
        oldWindow: PetWindowBounds,
        oldSprite: PetWindowBounds,
        nextWindow: PetWindowBounds,
        nextSprite: PetWindowBounds,
        workArea: PetWindowBounds,
        margin: Double = 20
    ) -> PetWindowBounds {
        let spriteX = oldWindow.x + oldSprite.x
        let spriteY = oldWindow.y + oldSprite.y
        return clamped(
            PetWindowBounds(
                x: spriteX - nextSprite.x,
                y: spriteY - nextSprite.y,
                width: nextWindow.width,
                height: nextWindow.height
            ),
            in: workArea,
            margin: margin
        )
    }
}
