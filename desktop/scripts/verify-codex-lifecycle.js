'use strict'

// Synthetic Codex JSONL only. Uses the real sidecar + Electron history reducer in an isolated home.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { accumulateTaskHistory, dismissTaskHistory } = require('../src/task-history')
let binary = process.env.ALLPET_BINARY
if (!binary) {
  const query = spawnSync('swift', ['build', '-c', 'release', '--show-bin-path'], { encoding: 'utf8', timeout: 30000 })
  if (query.status !== 0) throw query.error || new Error(query.stderr || 'Cannot locate release sidecar')
  binary = path.join(query.stdout.trim().split(/\r?\n/).at(-1), process.platform === 'win32' ? 'allpet.exe' : 'allpet')
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'allpet-codex-lifecycle-'))
const sessions = path.join(home, 'sessions')
const env = { ...process.env, ALLPET_HOME: home }
const activeID = '12345678-1234-4123-8123-123456789000'
const event = (type, data = {}) => ({ type: 'event_msg', payload: { type, ...data } })
const start = (turn, mode) => event('task_started', { turn_id: turn, collaboration_mode_kind: mode })
const done = turn => event('task_complete', { turn_id: turn })
const plan = turn => event('item_completed', { turn_id: turn, item: { type: 'Plan' } })
const prompt = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '同一个任务' }] } }
const tool = { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{}' } }
let checks = 0
function expect(condition, message) { assert.ok(condition, message); checks += 1 }
function write(id, rows, age = 0) {
  const file = path.join(sessions, `${id}.jsonl`)
  const metadata = { type: 'session_meta', payload: { id, source: 'vscode', thread_source: 'user', originator: 'Codex Desktop' } }
  fs.writeFileSync(file, [metadata, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n')
  const date = new Date(Date.now() - age * 1000)
  fs.utimesSync(file, date, date)
}
function snapshot() {
  const result = spawnSync(binary, ['status', '--json'], { env, encoding: 'utf8', timeout: 20000 })
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}
function codex(snap = snapshot()) { return snap.platforms.find(item => item.platform === 'codex') }

try {
  fs.mkdirSync(sessions)
  fs.mkdirSync(path.join(home, '.config', 'all-pet'), { recursive: true })
  fs.writeFileSync(path.join(home, '.config', 'all-pet', 'config.json'), JSON.stringify({
    pet: { enabled: false, scale: 1, anchor: 'bottom-right' },
    watch: { pollIntervalMilliseconds: 1000, activeWindowSeconds: 8, waitingWindowSeconds: 120 },
    platforms: Object.fromEntries(['codex', 'claude', 'dsh', 'grok', 'cursor', 'workbuddy', 'qoder', 'pi', 'zcode'].map(key => [key, { enabled: key === 'codex', paths: key === 'codex' ? [sessions] : [] }]))
  }))

  const planning = [start('planning', 'plan'), prompt, plan('planning')]
  write(activeID, planning, 300)
  expect(codex().task?.phase === 'waiting', 'A confirmed plan awaiting input survives more than 120 seconds of silence')

  write(activeID, [...planning, done('planning')])
  const history = { platforms: {}, dismissed: [], hidden: {} }
  accumulateTaskHistory(history, snapshot())
  expect(dismissTaskHistory(history, `codex|${activeID}`), 'Completed plan can be acknowledged')
  expect(history.dismissed.includes(`codex|${activeID}`), 'Plan acknowledgement is retained before execution starts')

  const executing = [...planning, done('planning'), start('execution', 'default'), prompt, plan('execution')]
  write(activeID, executing)
  let snap = snapshot()
  expect(codex(snap).task?.phase === 'thinking', 'Default-mode Plan updates do not put an executing task into confirmation wait')
  accumulateTaskHistory(history, snap)
  expect(!history.dismissed.includes(`codex|${activeID}`), 'Execution clears the acknowledged plan even when its title is unchanged')
  expect(history.platforms.codex.some(item => item.sessionID === activeID), 'The same task bubble returns for execution')

  write(activeID, [...executing, tool], 300)
  snap = snapshot()
  expect(codex(snap).task?.phase === 'running', 'Long command execution survives five minutes without new JSONL records')
  accumulateTaskHistory(history, snap)
  expect(history.platforms.codex.some(item => item.sessionID === activeID), 'Quiet execution stays in Electron task history')

  for (let i = 1; i <= 5; i++) write(`12345678-1234-4123-8123-12345678900${i}`, [start(`other-${i}`, 'default'), prompt, done(`other-${i}`)])
  let status = codex()
  expect(status.task?.sessionID === activeID && status.tasks.some(item => item.sessionID === activeID), 'Five fresh completions cannot push an executing task out of the visible slots')
  expect(status.tasks.length === 5, 'The five-task limit is preserved')
  for (let i = 1; i <= 5; i++) fs.unlinkSync(path.join(sessions, `12345678-1234-4123-8123-12345678900${i}.jsonl`))

  write(activeID, [...executing, tool, done('planning')])
  expect(codex().task?.phase === 'running', 'A delayed plan completion cannot finish the newer executing turn')
  write(activeID, [done('planning'), prompt])
  expect(codex().task?.phase === 'thinking', 'A real next prompt resets an old completion when task_started is absent from the tail')

  write(activeID, [...executing, tool], 1790)
  expect(codex().task?.phase === 'running', 'Explicit active turn survives until the 30-minute bound')
  write(activeID, [...executing, tool], 1810)
  expect(codex().phase === 'idle', 'A stale unfinished turn still expires at the hard timeout')
  write(activeID, [...executing, done('execution')], 300)
  expect(codex().phase === 'idle', 'The longer scan does not resurrect old completed notifications')
  const completedAt = new Date(Date.now() - 1000)
  write(activeID, [...executing, { ...done('execution'), timestamp: completedAt.toISOString() }])
  const completed = codex().task
  expect(completed.turnID === 'execution', 'Completion exposes the exact Codex turn ID to the desktop')
  expect(completed.completedAt === completedAt.getTime(), 'Completion carries its event time independently of desktop polling time')
  console.log(JSON.stringify({ checks, passed: true, scope: 'Codex plan to execution, silence, turn identity, concurrent tasks, and Electron acknowledgement' }))
} finally {
  fs.rmSync(home, { recursive: true, force: true })
}
