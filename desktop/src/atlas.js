'use strict'

;(function publishAtlas(root) {
  function validatedAtlas(payload, naturalWidth, naturalHeight) {
    const columns = Number(payload && payload.columns)
    const rows = Number(payload && payload.rows)
    const cellWidth = Number(payload && payload.cellWidth)
    const cellHeight = Number(payload && payload.cellHeight)
    const ok = columns === 8
      && (rows === 9 || rows === 11)
      && Number.isFinite(cellWidth) && cellWidth > 0
      && Number.isFinite(cellHeight) && cellHeight > 0
      && Math.round(columns * cellWidth) === naturalWidth
      && Math.round(rows * cellHeight) === naturalHeight
    return ok ? { ok: true, columns, rows, cellWidth, cellHeight } : { ok: false }
  }

  const api = { validatedAtlas }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.petAtlas = api
})(typeof window !== 'undefined' ? window : null)
