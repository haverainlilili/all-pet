'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { completedCodexTasks, dismissViewedTasks, unreadGroups, readCodexUnread,
  createReadTransitionTracker, createManualViewMonitor } = require('../src/manual-view')
const { accumulateTaskHistory, APPLE_REF_MS, normalizeTaskHistory } = require('../src/task-history')

const task = (id = 'a', extra = {}) => ({ id: `codex|${id}`, platform: 'codex', sessionID: id,
  phase: 'done', updatedAt: 100, title: 'task', launchOrigin: 'codex-desktop', ...extra })
const state = (...tasks) => ({ platforms: { codex: tasks }, dismissed: [], hidden: {} })
const groups = (ids = [], identity = 'account', host = 'local:host') => unreadGroups({
  version: 1, unreadByIdentity: { [identity]: { [host]: ids } }
})

function harness(initial = state(task())) {
  let clock = 0, tick, unread = groups(['a']), hidden = [], sends = [], persisted = []
  const monitor = createManualViewMonitor({ getState: () => initial, hiddenPlatforms: () => hidden,
    readUnread: () => unread, sendCheck: request => { sends.push(request); return true },
    onDismiss: next => persisted.push(JSON.parse(JSON.stringify(next))), now: () => clock,
    schedule: (callback, interval) => { assert.equal(interval, 500); tick = callback; return 1 }, cancel: () => { tick = null } })
  return { monitor, initial, sends, persisted, tick: () => tick(), clock: value => { clock = value },
    unread: value => { unread = value }, hidden: value => { hidden = value } }
}

test('only completed visible Codex tasks are eligible for automatic acknowledgement', () => {
  const value = state(task(), task('running', { phase: 'running' }), task('failed', { phase: 'failed' }))
  assert.deepEqual(completedCodexTasks(value).map(t => t.id), ['codex|a'])
  assert.deepEqual(completedCodexTasks(value, ['codex']), [])
})

test('independent timer clears viewed task without a new transcript snapshot and persists dismissal', () => {
  const h = harness(state(task(), task('b')))
  h.monitor.start()
  assert.equal(h.sends.length, 1)
  h.monitor.receive({ type: 'view-result', requestID: '1', viewedIDs: ['codex|a', 'codex|unknown'] })
  assert.deepEqual(h.initial.platforms.codex.map(t => t.id), ['codex|b'])
  assert.deepEqual(h.persisted[0].dismissed, ['codex|a'])
  const reloaded = normalizeTaskHistory({ platforms: h.initial.platforms, dismissedTaskIDs: h.initial.dismissed }, APPLE_REF_MS + 101000)
  accumulateTaskHistory(reloaded, { platforms: [{ platform: 'codex', phase: 'done', tasks: [task()] }] }, APPLE_REF_MS + 101000)
  assert.equal((reloaded.platforms.codex || []).some(t => t.id === 'codex|a'), false)
  h.monitor.stop()
})

test('late native reply cannot dismiss a new turn or an in-progress task', () => {
  for (const replacement of [task('a', { phase: 'running' }), task('a', { updatedAt: 101 })]) {
    const value = state(replacement)
    assert.equal(dismissViewedTasks(value, [task()], ['codex|a']), false)
    assert.equal(value.platforms.codex.length, 1)
  }
})

test('timeout, unsolicited reply, stop and hidden platform never acknowledge a task', () => {
  const h = harness()
  h.monitor.start(); h.tick()
  assert.equal(h.sends.length, 1)
  h.clock(5001); h.tick()
  assert.equal(h.sends.length, 2)
  h.monitor.receive({ type: 'view-result', requestID: '1', viewedIDs: ['codex|a'] })
  h.hidden(['codex'])
  h.monitor.receive({ type: 'view-result', requestID: '2', viewedIDs: ['codex|a'] })
  h.monitor.stop()
  h.monitor.receive({ type: 'view-result', requestID: '2', viewedIDs: ['codex|a'] })
  assert.equal(h.persisted.length, 0)
})

test('bubble navigation rejects its old reply but resumes focus checks within 500 ms', () => {
  const h = harness(); h.monitor.start(); h.monitor.pause()
  h.monitor.receive({ type: 'view-result', requestID: '1', viewedIDs: ['codex|a'] })
  h.clock(250); h.tick(); assert.equal(h.sends.length, 1)
  h.clock(500); h.tick(); assert.equal(h.sends.length, 2)
  assert.equal(h.persisted.length, 0)
  h.monitor.stop()
})

test('exact unread-to-read receipt clears without AX and requires the same completed turn', () => {
  const h = harness(); h.monitor.start(); h.unread(groups()); h.tick()
  assert.deepEqual(h.persisted[0].dismissed, ['codex|a'])
  h.monitor.stop()
  const next = harness(); next.monitor.start(); next.initial.platforms.codex[0].updatedAt++
  next.unread(groups()); next.tick(); assert.equal(next.persisted.length, 0); next.monitor.stop()
})

