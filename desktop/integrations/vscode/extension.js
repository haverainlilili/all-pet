'use strict'
const vscode = require('vscode')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
function activate(context) {
  const identities = new WeakMap(), selectedAt = new WeakMap()
  let socket, buffer = '', busy = false, disposed = false
  const identity = terminal => { if (!identities.has(terminal)) identities.set(terminal, crypto.randomUUID()); return identities.get(terminal) }
  async function publish() {
    if (busy || disposed) return
    busy = true
    try {
      if (!socket || socket.destroyed) {
        const file = path.join(os.homedir(), '.config', 'all-pet', 'terminal-bridge', 'connection.json')
        const st = fs.lstatSync(file)
        if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) return
        const connection = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (connection.version !== 1 || typeof connection.endpoint !== 'string' || !/^[a-f0-9]{64}$/.test(connection.token)) return
        socket = net.createConnection(connection.endpoint)
        buffer = ''
        socket.on('error', () => {})
        socket.on('connect', () => socket.write(JSON.stringify({ token: connection.token, adapter: 'vscode' }) + '\n'))
        socket.on('data', async data => {
          buffer += data.toString()
          if (buffer.length > 16384) return socket.destroy()
          let index
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
            try {
              const request = JSON.parse(line)
              if (request.type !== 'focus') continue
              const terminal = vscode.window.terminals.find(value => identity(value) === request.terminal)
              if (terminal) { terminal.show(false); await vscode.commands.executeCommand('workbench.action.focusWindow') }
              setTimeout(() => {
                if (!socket?.destroyed) socket.write(JSON.stringify({ type: 'reply', id: request.id,
                  succeeded: Boolean(terminal && vscode.window.state.focused && vscode.window.activeTerminal === terminal) }) + '\n')
              }, 150)
            } catch {}
          }
        })
      }
      if (socket.connecting) return
      const terminals = await Promise.all(vscode.window.terminals.map(async terminal => ({
        id: identity(terminal), pid: await terminal.processId,
        // Remote PID namespaces cannot be compared to local task processes.
        local: !vscode.env.remoteName,
        focused: vscode.window.state.focused && vscode.window.activeTerminal === terminal && Date.now() - (selectedAt.get(terminal) || 0) < 1000
      })))
      if (!socket.destroyed) socket.write(JSON.stringify({ type: 'state', terminals }) + '\n')
    } catch {} finally { busy = false }
  }
  const timer = setInterval(publish, 400)
  context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(terminal => { if (terminal && vscode.window.state.focused) selectedAt.set(terminal, Date.now()); publish() }),
    vscode.commands.registerCommand('allpet.confirmTerminalView', () => { const terminal = vscode.window.activeTerminal; if (terminal) { terminal.show(false); selectedAt.set(terminal, Date.now()); publish() } }), vscode.window.onDidChangeWindowState(publish),
    vscode.window.onDidCloseTerminal(publish), { dispose() { disposed = true; clearInterval(timer); socket?.destroy() } })
  publish()
}
module.exports = { activate }
