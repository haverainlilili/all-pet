'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  failedExternalWakePlan, isCodexCLI, isTrustedMainFrame, mergeDefined, pickLaunchCandidate,
  platformLaunchSpec, rendererSnapshot, runCommandLauncher, wakePlanForTask
} = require('../src/wake')

test('verified Codex Desktop origin uses encoded thread deep-link plan', () => {
  const plan = wakePlanForTask({ platform: 'codex', sessionID: 'thread/with space', launchOrigin: 'codex-desktop' })
  assert.deepEqual(plan, {
    kind: 'external',
    platform: 'codex',
    url: 'codex://threads/thread%2Fwith%20space',
    message: null
  })
})

test('Codex CLI never silently opens or duplicates a task', () => {
  assert.equal(isCodexCLI({ launchOrigin: 'codex-cli' }), true)
  const plan = wakePlanForTask({ platform: 'codex', sessionID: 'abc', launchOrigin: 'codex-cli' })
  assert.equal(plan.kind, 'fallback')
  assert.equal(plan.canOpenPlatform, false)
  assert.match(plan.message, /Codex CLI/)
})

test('terminal binding also classifies unknown Codex origin as CLI', () => {
  const plan = wakePlanForTask({ platform: 'codex', sessionID: 'abc', terminalBinding: { tty: 'ttys001' } })
  assert.equal(plan.kind, 'fallback')
})

test('Claude and Grok fail closed without duplicate-task launch', () => {
  for (const platform of ['claude', 'grok']) {
    const plan = wakePlanForTask({ platform, sessionID: `${platform}-session` })
    assert.equal(plan.kind, 'fallback')
    assert.equal(plan.platform, platform)
    assert.equal(plan.canOpenPlatform, false)
    assert.ok(plan.message.length > 10)
  }
})

test('DSH only offers an explicit non-exact base-page fallback', () => {
  const plan = wakePlanForTask({ platform: 'dsh', sessionID: 'session-123' })
  assert.equal(plan.kind, 'fallback')
  assert.equal(plan.canOpenPlatform, true)
  assert.match(plan.message, /继续保留/)
})

test('Codex with missing or unknown launch origin never sends a deep link', () => {
  for (const launchOrigin of [undefined, '', 'unknown', 'codex-cli']) {
    const plan = wakePlanForTask({ platform: 'codex', sessionID: 'thread-123', launchOrigin })
    assert.equal(plan.kind, 'fallback')
    assert.equal(plan.canOpenPlatform, false)
  }
})

test('missing task cannot open any platform', () => {
  assert.deepEqual(wakePlanForTask(null), {
    kind: 'missing',
    platform: null,
    canOpenPlatform: false,
    message: '任务记录已不存在，未打开其他平台或会话。'
  })
})

test('DSH platform launch uses shell external URL on every OS', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.deepEqual(platformLaunchSpec('dsh', platform), { kind: 'external', url: 'http://127.0.0.1:3080/' })
  }
})

test('platform command selection stays deterministic across OSes', () => {
  assert.deepEqual(platformLaunchSpec('codex', 'darwin'), { kind: 'command', command: 'open', args: ['-a', 'Codex'] })
  assert.deepEqual(platformLaunchSpec('claude', 'win32'), {
    kind: 'command',
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'start \"\" claude']
  })
  const linux = platformLaunchSpec('grok', 'linux')
  assert.equal(linux.kind, 'commandCandidates')
  assert.deepEqual(linux.candidates[0], { command: 'x-terminal-emulator', args: ['-e', 'grok'] })
  assert.ok(linux.candidates.some(candidate => candidate.command === 'gnome-terminal'))
  assert.ok(linux.candidates.some(candidate => candidate.command === 'xterm'))
  assert.equal(platformLaunchSpec('unknown', 'linux'), null)
})


test('partial snapshot merge never erases existing wake locators', () => {
  const previous = {
    id: 'codex|abc',
    sourcePath: '/tmp/session.jsonl',
    launchOrigin: 'codex-desktop',
    processID: 42,
    terminalBinding: { tty: 'ttys001', anchorProcessID: 42 }
  }
  const merged = mergeDefined(previous, { action: '继续执行', sourcePath: undefined, processID: undefined })
  assert.equal(merged.action, '继续执行')
  assert.equal(merged.sourcePath, previous.sourcePath)
  assert.equal(merged.processID, 42)
  assert.deepEqual(merged.terminalBinding, previous.terminalBinding)
})


