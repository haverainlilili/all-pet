'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const {
  attachRestartOnClose, catalogPetForBundle, chooseCurrentPet, createOperationGate, effectiveHome, expandHomePath, finishMutationRefresh, petCapabilities, petMutationTarget,
  preservedWindowBounds, runSerializedPetRefresh, spriteSizeForPet
} = require('../src/pet-state')
const { validatedAtlas } = require('../src/atlas')
const { createLatestGate } = require('../src/latest')
const { dragMove, dragRelease } = require('../src/interaction')
const { createBoundedThumbnailDataURL, thumbnailDimensions } = require('../src/pet-thumbnail')

test('manager thumbnails crop one frame and enforce dimension and payload bounds', () => {
  assert.deepEqual(thumbnailDimensions(192, 208), { width: 66, height: 72 })
  let cropBounds = null
  let resizeBounds = null
  const finalImage = { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,small' }
  const frame = { isEmpty: () => false, resize: bounds => { resizeBounds = bounds; return finalImage } }
  const atlas = {
    isEmpty: () => false, getSize: () => ({ width: 1536, height: 2288 }),
    crop: bounds => { cropBounds = bounds; return frame }
  }
  assert.equal(createBoundedThumbnailDataURL(atlas, 192, 208), 'data:image/png;base64,small')
  assert.deepEqual(cropBounds, { x: 0, y: 0, width: 192, height: 208 })
  assert.deepEqual(resizeBounds, { width: 66, height: 72, quality: 'good' })
  finalImage.toDataURL = () => 'x'.repeat(100)
  assert.equal(createBoundedThumbnailDataURL(atlas, 192, 208, { maximumBytes: 32 }), null)
})

test('watch spawn error restarts exactly once from close and never during quit', () => {
  const { EventEmitter } = require('node:events')
  let current = true
  let quitting = false
  let errors = 0
  let restarts = 0
  const child = new EventEmitter()
  attachRestartOnClose(child, {
    onError: () => { errors += 1 },
    isCurrent: () => current,
    clearCurrent: () => { current = false },
    shouldRestart: () => !quitting,
    scheduleRestart: () => { restarts += 1 }
  })
  child.emit('error', new Error('ENOENT'))
  child.emit('close', -2)
  child.emit('close', -2)
  assert.equal(errors, 1)
  assert.equal(restarts, 1)
  assert.equal(current, false)

  const quittingChild = new EventEmitter()
  current = true
  quitting = true
  attachRestartOnClose(quittingChild, {
    onError: () => {}, isCurrent: () => current, clearCurrent: () => { current = false },
    shouldRestart: () => !quitting, scheduleRestart: () => { restarts += 1 }
  })
  quittingChild.emit('close', 0)
  assert.equal(restarts, 1)
})

test('fresh or stale config falls back to the first discovered pet', () => {
  const pets = [{ id: 'first', current: false }, { id: 'second', current: false }]
  assert.equal(chooseCurrentPet(pets).id, 'first')
  pets[1].current = true
  assert.equal(chooseCurrentPet(pets).id, 'second')
  assert.equal(chooseCurrentPet([]), null)
})

test('current pet uses only sidecar-validated catalog paths and atlas metadata', () => {
  const catalog = [{
    id: 'safe', displayName: 'Safe', directoryPath: '/pets/safe', spritesheetPath: '/pets/safe/spritesheet.webp',
    columns: 8, rows: 11, cellWidth: 192, cellHeight: 208
  }]
  assert.deepEqual(catalogPetForBundle('/pets/safe', catalog), {
    bundlePath: '/pets/safe', spritesheetPath: '/pets/safe/spritesheet.webp', manifestId: 'safe', displayName: 'Safe',
    columns: 8, rows: 11, cellWidth: 192, cellHeight: 208
  })
  assert.equal(catalogPetForBundle('/pets/safe', [{ ...catalog[0], spritesheetPath: '', columns: 0 }]), null)
  assert.equal(catalogPetForBundle('/pets/safe-evil', catalog), null)
})

test('manager mutations prefer an exact bundle path when IDs collide', () => {
  assert.equal(petMutationTarget({ id: 'same', directoryPath: '/pets/second.petbundle' }), '/pets/second.petbundle')
  assert.equal(petMutationTarget({ id: 'legacy' }), 'legacy')
})

test('effective home matches sidecar ALLPET_HOME override semantics', () => {
  assert.equal(effectiveHome({ ALLPET_HOME: '  /tmp/allpet-home  ' }, '/fallback'), path.resolve('/tmp/allpet-home'))
  assert.equal(effectiveHome({ ALLPET_HOME: '   ' }, '/fallback'), '/fallback')
  assert.equal(effectiveHome({}, '/fallback'), '/fallback')
})

test('current pet config expands tilde paths before filesystem lookup', () => {
  assert.equal(expandHomePath('~/pets/boba.petbundle', '/home/demo'), require('node:path').join('/home/demo', 'pets/boba.petbundle'))
  assert.equal(expandHomePath('~\\pets\\boba.petbundle', '/home/demo'), require('node:path').join('/home/demo', 'pets/boba.petbundle'))
  assert.equal(expandHomePath('/opt/pets/boba.petbundle', '/home/demo'), '/opt/pets/boba.petbundle')
})

test('local import capability is honest on all supported operating systems', () => {
  assert.equal(petCapabilities('darwin').importLocal, true)
  for (const platform of ['win32', 'linux']) {
    const capabilities = petCapabilities(platform)
    assert.equal(capabilities.importLocal, false)
    assert.match(capabilities.importLocalReason, /macOS/)
  }
})

test('pet mutations are serialized and publish busy transitions', async () => {
  const transitions = []
  const gate = createOperationGate(state => transitions.push(state))
  let release
  const first = gate.run('安装宠物', () => new Promise(resolve => { release = resolve }))
  const rejected = await gate.run('删除宠物', async () => ({ ok: true }))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.busy, true)
  assert.match(rejected.error, /安装宠物/)
  release({ ok: true, message: 'installed' })
  assert.deepEqual(await first, { ok: true, message: 'installed' })
  assert.deepEqual(transitions, [
    { busy: true, label: '安装宠物' },
    { busy: false, label: null }
  ])
})

