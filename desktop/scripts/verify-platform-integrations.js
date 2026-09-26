'use strict'

// Real sidecar + native provider formats in a disposable home. No installed platform is touched.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const crypto = require('node:crypto')
let binary = process.env.ALLPET_BINARY
if (!binary) {
  const query = spawnSync('swift', ['build', '-c', 'release', '--show-bin-path'], { encoding: 'utf8', timeout: 30000 })
  if (query.status !== 0) throw query.error || new Error(query.stderr || 'Cannot locate release sidecar')
  binary = path.join(query.stdout.trim().split(/\r?\n/).at(-1), process.platform === 'win32' ? 'allpet.exe' : 'allpet')
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'allpet-integrations-'))
const environment = { ...process.env, ALLPET_HOME: home,
  ALLPET_SQLITE_EXECUTABLE: process.env.ALLPET_ELECTRON_BINARY || process.execPath,
  ALLPET_SQLITE_SCRIPT: path.resolve(__dirname, 'sqlite-read.js') }
function run(args, input) {
  const result = spawnSync(binary, args, { env: environment, encoding: 'utf8', input, timeout: 15000 })
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || result.stdout)
  return result.stdout
}
function write(file, rows) {
  const target = path.join(home, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  return target
}
function hook(platform, event, id) {
  assert.equal(run(['hook', platform], JSON.stringify({ hook_event_name: event, session_id: id, cwd: '/fixture/project', prompt: 'private prompt never stored' })).trim(), '{}')
}
let db, watcher
async function main() {
  run(['init'])
  write('.workbuddy/projects/demo/wb-main.jsonl', [
    { type: 'message', role: 'user', sessionId: 'wb-main', content: [{ type: 'input_text', text: 'WorkBuddy integration' }] },
    { type: 'ai-title', aiTitle: 'WorkBuddy stable title' },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done' }] }
  ])
  write('.workbuddy/projects/demo/subagents/child.jsonl', [{ type: 'message', role: 'user', sessionId: 'child', content: 'hidden child' }])
  write('.pi/agent/sessions/project/pi-main.jsonl', [
    { type: 'session', version: 3, id: 'pi-main', cwd: '/fixture/project' },
    { type: 'session_info', name: 'pi stable title' },
    { type: 'message', id: 'entry-id', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'true' } }] } }
  ])
  write('.qoder/projects/project/q-main.jsonl', [{ type: 'user', sessionId: 'q-main', message: { role: 'user', content: 'Qoder fixture' } }])
  write('.cursor/projects/project/agent-transcripts/c-main/c-main.jsonl', [{ role: 'user', message: { role: 'user', content: 'Cursor fixture' } }])
  write('.qoder/projects/project/subagent/q-child.jsonl', [{ type: 'user', sessionId: 'q-child', message: { role: 'user', content: 'hidden child' } }])
  write('.cursor/projects/project/agent-transcripts/subagents/c-child.jsonl', [{ role: 'user', message: { role: 'user', content: 'hidden child' } }])
  // Hook metadata can contain Windows paths even when this verifier runs on macOS/Linux.
  for (const transcript of ['C:\\project\\subagents\\child.jsonl', 'C:/project/subagent/child.jsonl']) {
    const hookInput = { hook_event_name: 'stop', session_id: 'hook-child', transcript_path: transcript }
    assert.equal(run(['hook', 'cursor'], JSON.stringify(hookInput)).trim(), '{}')
  }
  hook('qoder', 'PermissionRequest', 'q-main')
  hook('cursor', 'stop', 'c-main')
  const events = path.join(home, '.config/all-pet/events/cursor')
  assert.ok(!fs.readFileSync(path.join(events, fs.readdirSync(events)[0]), 'utf8').includes('private prompt'))
  for (const platform of ['cursor', 'qoder']) {
    run(['integrations', 'install', platform])
    const file = path.join(home, platform === 'cursor' ? '.cursor/hooks.json' : '.qoder/settings.json')
    const before = fs.readFileSync(file, 'utf8')
    run(['integrations', 'install', platform])
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  }
  const database = path.join(home, '.zcode/cli/db/db.sqlite')
  fs.mkdirSync(path.dirname(database), { recursive: true })
  db = new DatabaseSync(database)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session (id TEXT PRIMARY KEY,title TEXT,directory TEXT,time_updated INTEGER,time_archived INTEGER,task_type TEXT,parent_id TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,sequence INTEGER,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,sequence INTEGER,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE todo (session_id TEXT,status TEXT);`)
  const now = Date.now()
  for (const [id, type] of [['z-main', 'interactive'], ['z-fork', 'fork'], ['z-child', 'subagent_child']]) {
    db.prepare('INSERT INTO session VALUES (?,?,?,?,NULL,?,?)').run(id, `Z Code ${id}`, '/fixture/project', now, type, type === 'interactive' ? null : 'z-main')
    db.prepare('INSERT INTO message VALUES (?,?,0,?,?,?)').run(`${id}-message`, id, now, now, JSON.stringify({ role: 'assistant', finish: 'stop' }))
  }
  db.exec("INSERT INTO todo VALUES ('z-main','completed'),('z-main','pending')")
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(database)).update(fs.readFileSync(database + '-wal')).digest('hex')
  const beforeHash = hash()
  const snapshot = JSON.parse(run(['status', '--json']))
  const platforms = Object.fromEntries(snapshot.platforms.map(row => [row.platform, row]))
  assert.equal(snapshot.platforms.length, 9)
  assert.equal(platforms.workbuddy.tasks.length, 1)
  assert.equal(platforms.workbuddy.task.sessionName, 'WorkBuddy stable title')
  assert.equal(platforms.workbuddy.task.phase, 'done')
  assert.equal(platforms.pi.task.sessionID, 'pi-main')
  assert.equal(platforms.pi.task.phase, 'running')
  assert.equal(platforms.qoder.task.phase, 'waiting')
  assert.equal(platforms.qoder.tasks.length, 1)
  assert.equal(platforms.cursor.tasks.length, 1)
  assert.equal(platforms.cursor.task.phase, 'done')
  assert.equal(platforms.cursor.task.sessionName, 'Cursor fixture')
  assert.deepEqual(platforms.zcode.tasks.map(row => row.sessionID).sort(), ['z-fork', 'z-main'])
  const zmain = platforms.zcode.tasks.find(row => row.sessionID === 'z-main')
  assert.equal(zmain.completedSteps, 1)
  assert.equal(zmain.totalSteps, 2)
  assert.equal(zmain.phase, 'done')
  assert.equal(hash(), beforeHash, 'reader must not change database or WAL contents')

  // Keep a single monitor alive: a WAL-only update must invalidate its cached snapshot.
  watcher = spawn(binary, ['watch', '--json'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    let pending = '', changed = false
    const timeout = setTimeout(() => reject(new Error('WAL update did not reach watch snapshot')), 10000)
    watcher.once('error', reject)
    watcher.stdout.on('data', data => {
      pending += data
      for (let newline; (newline = pending.indexOf('\n')) >= 0;) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
        try {
          const state = JSON.parse(line).platforms.find(row => row.platform === 'zcode')
          if (!changed) {
            changed = true
            const next = Date.now() + 1
            db.prepare('UPDATE message SET data=?,time_updated=? WHERE id=?').run(JSON.stringify({ role: 'assistant', error: { name: 'FixtureError' } }), next, 'z-main-message')
            db.prepare('UPDATE session SET time_updated=? WHERE id=?').run(next, 'z-main')
          } else if (state.tasks.some(row => row.sessionID === 'z-main' && row.phase === 'failed')) {
            clearTimeout(timeout); resolve()
          }
        } catch (error) { clearTimeout(timeout); reject(error) }
      }
    })
  })
  console.log('Native integrations verified: nine platforms, five native formats, hook merge/privacy/idempotence, cross-platform child-path filtering, read-only SQLite, live WAL invalidation.')
}
main().finally(async () => {
  if (watcher?.pid && watcher.exitCode === null && watcher.signalCode === null) {
    await new Promise(resolve => { watcher.once('close', resolve); watcher.kill() })
  }
  if (db) db.close()
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}).catch(error => { console.error(error); process.exitCode = 1 })
