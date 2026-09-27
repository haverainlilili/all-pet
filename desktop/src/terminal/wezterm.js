'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
function createWezTermBridge(home, { now = Date.now } = {}) {
  const directory = path.join(home, '.config', 'all-pet', 'terminal-bridge')
  function match(anchor) {
    try {
      const matches = []
      for (const file of fs.readdirSync(directory).filter(file => /^wezterm-\d+\.json$/.test(file)).slice(0, 64)) {
        const full = path.join(directory, file), stat = fs.lstatSync(full)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || now() - stat.mtimeMs > 1200) continue
        const report = JSON.parse(fs.readFileSync(full, 'utf8'))
        for (const pane of report.panes || []) {
          if (pane.local === true && ((anchor.tty && anchor.tty === pane.tty) || (anchor.pids || [anchor.pid]).includes(pane.pid))) matches.push({ report, pane })
        }
      }
      return matches.length === 1 ? matches[0] : null
    } catch { return null }
  }
  return {
    has: anchor => Boolean(match(anchor)),
    viewed: anchor => { const found = match(anchor); return Boolean(found?.report.focused && found.pane.id === found.report.activePane) },
    async focus(anchor) {
      const found = match(anchor)
      if (!found || !Number.isInteger(found.report.window) || !Number.isInteger(found.pane.id)) return false
      const id = crypto.randomUUID(), file = path.join(directory, `wezterm-request-${found.report.window}.json`)
      const token = JSON.parse(fs.readFileSync(path.join(directory, 'connection.json'), 'utf8')).token
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ id, pane: found.pane.id, token, expires: now() + 1800 }), { mode: 0o600 })
      fs.renameSync(`${file}.tmp`, file)
      const deadline = now() + 1600
      while (now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
        const next = match(anchor)
        if (next?.report.reply === id && next.report.focused && next.report.activePane === next.pane.id) return true
      }
      return false
    }
  }
}
module.exports = { createWezTermBridge }
