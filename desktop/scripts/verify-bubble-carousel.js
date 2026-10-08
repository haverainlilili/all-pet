'use strict'
// Real renderer + production preload, with isolated fixture IPC. Never launches an agent or reads user tasks.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const assert = require('node:assert/strict')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'allpet-carousel-'))
  try {
    for (const mode of ['normal', 'reduced']) {
      const args = [__filename, temporary, mode]
      if (process.env.ALLPET_NO_SANDBOX) args.push('--no-sandbox')
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const run = spawnSync(require('electron'), args, { env, encoding: 'utf8', timeout: 45000 })
      if (run.error || run.status !== 0) throw Error([run.error?.message, run.stdout, run.stderr].filter(Boolean).join('\n'))
      console.log(fs.readFileSync(path.join(temporary, `${mode}.json`), 'utf8').trim())
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
} else {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const rendererRoot = process.env.ALLPET_CAROUSEL_RESOURCES
    ? path.join(process.env.ALLPET_CAROUSEL_RESOURCES, 'app.asar') : path.join(__dirname, '..')
  const [temporary, mode] = process.argv.slice(2)
  app.setPath('userData', path.join(temporary, mode))
  if (mode === 'reduced') app.commandLine.appendSwitch('force-prefers-reduced-motion')
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  let dismissed = null, snapshot
  const task = (platform, name, updatedAt, phase = 'running') => ({ id: `${platform}|${name}`, platform,
    sessionID: name, sessionName: name, title: name, phase, updatedAt, action: 'Fixture' })
  function fixture(entries, done = []) {
    return { platforms: Object.entries(entries).map(([platform, tasks]) => ({ platform, phase: 'running', tasks,
      task: tasks[0], label: platform })), history: { platforms: { ...entries,
        codex: [...(entries.codex || []), ...done] }, dismissed: [], hidden: [] } }
  }
  app.whenReady().then(async () => {
    ipcMain.handle('pets:getScale', () => 112 / 192)
    ipcMain.handle('pets:resizeBubble', () => true)
    ipcMain.handle('pets:dismissTask', (_event, id) => { dismissed = id; return true })
    const win = new BrowserWindow({ width: 380, height: 420, show: false, webPreferences: {
      preload: path.join(rendererRoot, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false
    } })
    const errors = []
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message) })
    await win.loadFile(path.join(rendererRoot, 'src/renderer.html'))
    const evaluate = code => win.webContents.executeJavaScript(code)
    const read = () => evaluate(`(() => {
      const cards = [...document.querySelectorAll('.stack-card')]
      const front = cards.find(c => c.style.zIndex === String(cards.length))
      return { id: front?.dataset.id, title: front?.querySelector('.compact-title')?.textContent,
        dismissID: front?.querySelector('[data-dismiss]')?.dataset.value, cards: cards.length,
        rearOpacity: cards.filter(c => c !== front).map(c => Number(c.style.opacity)).sort(),
        completed: [...document.querySelectorAll('#bubble > .compact-card')].map(c => c.dataset.id),
        stage: document.getElementById('bubble').className,
        reduced: document.getElementById('bubble').dataset.reduceMotion }
    })()`)
    async function send(next) { snapshot = next; win.webContents.send('snapshot', next); await delay(80); return read() }
    async function waitForID(id) {
      const deadline = Date.now() + 4200
      while (Date.now() < deadline) { const state = await read(); if (state.id === id) return state; await delay(80) }
      throw Error(`Carousel did not show ${id}: ${JSON.stringify(await read())}`)
    }
    const A = task('codex', 'Alpha', 3), B = task('codex', 'Beta', 2), C = task('codex', 'Gamma', 1)
    const done = task('codex', 'Finished', 0, 'done')
    const initial = await send(fixture({ codex: [A, B, C] }, [done]))
    assert.equal(initial.id, A.id); assert.equal(initial.cards, 1)
    const seen = [initial.title]
    if (mode === 'reduced') {
      assert.equal(initial.reduced, 'true')
      await delay(3500)
      assert.equal((await read()).id, A.id)
    } else {
      assert.equal(initial.reduced, 'false')
      const beta = await waitForID(B.id); seen.push(beta.title)
      assert.equal(beta.dismissID, B.id)
      const reordered = await send(fixture({ codex: [{ ...C, updatedAt: 9 }, B, A] }, [done]))
      assert.equal(reordered.id, B.id)
      const gamma = await waitForID(C.id); seen.push(gamma.title)
      assert.deepEqual(gamma.completed, [done.id])
      await evaluate(`document.querySelector('.stack-card [data-dismiss]').click()`)
      assert.equal(dismissed, C.id)
      await send(fixture({ codex: [A, B] }, [done, { ...C, phase: 'done' }]))
      assert.equal((await read()).id, A.id)
      const D = task('claude', 'Delta', 4), E = task('claude', 'Epsilon', 3)
      const F = task('dsh', 'Zeta', 1)
      const multi = await send(fixture({ codex: [A, B], claude: [D, E], dsh: [F] }, [done]))
      assert.equal(multi.cards, 3); assert.deepEqual(multi.rearOpacity, [0.7, 0.79])
      await waitForID(D.id); await waitForID(F.id); await waitForID(B.id)
      await evaluate(`document.querySelector('.platform-stack').click()`)
      assert.equal((await read()).stage, 'stage-platforms')
      await delay(3500)
      win.webContents.send('collapse-bubble'); await delay(80)
      assert.equal((await read()).id, B.id)
      snapshot.history.hidden = [B.id]
      await send(snapshot)
      assert.notEqual((await read()).id, B.id)
    }
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(temporary, `${mode}.json`), JSON.stringify({ ok: true, mode, seen,
      verified: mode === 'normal' ? ['single platform timer', 'snapshot reordering', 'front dismiss identity',
        'completion removal', 'three platform rear cards', 'platform/task rotation', 'expanded pause', 'hidden removal'] : ['reduced motion freezes task names'] }) + '\n')
    win.destroy(); app.quit()
  }).catch(error => { console.error(error); app.exit(1) })
}
