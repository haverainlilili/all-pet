'use strict'
// Small, opt-in integrations publish only terminal identities and focus state,
// never terminal text. Unix sockets / named pipes are chosen by AllPet, not by
// task data. A per-run capability is required; requests have a fixed allowlist.
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function createDesktopBridges(home, { now = Date.now } = {}) {
  const directory = path.join(home, '.config', 'all-pet', 'terminal-bridge')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const token = crypto.randomBytes(32).toString('hex')
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\allpet-${token.slice(0, 20)}` : path.join(directory, 'bridge.sock')
  const clients = new Set(), pending = new Map()
  let serial = 0
  const server = net.createServer(socket => {
    let buffer = '', client = null
    socket.setEncoding('utf8')
    socket.on('data', data => {
      buffer += data
      if (buffer.length > 256 * 1024) return socket.destroy()
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        try {
          const message = JSON.parse(line)
          if (!client) {
            if (message.token !== token || !['vscode', 'wezterm'].includes(message.adapter)) return socket.destroy()
            client = { adapter: message.adapter, socket, terminals: [], at: 0 }; clients.add(client)
          }
          if (message.type === 'state' && Array.isArray(message.terminals)) {
            client.terminals = message.terminals.slice(0, 256).filter(t => typeof t.id === 'string' && t.id.length < 128 && Number.isInteger(t.pid) && t.pid > 1)
              .map(t => ({ id: t.id, pid: t.pid, tty: typeof t.tty === 'string' ? t.tty : null,
                focused: t.focused === true, local: t.local === true }))
            client.at = now()
          } else if (message.type === 'reply') {
            const entry = pending.get(message.id)
            if (entry?.client === client) { pending.delete(message.id); clearTimeout(entry.timer); entry.resolve(message.succeeded === true) }
          }
        } catch { socket.destroy() }
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => { if (client) clients.delete(client) })
  })
  // Single instance lock is obtained by Electron before constructing this bridge.
  if (process.platform !== 'win32') { try { fs.unlinkSync(endpoint) } catch {} }
  server.listen(endpoint, () => {
    if (process.platform !== 'win32') fs.chmodSync(endpoint, 0o600)
    fs.writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ version: 1, endpoint, token }), { mode: 0o600 })
  })
  server.on('error', () => {})
  function matches(anchor) {
    const found = []
    for (const client of clients) {
      if (now() - client.at > 1200) continue
      for (const terminal of client.terminals) {
        if (terminal.local && (terminal.pid === anchor.pid || (anchor.tty && terminal.tty === anchor.tty))) found.push({ client, terminal })
      }
    }
    return found.length === 1 ? found[0] : null
  }
  return {
    viewed(anchor) { return matches(anchor)?.terminal.focused === true },
    has(anchor) { return Boolean(matches(anchor)) },
    async focus(anchor) {
      const match = matches(anchor)
      if (!match) return false
      return new Promise(resolve => {
        const id = String(++serial)
        const timer = setTimeout(() => { pending.delete(id); resolve(false) }, 1800)
        pending.set(id, { ...match, resolve, timer })
        match.client.socket.write(JSON.stringify({ type: 'focus', id, terminal: match.terminal.id }) + '\n')
      })
    },
    stop() {
      for (const client of clients) client.socket.destroy()
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve(false) }
      pending.clear(); server.close()
      try { fs.unlinkSync(path.join(directory, 'connection.json')) } catch {}
      if (process.platform !== 'win32') { try { fs.unlinkSync(endpoint) } catch {} }
    }
  }
}
module.exports = { createDesktopBridges }
