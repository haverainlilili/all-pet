'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  APPLE_REF_MS, DONE_TTL_SECONDS, accumulateTaskHistory, canonicalID, dismissPlatformHistory,
  dismissTaskHistory, expireTaskHistory, sessionDisplayName
} = require('../src/task-history')
const { graphemePrefix, platformMenuTitles, platformStatusTitle, scalePercentText, petTrayActionTitles, petTrayRows } = require('../src/tray-menu')

function state(platforms = {}, dismissed = [], hidden = {}) { return { platforms, dismissed, hidden } }
function task(sessionID, phase, title = sessionID, extra = {}) {
  return { sessionID, phase, title, action: `action:${title}`, ...extra }
}
function snapshot(platform, phase, tasks) {
  return { platforms: [{ platform, label: platform, phase, phaseLabel: phase, detail: phase, task: tasks[0], tasks }] }
}

test('canonical IDs and display names match AppKit scheduled and DSH rules', () => {
  assert.equal(canonicalID('claude', { scheduledTaskName: 'daily' }), 'claude|scheduled:daily')
  assert.equal(canonicalID('dsh', { sessionID: '123e4567-e89b-12d3-a456-426614174000' }), 'dsh|session-123e4567-e89b-12d3-a456-426614174000')
  assert.equal(sessionDisplayName({ scheduledTaskName: 'daily' }), '定时任务 · daily')
  assert.equal(sessionDisplayName({ sessionID: 'session-1234567890' }), '会话 12345678')
})

test('idle pruning keeps only done and failed terminal cards', () => {
  const value = state({ codex: [
    { id: 'codex|a', phase: 'running' }, { id: 'codex|b', phase: 'waiting' },
    { id: 'codex|c', phase: 'done', updatedAt: 10 }, { id: 'codex|d', phase: 'failed', updatedAt: 10 }
  ] })
  assert.equal(accumulateTaskHistory(value, snapshot('codex', 'idle', []), APPLE_REF_MS + 20_000), true)
  assert.deepEqual(value.platforms.codex.map(item => item.id), ['codex|c', 'codex|d'])
})

test('primary session switch prunes zombies then re-adds concurrent sessions', () => {
  const value = state({ codex: [
    { id: 'codex|old', phase: 'running', updatedAt: 1 },
    { id: 'codex|done', phase: 'done', updatedAt: 10 }
  ] })
  accumulateTaskHistory(value, snapshot('codex', 'running', [task('new', 'running'), task('other', 'waiting')]), APPLE_REF_MS + 20_000)
  assert.deepEqual(new Set(value.platforms.codex.map(item => item.id)), new Set(['codex|done', 'codex|new', 'codex|other']))
  assert.equal(value.platforms.codex.some(item => item.id === 'codex|old'), false)
})

test('partial snapshots retain private wake locators in persisted history', () => {
  const value = state({ codex: [{
    id: 'codex|same', platform: 'codex', phase: 'running', title: 'old', updatedAt: 1,
    sourcePath: '/private/transcript', launchOrigin: 'codex-desktop', terminalBinding: { tty: 'ttys001' }
  }] })
  accumulateTaskHistory(value, snapshot('codex', 'running', [task('same', 'running', 'new')]))
  const merged = value.platforms.codex[0]
  assert.equal(merged.sourcePath, '/private/transcript')
  assert.equal(merged.launchOrigin, 'codex-desktop')
  assert.deepEqual(merged.terminalBinding, { tty: 'ttys001' })
})

test('terminal cards expire after 24 hours and dismissed IDs cap at 100', () => {
  const now = APPLE_REF_MS + 200000 * 1000
  const old = 200000 - DONE_TTL_SECONDS - 1
  const value = state({ codex: [
    { id: 'codex|done', phase: 'done', updatedAt: old },
    { id: 'codex|failed', phase: 'failed', updatedAt: old }
  ] }, Array.from({ length: 100 }, (_, index) => `old-${index}`))
  accumulateTaskHistory(value, { platforms: [] }, now)
  assert.deepEqual(value.platforms.codex, [])
  assert.equal(value.dismissed.length, 100)
  assert.deepEqual(value.dismissed.slice(-2), ['codex|done', 'codex|failed'])
})

