'use strict'

const THUMBNAIL_TARGET = 72
const MAX_THUMBNAIL_DATA_URL_BYTES = 96 * 1024

function thumbnailDimensions(cellWidth, cellHeight, target = THUMBNAIL_TARGET) {
  const width = Math.floor(Number(cellWidth))
  const height = Math.floor(Number(cellHeight))
  if (!(width > 0) || !(height > 0) || !(target > 0)) return null
  const scale = Math.min(1, target / width, target / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

function createBoundedThumbnailDataURL(image, cellWidth, cellHeight, options = {}) {
  if (!image || typeof image.isEmpty !== 'function' || image.isEmpty()) return null
  const source = image.getSize()
  const width = Math.floor(Number(cellWidth))
  const height = Math.floor(Number(cellHeight))
  const dimensions = thumbnailDimensions(width, height, options.target || THUMBNAIL_TARGET)
  if (!dimensions || source.width < width || source.height < height) return null
  const frame = image.crop({ x: 0, y: 0, width, height })
  if (!frame || frame.isEmpty()) return null
  const resized = frame.resize({ ...dimensions, quality: 'good' })
  if (!resized || resized.isEmpty()) return null
  const value = resized.toDataURL()
  const maximum = options.maximumBytes || MAX_THUMBNAIL_DATA_URL_BYTES
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum ? value : null
}

module.exports = {
  MAX_THUMBNAIL_DATA_URL_BYTES,
  THUMBNAIL_TARGET,
  createBoundedThumbnailDataURL,
  thumbnailDimensions
}