test('renderer snapshot includes display data but strips every wake locator', () => {
  const safe = rendererSnapshot({
    observedAt: 'now',
    animation: 'running',
    phase: 'running',
    summary: 'Codex 运行中',
    platforms: [{
      platform: 'codex',
      label: 'Codex',
      phase: 'running',
      phaseLabel: '运行中',
      detail: '执行测试',
      activeSessions: 1,
      enabled: true,
      task: {
        sessionName: '会话 A', sessionID: 'thread-1', action: '执行测试', phase: 'running',
        sourcePath: '/secret/transcript.jsonl', workingDirectory: '/secret/project',
        processID: 42, terminalTTY: '/dev/ttys001',
        terminalBinding: { tty: '/dev/ttys001', anchorProcessID: 42 }, launchOrigin: 'codex-desktop'
      },
      tasks: []
    }]
  })
  assert.equal(safe.platforms[0].task.sessionID, 'thread-1')
  assert.equal(safe.platforms[0].task.action, '执行测试')
  for (const field of ['sourcePath', 'workingDirectory', 'processID', 'terminalTTY', 'terminalBinding', 'launchOrigin']) {
    assert.equal(Object.hasOwn(safe.platforms[0].task, field), false, field)
  }
})

test('wake IPC trust accepts only the pinned local main frame', () => {
  const expectedURL = 'file:///app/src/renderer.html'
  const mainFrame = { url: expectedURL }
  const webContents = { mainFrame }
  const mainWindow = { webContents, isDestroyed: () => false }
  assert.equal(isTrustedMainFrame({ sender: webContents, senderFrame: mainFrame }, mainWindow, expectedURL), true)
  assert.equal(isTrustedMainFrame({ sender: {}, senderFrame: mainFrame }, mainWindow, expectedURL), false)
  assert.equal(isTrustedMainFrame({ sender: webContents, senderFrame: {} }, mainWindow, expectedURL), false)
  const remoteFrame = { url: 'https://evil.example/' }
  const navigatedContents = { mainFrame: remoteFrame }
  assert.equal(isTrustedMainFrame(
    { sender: navigatedContents, senderFrame: remoteFrame },
    { ...mainWindow, webContents: navigatedContents },
    expectedURL
  ), false)
  assert.equal(isTrustedMainFrame(
    { sender: webContents, senderFrame: mainFrame },
    { ...mainWindow, isDestroyed: () => true },
    expectedURL
  ), false)
})


test('rejected Codex deep-link handoff cannot fall back to a new app or CLI session', () => {
  const plan = failedExternalWakePlan({ platform: 'codex' }, 'no handler')
  assert.equal(plan.kind, 'fallback')
  assert.equal(plan.platform, 'codex')
  assert.equal(plan.canOpenPlatform, false)
  assert.match(plan.message, /未打开应用首页/)
})


test('missing Linux terminal candidate fails instead of spawning headless CLI', () => {
  const spec = platformLaunchSpec('codex', 'linux')
  assert.equal(pickLaunchCandidate(spec.candidates, () => false), null)
  const selected = pickLaunchCandidate(spec.candidates, command => command === 'konsole')
  assert.equal(selected.command, 'konsole')
})

test('launcher reports asynchronous spawn error and nonzero exit as failure', async () => {
  const errorChild = new EventEmitter()
  errorChild.unref = () => {}
  const errorPromise = runCommandLauncher(() => errorChild, 'missing', [], 100)
  queueMicrotask(() => errorChild.emit('error', new Error('ENOENT')))
  const errorResult = await errorPromise
  assert.equal(errorResult.succeeded, false)
  assert.equal(errorResult.openedApp, false)
  assert.match(errorResult.message, /ENOENT/)

  const exitChild = new EventEmitter()
  exitChild.unref = () => {}
  const exitPromise = runCommandLauncher(() => exitChild, 'open', [], 100)
  queueMicrotask(() => {
    exitChild.emit('spawn')
    exitChild.emit('exit', 1, null)
  })
  const exitResult = await exitPromise
  assert.equal(exitResult.succeeded, false)
  assert.equal(exitResult.requested, false)
  assert.match(exitResult.message, /code=1/)
})

test('successful launcher exit reports request accepted, never openedApp', async () => {
  const child = new EventEmitter()
  child.unref = () => {}
  const promise = runCommandLauncher(() => child, 'open', [], 100)
  queueMicrotask(() => {
    child.emit('spawn')
    child.emit('exit', 0, null)
  })
  const result = await promise
  assert.equal(result.succeeded, true)
  assert.equal(result.requested, true)
  assert.equal(result.openedApp, false)
  assert.equal(result.exact, false)
})
