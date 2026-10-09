'use strict'

const test = require('node:test')
const path = require('node:path')
const assert = require('node:assert/strict')
const { cropTrayPetIcon, fittedSize, trayIconCropRect, statusTrayIconPath, loadStatusTrayIcon } = require('../src/tray-icon')

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


test('packaged status icon uses extraResources even when the asar asset is absent', () => {
  const options = { isPackaged: true, resourcesPath: '/app/resources', appDirectory: '/app/resources/app.asar', platform: 'darwin' }
  const calls = []
  const image = { isEmpty: () => false, resize(size) { calls.push(size); return this } }
  const nativeImage = { createFromPath(file) {
    calls.push(file)
    assert.equal(file, path.join(options.resourcesPath, 'tray', 'icon.png'))
    return image
  } }
  const result = loadStatusTrayIcon(nativeImage, options)
  assert.equal(result.image, image)
  assert.equal(result.fallback, false)
  assert.deepEqual(calls, [path.join(options.resourcesPath, 'tray', 'icon.png'), { width: 18, height: 18, quality: 'best' }])
  assert.equal(statusTrayIconPath({ ...options, isPackaged: false }), path.join(options.appDirectory, 'assets', 'icon.png'))
})

test('missing or unreadable status asset falls back to a bundled paw instead of an empty tray', () => {
  const empty = { isEmpty: () => true }
  const paw = { isEmpty: () => false }
  let dataURL
  const result = loadStatusTrayIcon({ createFromPath: () => empty, createFromDataURL(data) { dataURL = data; return paw } },
    { isPackaged: true, resourcesPath: '/missing', platform: 'win32' })
  assert.equal(result.image, paw)
  assert.equal(result.fallback, true)
  assert.ok(Buffer.from(dataURL.split(',')[1], 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
})
