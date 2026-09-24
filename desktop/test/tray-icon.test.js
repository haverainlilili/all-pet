'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { cropTrayPetIcon, fittedSize, trayIconCropRect } = require('../src/tray-icon')

test('menu thumbnail crop uses the atlas top-left idle frame', () => {
  const calls = []
  const result = { isEmpty: () => false }
  const frame = {
    isEmpty: () => false,
    resize(options) { calls.push(['resize', options]); return result }
  }
  const source = {
    isEmpty: () => false, getSize: () => ({ width: 1536, height: 1872 }),
    crop(rect) { calls.push(['crop', rect]); return frame }
  }
  const nativeImage = { createFromPath(file) { calls.push(['source', file]); return source } }
  const descriptor = { source: '/pets/cloudling/spritesheet.png', cellWidth: 192, cellHeight: 208 }
  assert.equal(cropTrayPetIcon(nativeImage, descriptor, 0, 0, 20), result)
  assert.deepEqual(calls, [
    ['source', descriptor.source],
    ['crop', { x: 0, y: 0, width: 192, height: 208 }],
    ['resize', { width: 18, height: 20, quality: 'best' }]
  ])
})

test('menu thumbnail geometry is explicit and bounds checked', () => {
  assert.deepEqual(trayIconCropRect({ cellWidth: 192, cellHeight: 208 }, 2, 3), { x: 576, y: 416, width: 192, height: 208 })
  assert.deepEqual(fittedSize(192, 208, 20), { width: 18, height: 20 })
  const nativeImage = { createFromPath: () => ({
    isEmpty: () => false, getSize: () => ({ width: 100, height: 100 }), crop: () => { throw new Error('must not crop') }
  }) }
  assert.throws(() => cropTrayPetIcon(nativeImage, { source: '/bad.png', cellWidth: 192, cellHeight: 208 }), /outside source atlas/)
})