test('startup absence, account switch, logout, unavailable data and remote host are not read receipts', () => {
  for (const [before, after] of [
    [groups(), groups()], [groups(['a']), groups([], 'new-account')],
    [groups(['a']), new Map()], [groups(['a']), null],
    [groups(['a'], 'account', 'remote:host'), groups([], 'account', 'remote:host')]
  ]) {
    const tracker = createReadTransitionTracker()
    assert.deepEqual(tracker.observe(before, [task()]), [])
    assert.deepEqual(tracker.observe(after, [task()]), [])
  }
})

test('ambiguous unread copy and CLI sessions cannot use desktop read receipts', () => {
  const tracker = createReadTransitionTracker()
  const before = groups(['a']); before.set('other-account', new Set(['a']))
  const after = groups(); after.set('other-account', new Set(['a']))
  tracker.observe(before, [task()]); assert.deepEqual(tracker.observe(after, [task()]), [])
  const cli = createReadTransitionTracker()
  cli.observe(groups(['a']), [task('a', { launchOrigin: 'codex-cli' })])
  assert.deepEqual(cli.observe(groups(), [task()]), [])
})

test('read-state file rejects corrupt, unknown-version, symlink and oversized data', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'allpet-read-state-test-'))
  const dir = path.join(home, '.codex'); fs.mkdirSync(dir)
  const file = path.join(dir, '.codex-global-state.json')
  try {
    assert.equal(readCodexUnread(home), null)
    fs.writeFileSync(file, JSON.stringify({ 'electron-thread-read-state-v1': {
      version: 1, unreadByIdentity: { a: { 'local:host': ['task-id'] } }
    } }))
    assert.deepEqual([...readCodexUnread(home).values()][0], new Set(['task-id']))
    for (const value of ['{', '{}', JSON.stringify({ 'electron-thread-read-state-v1': { version: 2 } }), ' '.repeat(8 * 1024 * 1024 + 1)]) {
      fs.writeFileSync(file, value); assert.equal(readCodexUnread(home), null)
    }
    fs.unlinkSync(file); fs.symlinkSync('/dev/null', file); assert.equal(readCodexUnread(home), null)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

const { completedViewTasks } = require('../src/manual-view')
const platformTask = (platform, id = 'a', extra = {}) => task(id, { platform, id: `${platform}|${id}`, launchOrigin: platform, ...extra })

test('manual checks cover supported platforms and preserve hidden or unsupported task cards', () => {
  const value = { platforms: {}, dismissed: [], hidden: {} }
  for (const platform of ['codex', 'claude', 'dsh', 'grok', 'pi', 'cursor', 'workbuddy', 'qoder', 'zcode']) value.platforms[platform] = [platformTask(platform)]
  assert.deepEqual(completedViewTasks(value, ['pi']).map(t => t.platform), ['codex', 'claude', 'dsh', 'grok'])
  assert.equal(dismissViewedTasks(value, [platformTask('workbuddy')], ['workbuddy|a']), false)
})

test('platform requests proceed independently when a browser check is slow', () => {
  const value = state(task()); value.platforms.dsh = [platformTask('dsh')]
  const h = harness(value); h.monitor.start()
  assert.deepEqual(h.sends.map(r => r.platform), ['codex', 'dsh'])
  h.monitor.receive({ type: 'view-result', requestID: h.sends[0].requestID, viewedIDs: [] })
  h.clock(500); h.tick()
  assert.deepEqual(h.sends.map(r => r.platform), ['codex', 'dsh', 'codex'])
  h.monitor.receive({ type: 'view-result', requestID: h.sends[2].requestID, viewedIDs: ['codex|a', 'dsh|a'] })
  assert.equal(value.platforms.codex.length, 0)
  assert.equal(value.platforms.dsh.length, 1)
  h.monitor.stop()
})

test('Codex read receipts cannot acknowledge matching session IDs from another platform', () => {
  const tracker = createReadTransitionTracker()
  tracker.observe(groups(['a']), [platformTask('claude'), platformTask('pi'), task()])
  assert.deepEqual(tracker.observe(groups(), [platformTask('claude'), platformTask('pi'), task()]).map(t => t.id), ['codex|a'])
})

test('Claude and terminal replies obey new-turn, hidden-platform and persistence protections', () => {
  for (const platform of ['claude', 'dsh', 'grok', 'pi']) {
    const original = platformTask(platform)
    const value = { platforms: { [platform]: [original] }, dismissed: [], hidden: {} }
    assert.equal(dismissViewedTasks(value, [original], [original.id], [platform]), false)
    value.platforms[platform] = [platformTask(platform, 'a', { updatedAt: 101 })]
    assert.equal(dismissViewedTasks(value, [original], [original.id]), false)
    value.platforms[platform] = [original]
    assert.equal(dismissViewedTasks(value, [original], [original.id]), true)
    assert.deepEqual(value.dismissed, [original.id])
  }
})

test('unread baseline survives restart and a read while AllPet is stopped', () => {
  let checkpoint
  const original = task('a', { turnID: 'turn-a', completedAt: 1000 })
  const first = createReadTransitionTracker({ now: () => 2000, onCheckpoint: value => { checkpoint = value } })
  first.observe(groups(['a']), [original])
  const next = createReadTransitionTracker({ checkpoint, now: () => 3000 })
  assert.deepEqual(next.observe(groups(), [original]).map(t => t.id), ['codex|a'])
})

test('receipt before completed snapshot is retained across another restart', () => {
  let checkpoint
  const first = createReadTransitionTracker({ now: () => 2000, onCheckpoint: value => { checkpoint = value } })
  first.observe(groups(['a']), [])
  assert.deepEqual(first.observe(groups(), []), [])
  const next = createReadTransitionTracker({ checkpoint, now: () => 3000 })
  assert.deepEqual(next.observe(groups(), [task('a', { turnID: 'turn-a', completedAt: 1500 })]).map(t => t.id), ['codex|a'])
})

test('a completion after reading is not acknowledged by that old receipt', () => {
  const tracker = createReadTransitionTracker({ now: () => 2000 })
  tracker.observe(groups(['a']), [])
  tracker.observe(groups(), [])
  assert.deepEqual(tracker.observe(groups(), [task('a', { turnID: 'next-turn', completedAt: 2100 })]), [])
  assert.deepEqual(tracker.observe(groups(), [task('a', { turnID: 'old-format-no-time' })]), [])
})

test('persisted read-state mtime bounds the receipt even when the next poll is delayed', () => {
  const tracker = createReadTransitionTracker({ now: () => 5000 })
  tracker.observe(groups(['a']), [])
  const read = groups(); read.observedAt = 2000
  assert.deepEqual(tracker.observe(read, [task('a', { turnID: 'new-turn', completedAt: 3000 })]), [])
})

test('explicit completion identity survives title changes but rejects a new completed turn', () => {
  const original = task('a', { turnID: 'turn-a', completedAt: 1500 })
  const renamed = state({ ...original, title: 'renamed', updatedAt: 1000 })
  assert.equal(dismissViewedTasks(renamed, [original], [original.id]), true)
  for (const extra of [{ turnID: 'turn-b' }, { completedAt: 1501 }]) {
    const changed = state({ ...original, ...extra })
    assert.equal(dismissViewedTasks(changed, [original], [original.id]), false)
  }
})

test('checkpoint stores hashed identities and revisions, without titles or transcript paths', () => {
  let checkpoint
  createReadTransitionTracker({ now: () => 2000, onCheckpoint: value => { checkpoint = value } })
    .observe(groups(['a'], 'private-account'), [task('a', { title: 'private-title', sourcePath: '/private/path' })])
  const text = JSON.stringify(checkpoint)
  for (const secret of ['private-account', 'private-title', '/private/path']) assert.equal(text.includes(secret), false)
})

test('invalid, expired or future checkpoints never make startup absence a read receipt', () => {
  for (const checkpoint of [{ version: 99 }, { version: 1, savedAt: 4000 }, { version: 1, savedAt: -90000000 },
    { version: 1, savedAt: 1000, groups: [null], tasks: [], receipts: [] }]) {
    const tracker = createReadTransitionTracker({ checkpoint, now: () => 3000 })
    assert.deepEqual(tracker.observe(groups(), [task('a', { turnID: 'a', completedAt: 1000 })]), [])
  }
})

test('completion identity persists in history and is removed when the task resumes', () => {
  const original = task('a', { turnID: 'turn-a', completedAt: 1500 })
  const value = normalizeTaskHistory({ platforms: { codex: [original] } }, APPLE_REF_MS + 101000)
  assert.equal(value.platforms.codex[0].completedAt, 1500)
  assert.equal(value.platforms.codex[0].turnID, 'turn-a')
  accumulateTaskHistory(value, { platforms: [{ platform: 'codex', phase: 'running', tasks: [{ ...task(), phase: 'running', turnID: 'turn-b' }] }] })
  assert.equal(value.platforms.codex[0].turnID, 'turn-b')
  assert.equal(value.platforms.codex[0].completedAt, undefined)
})

test('reading while Codex bubbles are hidden does not create a deferred acknowledgement', () => {
  const h = harness(state(task('a', { turnID: 'turn-a', completedAt: 1 })))
  h.clock(2000); h.monitor.start(); h.hidden(['codex']); h.unread(groups()); h.tick()
  h.hidden([]); h.clock(2500); h.tick()
  assert.equal(h.persisted.length, 0)
  h.monitor.stop()
})
