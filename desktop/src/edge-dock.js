'use strict'
;(function (root) {
  const EDGES = ['left', 'right', 'top', 'bottom']
  const clamp = (value, min, max) => Math.max(min, Math.min(Math.max(min, max), value))
  function normalizeDock(value) {
    if (!value || !EDGES.includes(value.edge) || !Number.isFinite(value.displayID) || !Number.isFinite(value.position)) return null
    return { edge: value.edge, displayID: value.displayID, position: clamp(value.position, 0, 1) }
  }
  function spriteBounds(bounds, sprite) {
    return { x: bounds.x + Math.round((bounds.width - sprite.width) / 2), y: bounds.y + bounds.height - sprite.height, ...sprite }
  }
  function edgeForRect(rect, area, threshold = 18) {
    const gaps = { left: rect.x - area.x, right: area.x + area.width - rect.x - rect.width,
      top: rect.y - area.y, bottom: area.y + area.height - rect.y - rect.height }
    const distances = { left: Math.abs(rect.x + rect.width / 2 - area.x), right: Math.abs(area.x + area.width - rect.x - rect.width / 2),
      top: Math.abs(rect.y + rect.height / 2 - area.y), bottom: Math.abs(area.y + area.height - rect.y - rect.height / 2) }
    return EDGES.filter(edge => gaps[edge] <= threshold).sort((a, b) => distances[a] - distances[b])[0] || null
  }
  function headSize(sprite, edge) {
    const width = clamp(Math.round(sprite.width * 0.5), 42, 76), height = Math.round(width * 0.7)
    return edge === 'left' || edge === 'right' ? { width: height, height: width } : { width, height }
  }
  function dockBounds(dock, sprite, area) {
    const size = headSize(sprite, dock.edge)
    const width = Math.min(size.width, area.width), height = Math.min(size.height, area.height)
    const x = dock.edge === 'left' ? area.x : dock.edge === 'right' ? area.x + area.width - width
      : clamp(area.x + area.width * dock.position - width / 2, area.x, area.x + area.width - width)
    const y = dock.edge === 'top' ? area.y : dock.edge === 'bottom' ? area.y + area.height - height
      : clamp(area.y + area.height * dock.position - height / 2, area.y, area.y + area.height - height)
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
  }
  function restoreBounds(head, sprite, area) {
    return { x: Math.round(clamp(head.x + head.width / 2 - sprite.width / 2, area.x + 24, area.x + area.width - sprite.width - 24)),
      y: Math.round(clamp(head.y + head.height / 2 - sprite.height / 2, area.y + 24, area.y + area.height - sprite.height - 24)), ...sprite }
  }
  // Pet atlases have no semantic head mask. Use the upper half of the opaque
  // idle frame, trimming transparent padding instead of shrinking the whole pet.
  function headCrop({ data, width, height }) {
    let left = width, top = height, right = -1, bottom = -1
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 24) continue
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
    }
    if (right < left) return { x: 0, y: 0, width, height: Math.max(1, Math.round(height / 2)) }
    const cropBottom = top + Math.max(1, Math.ceil((bottom - top + 1) * 0.5))
    left = width; right = -1
    for (let y = top; y < cropBottom; y++) for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] >= 24) { left = Math.min(left, x); right = Math.max(right, x) }
    }
    return { x: left, y: top, width: Math.max(1, right - left + 1), height: cropBottom - top }
  }
  const api = { EDGES, normalizeDock, spriteBounds, edgeForRect, headSize, dockBounds, restoreBounds, headCrop }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.petEdgeDock = api
})(typeof window !== 'undefined' ? window : null)
