'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { normalizeDock, spriteBounds, edgeForRect, headSize, dockBounds, restoreBounds, headCrop } = require('../src/edge-dock')

test('docking uses the pet body rather than the wider notification window', () => {
  const area = { x: 0, y: 24, width: 1440, height: 850 }
  const sprite = { width: 112, height: 121 }
  const rect = spriteBounds({ x: 0, y: 100, width: 334, height: 600 }, sprite)
  assert.equal(edgeForRect(rect, area), null, 'bubble touching the border must not dock a pet still inside')
  for (const [edge, position] of Object.entries({ left: { x: 18, y: 300 }, right: { x: 1440 - 112 - 18, y: 300 }, top: { x: 400, y: 24 }, bottom: { x: 400, y: 850 + 24 - 121 } })) {
    assert.equal(edgeForRect({ ...position, ...sprite }, area), edge)
  }
})
test('small head stays visible on all borders of a negative-coordinate monitor after resizing', () => {
  const area = { x: -1920, y: -500, width: 1920, height: 1080 }
  for (const edge of ['left', 'right', 'top', 'bottom']) for (const position of [0, 0.5, 1]) for (const width of [80, 112, 224]) {
    const bounds = dockBounds({ edge, position }, { width, height: width }, area)
    assert.ok(bounds.x >= area.x && bounds.y >= area.y)
    assert.ok(bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height)
    assert.ok(Math.max(bounds.width, bounds.height) <= 76)
    if (edge === 'left') assert.equal(bounds.x, area.x)
    if (edge === 'right') assert.equal(bounds.x + bounds.width, area.x + area.width)
    if (edge === 'top') assert.equal(bounds.y, area.y)
    if (edge === 'bottom') assert.equal(bounds.y + bounds.height, area.y + area.height)
    const restored = restoreBounds(bounds, { width, height: width }, area)
    assert.equal(edgeForRect(restored, area), null, 'clicking the head restores far enough inside to avoid redocking')
  }
})
test('saved docking state rejects invalid geometry and strips unrelated fields', () => {
  assert.equal(normalizeDock({ edge: 'right', displayID: 1, position: NaN }), null)
  assert.equal(normalizeDock({ edge: 'unknown', displayID: 1, position: 0.5 }), null)
  assert.deepEqual(normalizeDock({ edge: 'left', displayID: -1, position: 9, command: 'ignored' }), { edge: 'left', displayID: -1, position: 1 })
  assert.deepEqual(headSize({ width: 112 }, 'left'), { width: 39, height: 56 })
})
test('head crop ignores atlas padding and excludes the lower half and wide feet', () => {
  const width = 20, height = 24, data = new Uint8ClampedArray(width * height * 4)
  for (let y = 4; y < 20; y++) for (let x = y < 12 ? 7 : 2; x < (y < 12 ? 13 : 18); x++) data[(y * width + x) * 4 + 3] = 255
  assert.deepEqual(headCrop({ width, height, data }), { x: 7, y: 4, width: 6, height: 8 })
})
