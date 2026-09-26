'use strict'
// Executed by VS Code's extension test host in an isolated profile. This file
// is copied into a temporary extension directory, never packaged into the VSIX.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vscode = require('vscode')
const { createDesktopBridges } = require(process.env.ALLPET_EDITOR_BRIDGE_MODULE)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(100) }
  throw Error(label)
}
async function bounded(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 10000) })]) }
  finally { clearTimeout(timer) }
}
exports.run = async () => {
  assert.ok(process.env.ALLPET_HOME, 'isolated AllPet home required')
  const bridge = createDesktopBridges(process.env.ALLPET_HOME), terminals = []
  const report = value => fs.writeFileSync(process.env.ALLPET_EDITOR_TEST_RESULT, JSON.stringify(value))
  try {
    report({ stage: 'activation' })
    await bounded(vscode.extensions.getExtension('allpet.allpet-terminal-bridge').activate(), 'activation timeout')
    await until(() => vscode.window.state.focused, 'test window focus')
    const create = async name => {
      report({ stage: name })
      const terminal = vscode.window.createTerminal({ name, shellPath: '/bin/bash', shellArgs: ['--noprofile', '--norc'] })
      terminals.push(terminal); terminal.show(false)
      const pid = await bounded(terminal.processId, `${name} PID timeout`)
      await until(() => bridge.has({ pid }), `${name} registration`)
      return { terminal, pid }
    }
    const first = await create('AllPet fixture A'), second = await create('AllPet fixture B')
    await until(() => vscode.window.activeTerminal === second.terminal, 'second active')
    await sleep(500)
    assert.equal(bridge.viewed(first), false, 'wrong editor terminal rejected')
    assert.equal(await bridge.focus(first), true, 'existing terminal focused')
    assert.equal(vscode.window.activeTerminal, first.terminal)
    const completedAt = Date.now() + 1
    assert.equal(bridge.viewed({ ...first, completedAt }), false, 'old selection cannot acknowledge new completion')
    await sleep(10)
    await vscode.commands.executeCommand('allpet.confirmTerminalView')
    await until(() => bridge.viewed({ ...first, completedAt }), 'explicit current-terminal confirmation')
    report({ ok: true, vscode: vscode.version, wrongTerminalRejected: true, exactFocus: true, oldSelectionRejected: true, confirmation: true })
  } catch (error) { report({ ok: false, error: error.stack }); throw error }
  finally { for (const terminal of terminals) terminal.dispose(); bridge.stop() }
}
