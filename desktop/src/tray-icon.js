'use strict'

const path = require('node:path')

// electron-builder copies this PNG outside app.asar; assets/icon.png is development-only.
function statusTrayIconPath({ isPackaged, resourcesPath, appDirectory }) {
  return isPackaged ? path.join(resourcesPath, 'tray', 'icon.png') : path.join(appDirectory, 'assets', 'icon.png')
}

const FALLBACK_STATUS_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZklEQVR42mNgGAVDDXxdpvwfGRMSp6nlhPCoA4a2A0hNbNjEyXYQNXxEkRmjDhhwB1CrZKNZtqRbvh80hRCpllPVEeRaTjVHDKgDKLWcYkeMOmDAHTCaCwZFQTRo2oMDXhmNgmELAAs8glYko+JSAAAAAElFTkSuQmCC'

function loadStatusTrayIcon(nativeImage, options) {
  const iconPath = statusTrayIconPath(options)
  let image = nativeImage.createFromPath(iconPath)
  const fallback = image.isEmpty()
  // Never create an invisible tray when an asset is missing or cannot be decoded.
  if (fallback) image = nativeImage.createFromDataURL(FALLBACK_STATUS_ICON)
  if (image.isEmpty()) throw new Error('AllPet status icon cannot be decoded')
  if (options.platform === 'darwin') image = image.resize({ width: 18, height: 18, quality: 'best' })
  if (image.isEmpty()) throw new Error('AllPet status icon resize failed')
  return { image, iconPath, fallback }
}

function trayIconCropRect(descriptor, row = 0, column = 0) {
  const width = Math.round(Number(descriptor && descriptor.cellWidth))
  const height = Math.round(Number(descriptor && descriptor.cellHeight))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error('invalid tray icon cell geometry')
  return { x: Math.round(Number(column) || 0) * width, y: Math.round(Number(row) || 0) * height, width, height }
}

function fittedSize(width, height, maximumDimension = 20) {
  const scale = Math.min(1, maximumDimension / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

function cropTrayPetIcon(nativeImage, descriptor, row = 0, column = 0, maximumDimension = 20) {
  const source = nativeImage.createFromPath(descriptor.source)
  if (!source || source.isEmpty()) throw new Error('tray icon source cannot be decoded')
  const rect = trayIconCropRect(descriptor, row, column)
  const sourceSize = source.getSize()
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > sourceSize.width || rect.y + rect.height > sourceSize.height) {
    throw new Error('tray icon crop is outside source atlas')
  }
  const frame = source.crop(rect)
  if (frame.isEmpty()) throw new Error('tray icon frame is empty')
  const target = fittedSize(rect.width, rect.height, maximumDimension)
  const result = frame.resize({ ...target, quality: 'best' })
  if (result.isEmpty()) throw new Error('tray icon resize failed')
  return result
}

module.exports = { cropTrayPetIcon, fittedSize, trayIconCropRect, statusTrayIconPath, loadStatusTrayIcon }