test('manual catalog refresh is serialized with every pet mutation', async () => {
  const transitions = []
  const gate = createOperationGate(state => transitions.push(state))
  let release
  const refreshing = runSerializedPetRefresh(gate, () => new Promise(resolve => { release = resolve }))
  const rejected = await gate.run('切换宠物', async () => ({ ok: true }))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.busy, true)
  assert.match(rejected.error, /刷新宠物/)
  release({ ok: true })
  assert.deepEqual(await refreshing, { ok: true })
  assert.deepEqual(transitions, [
    { busy: true, label: '刷新宠物' },
    { busy: false, label: null }
  ])
})

test('successful mutation retains prior state and schedules retry when catalog refresh fails', async () => {
  let retries = 0
  const warning = await finishMutationRefresh({
    label: '安装宠物', message: 'installed',
    refresh: async () => { throw new Error('pet list unavailable') },
    scheduleRetry: () => { retries += 1 }
  })
  assert.equal(warning.ok, false)
  assert.equal(warning.changed, true)
  assert.equal(warning.retrying, true)
  assert.match(warning.error, /自动重试/)
  assert.equal(retries, 1)
  const success = await finishMutationRefresh({
    label: '切换宠物', message: 'switched', refresh: async () => {},
    scheduleRetry: () => { retries += 1 }
  })
  assert.deepEqual(success, { ok: true, message: 'switched' })
  assert.equal(retries, 1)
})

test('operation gate catches spawn and mutation failures and always unlocks', async () => {
  const gate = createOperationGate()
  const failed = await gate.run('导入宠物', async () => { throw new Error('ENOENT') })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /ENOENT/)
  assert.equal(gate.active, null)
  assert.deepEqual(await gate.run('切换宠物', async () => ({ ok: true })), { ok: true })
})

test('only the newest async catalog or spritesheet completion may commit', () => {
  const gate = createLatestGate()
  const first = gate.begin()
  const second = gate.begin()
  assert.equal(first(), false)
  assert.equal(second(), true)
  gate.invalidate()
  assert.equal(second(), false)
})

