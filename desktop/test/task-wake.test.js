'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { performTaskWake } = require('../src/wake')
const { accumulateTaskHistory, canonicalID, dismissTaskHistory, normalizeTaskHistory } = require('../src/task-history')

function snapshot(task) {
  return { platforms: [{ platform: task.platform, phase: task.phase, task, tasks: [task] }] }
}

function harness(input, runtimePlatform = 'darwin', overrides = {}) {
  const task = { sessionID: 'same-session', title: '任务', ...input }
  task.id = canonicalID(task.platform, task)
  const state = { platforms: {}, dismissed: [], hidden: {} }
  accumulateTaskHistory(state, snapshot(task))
  const calls = []
  let saved = null
  const handlers = {
    runtimePlatform,
    dismissTerminalTask(clickedTask) {
      calls.push(['dismiss', clickedTask.id])
      const changed = dismissTaskHistory(state, clickedTask.id)
      if (changed) saved = JSON.parse(JSON.stringify({ platforms: state.platforms, dismissedTaskIDs: state.dismissed }))
      return changed
    },
    async launchApplication(command, args) {
      calls.push(['application', command, args])
      return { succeeded: true, requested: true, exact: false, openedApp: false }
    },
    async openExternal(url) { calls.push(['external', url]) },
    async reuseDSHTab(url) {
      calls.push(['reuse', url])
      return { status: 'missing' }
    },
    async presentFallback(plan) {
      calls.push(['fallback', plan])
      return { succeeded: false, exact: false, openedApp: false, message: plan.message }
    },
    ...overrides
  }
  return { task, state, calls, saved: () => saved, run: () => performTaskWake(task, handlers) }
}

test('Claude done and failed clicks persist acknowledgement before Desktop activation', async () => {
  for (const phase of ['done', 'failed']) {
    const h = harness({ platform: 'claude', phase, launchOrigin: 'claude-desktop-3p' })
    const result = await h.run()
    assert.deepEqual(h.calls.slice(0, 2), [
      ['dismiss', h.task.id],
      ['application', '/usr/bin/open', ['-b', 'com.anthropic.claudefordesktop']]
    ])
    assert.equal(result.acknowledged, true)
    assert.equal(result.exact, false)
    assert.match(result.message, /发送激活请求.*侧栏.*已确认该任务通知/)
    assert.doesNotMatch(result.message, /卡片.*保留/)
    assert.deepEqual(h.state.platforms.claude, [])
    const reloaded = normalizeTaskHistory(h.saved())
    accumulateTaskHistory(reloaded, snapshot(h.task))
    assert.deepEqual(reloaded.platforms.claude || [], [])
    assert.ok(reloaded.dismissed.includes(h.task.id))
  }
})

test('Claude unsupported CLI and OS targets still acknowledge terminal notices without starting a process', async () => {
  for (const runtimePlatform of ['darwin', 'win32', 'linux']) {
    for (const phase of ['done', 'failed']) {
      const h = harness({ platform: 'claude', phase, launchOrigin: 'claude-cli' }, runtimePlatform)
      const result = await h.run()
      assert.deepEqual(h.calls.map(call => call[0]), ['dismiss', 'fallback'])
      assert.equal(result.succeeded, false)
      assert.equal(result.exact, false)
      assert.equal(result.acknowledged, true)
      assert.match(h.calls[1][1].message, /不会启动新的 Claude 进程.*已确认该任务通知/)
      assert.doesNotMatch(result.message, /卡片.*保留/)
    }
  }
})

test('failed Claude activation retains the failure result while removing its terminal notice', async () => {
  const h = harness({ platform: 'claude', phase: 'done', launchOrigin: 'claude-desktop-3p' }, 'darwin', {
    async launchApplication() { return { succeeded: false, message: 'ENOENT' } }
  })
  const result = await h.run()
  assert.equal(result.succeeded, false)
  assert.equal(result.acknowledged, true)
  assert.equal(result.exact, false)
  assert.match(result.message, /ENOENT.*已确认该任务通知/)
  assert.doesNotMatch(result.message, /卡片.*保留/)
  assert.deepEqual(h.state.platforms.claude, [])
})

test('active Claude tasks never become dismissed when clicked', async () => {
  for (const phase of ['running', 'thinking', 'waiting', 'idle']) {
    for (const launchOrigin of ['claude-cli', 'claude-desktop-3p']) {
      const h = harness({ platform: 'claude', phase, launchOrigin })
      const before = structuredClone(h.state)
      const result = await h.run()
      assert.equal(Boolean(result.acknowledged), false)
      assert.equal(h.calls.some(call => call[0] === 'dismiss'), false)
      assert.deepEqual(h.state, before)
      assert.match(result.message, /任务卡片会继续保留/)
    }
  }
})

test('new concurrent activity and completion survive an older Claude wake callback', async () => {
  for (const newPhase of ['running', 'done']) {
    let finishLaunch
    const h = harness({ platform: 'claude', phase: 'done', launchOrigin: 'claude-desktop-3p' }, 'darwin', {
      launchApplication: () => new Promise(resolve => { finishLaunch = resolve })
    })
    const pending = h.run()
    assert.deepEqual(h.state.platforms.claude, [])
    // The acknowledged session is not the first task in this concurrent snapshot.
    const active = { ...h.task, phase: 'running', title: '新一轮任务' }
    const other = { ...h.task, sessionID: 'another-session', phase: 'running', title: '其它任务' }
    accumulateTaskHistory(h.state, { platforms: [{ platform: 'claude', phase: 'running', tasks: [other, active] }] })
    assert.equal(h.state.dismissed.includes(h.task.id), false)
    if (newPhase === 'done') accumulateTaskHistory(h.state, snapshot({ ...active, phase: 'done' }))
    finishLaunch({ succeeded: true, requested: true, exact: false })
    await pending
    assert.equal(h.state.platforms.claude.find(item => item.id === h.task.id).phase, newPhase)
    assert.equal(h.calls.filter(call => call[0] === 'dismiss').length, 1)
  }
})

test('all platforms acknowledge terminal clicks before wake attempts, including fallback', async () => {
  for (const input of [
    { platform: 'codex', phase: 'done', launchOrigin: 'codex-cli' },
    { platform: 'grok', phase: 'failed' }
  ]) {
    const h = harness(input)
    const result = await h.run()
    assert.equal(Boolean(result.acknowledged), true)
    assert.deepEqual(h.calls.map(call => call[0]), ['dismiss', 'fallback'])
    assert.equal(h.state.platforms[input.platform].length, 0)
  }
  const accepted = harness({ platform: 'codex', phase: 'done', launchOrigin: 'codex-desktop' })
  assert.equal((await accepted.run()).succeeded, true)
  assert.deepEqual(accepted.calls.map(call => call[0]), ['dismiss', 'external'])
  const rejected = harness({ platform: 'codex', phase: 'done', launchOrigin: 'codex-desktop' }, 'darwin', {
    async openExternal() { throw new Error('no handler') }
  })
  assert.equal((await rejected.run()).succeeded, false)
  assert.equal(rejected.calls.some(call => call[0] === 'dismiss'), true)
  assert.equal(rejected.state.platforms.codex.length, 0)
  const blockedDSH = harness({ platform: 'dsh', phase: 'done' }, 'darwin', {
    async reuseDSHTab() { return { status: 'blocked', message: '拒绝自动化权限' } }
  })
  assert.equal((await blockedDSH.run()).succeeded, false)
  assert.deepEqual(blockedDSH.calls.map(call => call[0]), ['dismiss', 'fallback'])
  assert.equal(blockedDSH.state.platforms.dsh.length, 0)
})