test('unchanged terminal snapshots preserve completion time and wall-clock expiry works without a new snapshot', () => {
  const started = APPLE_REF_MS + 300000 * 1000
  const value = state()
  const done = snapshot('codex', 'done', [task('same', 'done')])
  accumulateTaskHistory(value, done, started)
  const completedAt = value.platforms.codex[0].updatedAt
  accumulateTaskHistory(value, done, started + (DONE_TTL_SECONDS - 60) * 1000)
  assert.equal(value.platforms.codex[0].updatedAt, completedAt)
  assert.equal(expireTaskHistory(value, started + (DONE_TTL_SECONDS + 1) * 1000), true)
  assert.deepEqual(value.platforms.codex, [])
  assert.ok(value.dismissed.includes('codex|same'))
})

test('manual hidden tasks stay hidden until their title changes', () => {
  const value = state({}, [], { 'codex|same': 'same title' })
  accumulateTaskHistory(value, snapshot('codex', 'running', [task('same', 'running', 'same title')]))
  assert.deepEqual(value.platforms.codex || [], [])
  accumulateTaskHistory(value, snapshot('codex', 'running', [task('same', 'running', 'new title')]))
  assert.equal(value.platforms.codex[0].title, 'new title')
  assert.equal(value.hidden['codex|same'], undefined)
})

test('history and dismiss collections enforce AppKit 12 and 100 limits', () => {
  const tasks = Array.from({ length: 15 }, (_, index) => task(`s${index}`, 'done'))
  const value = state()
  accumulateTaskHistory(value, snapshot('claude', 'done', tasks))
  assert.equal(value.platforms.claude.length, 12)
  for (let index = 0; index < 105; index += 1) {
    const id = `claude|dismiss-${index}`
    value.platforms.claude = [{ id, phase: 'done', title: id }]
    dismissTaskHistory(value, id)
  }
  assert.equal(value.dismissed.length, 100)
  assert.equal(value.dismissed[0], 'claude|dismiss-5')
})

test('platform dismiss includes live tasks and uses terminal versus hidden semantics', () => {
  const value = state({ dsh: [{ id: 'dsh|done', phase: 'done', title: 'done' }] })
  const live = { platform: 'dsh', phase: 'running', tasks: [task('active', 'running', 'active title')] }
  dismissPlatformHistory(value, 'dsh', live)
  assert.deepEqual(value.platforms.dsh, [])
  assert.ok(value.dismissed.includes('dsh|done'))
  assert.equal(value.hidden['dsh|active'], 'active title')
})

test('tray menu text matches AppKit action, grapheme, scale, and pet rows', () => {
  const action = '😀'.repeat(30)
  assert.equal(Array.from(graphemePrefix(action, 28)).length, 28)
  assert.equal(platformStatusTitle({ label: 'Codex', phaseLabel: '运行中', task: { action } }), `Codex：运行中 · ${'😀'.repeat(28)}`)
  assert.deepEqual(platformMenuTitles([{ platform: 'dsh', phaseLabel: '运行中', task: { action: '执行测试' } }]), [
    'Codex：加载中…', 'Claude Code：加载中…', 'DSH：运行中 · 执行测试', 'Grok：加载中…'
  ])
  assert.equal(scalePercentText(112 / 192), '100%')
  assert.equal(scalePercentText((112 / 192) + 0.05), '109%')
  assert.deepEqual(petTrayActionTitles(true), {
    install: '从 GitHub 安装宠物…', importLocal: '导入本地宠物…', deletePet: '删除宠物…', refresh: '刷新宠物目录'
  })
  assert.equal(petTrayActionTitles(false).importLocal, '导入本地宠物（仅 macOS）')
  assert.deepEqual(petTrayRows([{ displayName: 'Boba', directoryPath: '/pets/boba', current: true }], [{ displayName: '奶龙', slug: 'nai-long-2' }]), {
    installed: [{ kind: 'installed', label: 'Boba', current: true, target: '/pets/boba' }],
    pending: [{ kind: 'default', label: '奶龙', source: 'nai-long-2' }]
  })
})