test('renderer accepts exact dynamic atlas geometry and rejects stale metadata', () => {
  assert.deepEqual(
    validatedAtlas({ columns: 8, rows: 11, cellWidth: 256, cellHeight: 128 }, 2048, 1408),
    { ok: true, columns: 8, rows: 11, cellWidth: 256, cellHeight: 128 }
  )
  assert.deepEqual(
    validatedAtlas({ columns: 8, rows: 9, cellWidth: 192, cellHeight: 208 }, 2048, 1408),
    { ok: false }
  )
  assert.deepEqual(validatedAtlas({ columns: 1, rows: 1, cellWidth: 32, cellHeight: 32 }, 32, 32), { ok: false })
  assert.deepEqual(validatedAtlas({ columns: 8, rows: 10, cellWidth: 192, cellHeight: 208 }, 1536, 2080), { ok: false })
})

test('sprite drag threshold, direction, click, and hovered release match AppKit', () => {
  assert.deepEqual(dragMove(2, 3, false), { didDrag: false, animation: null })
  assert.deepEqual(dragMove(4, 0, false), { didDrag: true, animation: 'running-right' })
  assert.deepEqual(dragMove(-1, 0, true), { didDrag: true, animation: 'running-left' })
  assert.deepEqual(dragRelease(true, true), { animation: 'jumping', openPlatforms: false })
  assert.deepEqual(dragRelease(true, false), { animation: null, openPlatforms: false })
  assert.deepEqual(dragRelease(false, true), { animation: 'jumping', openPlatforms: true })
})

test('sprite metrics use each atlas cell instead of fixed 192 by 208', () => {
  assert.deepEqual(spriteSizeForPet({ cellWidth: 256, cellHeight: 128 }, 0.5), { width: 128, height: 64 })
  assert.deepEqual(spriteSizeForPet(null, 112 / 192), { width: 112, height: 121 })
  assert.equal(spriteSizeForPet({ cellWidth: 1000, cellHeight: 500 }, 1.2).width, 224)
})

test('scale and pet changes preserve dragged sprite bottom-left origin', () => {
  const oldBounds = { x: 500, y: 300, width: 304, height: 260 }
  const oldSprite = { width: 112, height: 121 }
  const nextSprite = { width: 160, height: 80 }
  const nextWindow = { width: 324, height: 422 }
  const result = preservedWindowBounds({
    oldBounds, oldSprite, nextSprite, nextWindow,
    workArea: { x: 0, y: 0, width: 1600, height: 1000 }, margin: 20
  })
  const oldLeft = oldBounds.x + Math.round((oldBounds.width - oldSprite.width) / 2)
  const nextLeft = result.x + Math.round((result.width - nextSprite.width) / 2)
  assert.equal(nextLeft, oldLeft)
  assert.equal(result.y + result.height, oldBounds.y + oldBounds.height)
})

test('preserved layout supports negative-coordinate secondary displays', () => {
  const area = { x: -1920, y: -180, width: 1920, height: 1080 }
  const result = preservedWindowBounds({
    oldBounds: { x: -1500, y: 300, width: 304, height: 260 },
    oldSprite: { width: 112, height: 121 },
    nextSprite: { width: 160, height: 172 },
    nextWindow: { width: 324, height: 400 }, workArea: area, margin: 20
  })
  assert.ok(result.x >= area.x + 20)
  assert.ok(result.x + result.width <= area.x + area.width - 20)
  assert.ok(result.y >= area.y + 20)
  assert.ok(result.y + result.height <= area.y + area.height - 20)
})

test('preserved layout clamps enlarged windows into the selected work area', () => {
  const result = preservedWindowBounds({
    oldBounds: { x: 980, y: 700, width: 120, height: 140 },
    oldSprite: { width: 120, height: 140 },
    nextSprite: { width: 224, height: 240 },
    nextWindow: { width: 334, height: 700 },
    workArea: { x: 0, y: 0, width: 1024, height: 768 }, margin: 20
  })
  assert.ok(result.x + result.width <= 1004)
  assert.ok(result.y + result.height <= 748)
  assert.ok(result.x >= 20)
  assert.ok(result.y >= 20)
})
