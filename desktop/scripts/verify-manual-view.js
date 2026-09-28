#!/usr/bin/env node
'use strict'
// End-to-end check with disposable AllPet/Codex homes. Never accesses real Codex UI/state.
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert/strict')
const { spawn } = require('child_process')
const { APPLE_REF_MS } = require('../src/task-history')
const binary = process.env.ALLPET_APP_BINARY
if (!binary) throw new Error('Set ALLPET_APP_BINARY to the packaged AllPet executable')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'allpet-manual-view-smoke-'))
const configDir = path.join(root, '.config', 'all-pet')
const codexDir = path.join(root, '.codex')
fs.mkdirSync(configDir, { recursive: true }); fs.mkdirSync(codexDir, { recursive: true })
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ pet: { enabled: false } }))
const historyFile = path.join(configDir, 'task-history.json')
const readFile = path.join(codexDir, '.codex-global-state.json')
const checkpointFile = path.join(configDir, 'codex-read-receipts.json')
const id = '00000000-0000-4000-8000-000000000001'
const task = { id: `codex|${id}`, platform: 'codex', sessionID: id, title: 'isolated manual-view smoke',
  action: 'done', phase: 'done', launchOrigin: 'codex-desktop', turnID: 'first-turn', completedAt: Date.now() - 1000,
  updatedAt: (Date.now() - APPLE_REF_MS) / 1000 }
function writeRead(ids) {
  fs.writeFileSync(`${readFile}.tmp`, JSON.stringify({ 'electron-thread-read-state-v1': {
    version: 1, unreadByIdentity: { fixture: { 'local:fixture': ids } }
  } }))
  fs.renameSync(`${readFile}.tmp`, readFile)
}
function history() { return JSON.parse(fs.readFileSync(historyFile, 'utf8')) }
function checkpoint() { try { return JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) } catch { return null } }
function resetHistory(tasks) { fs.writeFileSync(historyFile, JSON.stringify({ platforms: { codex: tasks }, dismissedTaskIDs: [] })) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, stderr = ''
function launch() {
  child = spawn(binary, [`--user-data-dir=${path.join(root, 'electron')}`], {
    env: { ...process.env, ALLPET_HOME: root }, stdio: ['ignore', 'ignore', 'pipe']
  })
  child.stderr.on('data', chunk => { stderr += chunk })
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const closed = new Promise(resolve => child.once('close', resolve))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
  await closed; clearTimeout(timer)
}
async function until(predicate, label) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`AllPet exited: ${stderr.slice(-1500)}`)
    if (predicate()) return
    await wait(100)
  }
  throw new Error(`Timed out: ${label}; ${stderr.slice(-1000)}`)
}
async function run() {
  fs.writeFileSync(historyFile, JSON.stringify({ platforms: { codex: [task] }, dismissedTaskIDs: [] }))
  writeRead([id]); launch()
  await wait(3000)
  assert.equal(history().platforms.codex.length, 1, 'unread task must stay visible')
  const readAt = Date.now()
  writeRead([])
  await until(() => history().dismissedTaskIDs.includes(task.id), 'read acknowledgement without transcript changes')
  const clearedAfterMs = Date.now() - readAt
  assert.ok(clearedAfterMs < 2000, `read acknowledgement exceeded 2 seconds: ${clearedAfterMs} ms`)
  assert.equal((history().platforms.codex || []).length, 0)
  await stop()
  launch(); await wait(2000)
  assert.equal((history().platforms.codex || []).length, 0, 'read card must stay dismissed after restart')
  assert.equal(history().dismissedTaskIDs.includes(task.id), true)
  await stop()

  // An update/restart must not erase the previously observed unread baseline.
  task.turnID = 'restart-turn'; task.completedAt = Date.now() - 1000
  resetHistory([task]); writeRead([id]); launch()
  await until(() => checkpoint()?.groups.some(([, ids]) => ids.includes(id)), 'persisted unread baseline')
  await stop(); writeRead([])
  const restartedAt = Date.now(); launch()
  await until(() => history().dismissedTaskIDs.includes(task.id), 'read during downtime acknowledged after restart')
  const restartClearedAfterMs = Date.now() - restartedAt
  assert.equal((history().platforms.codex || []).length, 0)
  await stop()

  // A read can precede the first completed transcript snapshot. Preserve the
  // receipt even across a restart, then compare it to the exact completion time.
  task.turnID = 'delayed-snapshot'; task.completedAt = Date.now() - 1000
  resetHistory([]); writeRead([id]); launch()
  await until(() => checkpoint()?.groups.some(([, ids]) => ids.includes(id)), 'second unread baseline')
  writeRead([])
  await until(() => checkpoint()?.receipts.some(([receiptID]) => receiptID === id), 'receipt before completed snapshot')
  await stop(); resetHistory([task]); launch()
  await until(() => history().dismissedTaskIDs.includes(task.id), 'late completed snapshot matched to saved receipt')
  assert.equal((history().platforms.codex || []).length, 0)
  console.log(JSON.stringify({ ok: true, clearedAfterMs, restartClearedAfterMs,
    checks: ['unread retained', 'manual read dismissed without transcript update', 'dismissal persisted after restart',
      'read during update/restart recovered', 'read before completed snapshot recovered after restart'] }))
}
run().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }) })
