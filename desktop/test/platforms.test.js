'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { PLATFORMS, bubblePlatformRows, setBubblePlatformVisibility, filterBubbleSnapshot, platformPage } = require('../src/platforms')
const { menuBridgeState } = require('../src/menu-bridge')
const { normalizeTaskHistory, APPLE_REF_MS } = require('../src/task-history')
const { performTaskWake, wakePlanForTask } = require('../src/wake')

test('all nine platforms remain reachable across pages and filtering clamps the active page', () => {
  const pages = [0, 1, 2].map(index => platformPage(PLATFORMS, index))
  assert.deepEqual(pages.map(page => page.groups.length), [4, 4, 1])
  assert.deepEqual(pages.flatMap(page => page.groups), PLATFORMS)
  assert.equal(platformPage(PLATFORMS.slice(0, 2), 2).index, 0)
  assert.deepEqual(platformPage([], 2).groups, [])
})

test('existing configs show all nine platforms; toggles preserve unrelated config and persisted history', () => {
  const config = { pet: { scale: 0.7 }, platforms: { cursor: { enabled: true, paths: ['/custom/logs'] } } }
  assert.equal(bubblePlatformRows(config).length, 9)
  assert.ok(bubblePlatformRows(config).every(row => row.visible))
  const hidden = setBubblePlatformVisibility(config, 'cursor', false)
  assert.deepEqual(hidden.pet, config.pet)
  assert.deepEqual(hidden.platforms, config.platforms)
  assert.equal(config.hiddenBubblePlatforms, undefined)
  const source = { platforms: PLATFORMS.map(row => ({ platform: row.key, phase: 'running' })),
    history: { platforms: { cursor: [{ id: 'cursor|one', phase: 'done' }], workbuddy: [{ id: 'workbuddy|two', phase: 'failed' }] }, dismissed: ['pi|previous'] } }
  const filtered = filterBubbleSnapshot(source, JSON.parse(JSON.stringify(hidden)))
  assert.equal(filtered.platforms.length, 8)
  assert.equal(filtered.history.platforms.cursor, undefined)
  assert.equal(source.history.platforms.cursor.length, 1)
  assert.deepEqual(filtered.history.dismissed, ['pi|previous'])
  const shown = filterBubbleSnapshot(source, setBubblePlatformVisibility(hidden, 'cursor', true))
  assert.deepEqual(shown.history.platforms.cursor, source.history.platforms.cursor)
  const allHidden = filterBubbleSnapshot(source, setBubblePlatformVisibility(config, 'all', false))
  assert.deepEqual(allHidden.platforms, [])
  assert.deepEqual(allHidden.history.platforms, {})
  assert.equal(bubblePlatformRows(setBubblePlatformVisibility(hidden, 'all', true)).filter(row => row.visible).length, 9)
  assert.throws(() => setBubblePlatformVisibility(config, 'unknown', true))
})

test('native menu bridge carries each platform key and checkbox state', () => {
  const rows = bubblePlatformRows({ hiddenBubblePlatforms: ['zcode', 'pi'] })
  const state = menuBridgeState({ bubblePlatforms: rows })
  assert.equal(state.bubblePlatforms.length, 9)
  assert.deepEqual(state.bubblePlatforms.find(row => row.key === 'zcode'), { key: 'zcode', label: 'Z Code', visible: false })
  assert.equal(state.bubblePlatforms.find(row => row.key === 'workbuddy').visible, true)
})

test('new platforms retain canonical history and dismissed state across reload', () => {
  const platforms = Object.fromEntries(PLATFORMS.map(row => [row.key, [{ sessionID: 'same-id', phase: 'done', updatedAt: 100 }]]))
  const state = normalizeTaskHistory({ platforms, dismissedTaskIDs: ['qoder|same-id'] }, APPLE_REF_MS + 100000)
  assert.equal(state.platforms.qoder, undefined)
  assert.equal(Object.keys(state.platforms).length, 8)
  for (const row of PLATFORMS.filter(row => row.key !== 'qoder')) assert.equal(state.platforms[row.key][0].id, `${row.key}|same-id`)
})

test('every terminal platform acknowledges before an async wake; later results cannot dismiss a new turn', async () => {
  for (const row of PLATFORMS) {
    let dismissals = 0
    let finish
    const gate = new Promise(resolve => { finish = resolve })
    const task = { platform: row.key, phase: 'done', sessionID: 'session', launchOrigin: row.key === 'codex' ? 'codex-desktop' : undefined }
    const dependencies = {
      runtimePlatform: 'darwin',
      dismissTerminalTask() { dismissals++; return true },
      async launchApplication() { await gate; return { succeeded: true } },
      async openExternal() { await gate },
      async reuseDSHTab() { await gate; return { status: 'reused' } },
      async presentFallback(plan) { await gate; return { succeeded: false, message: plan.message } }
    }
    const pending = performTaskWake(task, dependencies)
    assert.equal(dismissals, 1, row.key)
    finish()
    const result = await pending
    assert.equal(result.acknowledged, true, row.key)
    assert.equal(dismissals, 1, row.key)
    await performTaskWake({ ...task, phase: 'running' }, dependencies)
    assert.equal(dismissals, 1, `active ${row.key}`)
  }
})

test('new desktop platforms activate their app without inventing a conversation URI; pi does not spawn a duplicate', () => {
  for (const platform of ['cursor', 'workbuddy', 'qoder', 'zcode']) {
    const plan = wakePlanForTask({ platform, sessionID: 'untrusted-id;$(touch /tmp/no)' }, 'darwin')
    assert.equal(plan.kind, 'application')
    assert.equal(plan.exact, false)
    assert.equal(plan.args[0], '-a')
    assert.ok(!JSON.stringify(plan.args).includes('untrusted-id'))
  }
  for (const os of ['darwin', 'linux', 'win32']) {
    const plan = wakePlanForTask({ platform: 'pi', sessionID: 'session' }, os)
    assert.equal(plan.kind, 'fallback')
    assert.equal(plan.canOpenPlatform, false)
  }
})
