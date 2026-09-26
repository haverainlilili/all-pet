'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createGhostty } = require('./ghostty')
const { createATSPI } = require('./atspi')
const { run, normalizeTTY, linuxProcess, selectedEnvironment } = require('./process')
function executable(name, extras = []) {
  for (const file of [...extras, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`, ...String(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, name))]) {
    try { fs.accessSync(file, fs.constants.X_OK); return file } catch {}
  }
  return null
}
function tmuxPanes(text) {
  return text.split('\n').map(line => { const [id, tty, active, window, session, selected] = line.split('\t'); return { id, tty, active: active === '1', window, session, selected: selected === '1' } })
    .filter(p => /^%\d+$/.test(p.id) && /^@\d+$/.test(p.window) && /^\$\d+$/.test(p.session) && p.tty?.startsWith('/dev/'))
}
function kittyPanes(windows) {
  return windows.flatMap(osWindow => (osWindow.tabs || []).flatMap(tab => (tab.windows || []).map(pane => ({
    id: pane.id, pid: pane.pid, focused: osWindow.is_focused === true && tab.is_focused === true && pane.is_focused === true
  }))))
}
function createUnixTerminal({ platform, native, bridges, config = () => ({}), command = run, terminalForTTY }) {
  const atspi = platform === 'linux' ? createATSPI() : null
  const ghostty = platform === 'darwin' ? createGhostty(native, command) : null
  const tmux = executable('tmux'), kitty = executable('kitty', ['/Applications/kitty.app/Contents/MacOS/kitty'])
  const xdotool = executable('xdotool'), qdbus = executable('qdbus6') || executable('qdbus')
  async function kittyTarget(anchor, focus) {
    const socket = config().kittySocket || process.env.KITTY_LISTEN_ON
    // Only a local Unix socket; no TCP remote-control or arbitrary command path from task data.
    if (!kitty || typeof socket !== 'string' || !socket.startsWith('unix:/')) return false
    const list = async () => kittyPanes(JSON.parse(await command(kitty, ['@', '--to', socket, 'ls'])))
    const panes = await list(), matches = []
    for (const pane of panes) {
      if (!Number.isInteger(pane.pid) || pane.pid <= 1) continue
      const tty = platform === 'linux' ? linuxProcess(pane.pid)?.tty : normalizeTTY(await command('/bin/ps', ['-p', String(pane.pid), '-o', 'tty=']))
      if (tty === anchor.tty) matches.push(pane)
    }
    if (matches.length !== 1 || !Number.isInteger(matches[0].id)) return false
    const id = matches[0].id
    if (focus) await command(kitty, ['@', '--to', socket, 'focus-window', '--match', `id:${id}`])
    return (focus ? await list() : panes).some(pane => pane.id === id && pane.focused)
  }
  async function x11(anchor, focus) {
    if (platform !== 'linux' || !xdotool || process.env.XDG_SESSION_TYPE === 'wayland') return false
    const env = selectedEnvironment(anchor.pid, ['WINDOWID'])
    if (!/^\d+$/.test(env.WINDOWID || '')) return false
    const id = env.WINDOWID
    const klass = await command('xprop', ['-id', id, 'WM_CLASS'])
    // One terminal per X window; tabbed emulators require their own adapter.
    if (!/"(?:XTerm|UXTerm|Alacritty|st|rxvt|URxvt)"/i.test(klass)) return false
    const windowPID = Number(await command(xdotool, ['getwindowpid', id]))
    let row = linuxProcess(anchor.pid), related = false
    for (let i = 0; i < 32 && row; i++) { if (row.pid === windowPID) { related = true; break }; row = linuxProcess(row.ppid) }
    if (!related) return false
    if (focus) await command(xdotool, ['windowactivate', '--sync', id])
    return await command(xdotool, ['getactivewindow']) === id
  }
  async function konsole(anchor, focus) {
    if (platform !== 'linux' || !qdbus) return false
    const env = selectedEnvironment(anchor.pid, ['KONSOLE_DBUS_SERVICE', 'KONSOLE_DBUS_SESSION', 'WINDOWID'])
    if (!/^org\.kde\.konsole-[\w-]+$/.test(env.KONSOLE_DBUS_SERVICE || '') || !/^\/Sessions\/\d+$/.test(env.KONSOLE_DBUS_SESSION || '')) return false
    const service = env.KONSOLE_DBUS_SERVICE, session = env.KONSOLE_DBUS_SESSION
    const pid = Number(await command(qdbus, [service, session, 'org.kde.konsole.Session.processId']))
    if (pid !== anchor.pid) return false
    // Konsole identifies sessions by shell PID; activeSession alone is not OS focus proof.
    const windows = (await command(qdbus, [service])).split('\n').filter(value => /^\/Windows\/\d+$/.test(value))
    for (const win of windows) {
      const sessions = (await command(qdbus, [service, win, 'org.kde.konsole.Window.sessionList'])).split(/\s+/)
      const id = session.split('/').pop()
      if (!sessions.includes(id)) continue
      if (focus) await command(qdbus, [service, win, 'org.kde.konsole.Window.setCurrentSession', id])
      if (!xdotool || process.env.XDG_SESSION_TYPE === 'wayland') return false
      const windowID = env.WINDOWID || ''
      if (!/^\d+$/.test(windowID)) return false
      if (focus) await command(xdotool, ['windowactivate', '--sync', windowID])
      return await command(qdbus, [service, win, 'org.kde.konsole.Window.currentSession']) === id && await command(xdotool, ['getactivewindow']) === windowID
    }
    return false
  }
  async function direct(anchor, focus) {
    if (bridges?.has(anchor)) return focus ? bridges.focus(anchor) : bridges.viewed(anchor)
    if (platform === 'darwin' && anchor.binding) {
      const result = await native.request(focus ? 'focus' : 'view', { binding: anchor.binding })
      if (focus ? result.succeeded : result.viewed) return true
    }
    if (ghostty) { try { if (await ghostty.operate(anchor, focus)) return true } catch {} }
    for (const adapter of [kittyTarget, konsole, x11]) {
      try { if (await adapter(anchor, focus)) return true } catch {}
    }
    if (atspi && anchor.start) return atspi.operate(anchor, focus)
    return false
  }
  async function operate(anchor, focus, depth = 0) {
    if (depth > 4) return false
    if (await direct(anchor, focus)) return true
    if (!tmux) return false
    try {
      const rows = tmuxPanes(await command(tmux, ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_tty}\t#{pane_active}\t#{window_id}\t#{session_id}\t#{window_active}']))
      const matches = rows.filter(pane => pane.tty === anchor.tty)
      if (matches.length !== 1) return false
      const pane = matches[0]
      const clients = (await command(tmux, ['list-clients', '-F', '#{client_tty}\t#{session_id}'])).split('\n')
        .map(line => line.split('\t')).filter(([tty, session]) => tty?.startsWith('/dev/') && session === pane.session)
      // An unattached session is not viewed, and no new client/window is created.
      if (!clients.length) return false
      if (focus) {
        // Choose only one attached local client, never arbitrarily switch an SSH client.
        const outer = []
        for (const [tty] of clients) { const target = await terminalForTTY(tty); if (target) outer.push(target) }
        if (outer.length !== 1) return false
        await command(tmux, ['select-window', '-t', `${pane.session}:${pane.window}`])
        await command(tmux, ['select-pane', '-t', pane.id])
        return operate(outer[0], true, depth + 1)
      }
      if (!pane.active || !pane.selected) return false
      for (const [tty] of clients) { const outer = await terminalForTTY(tty); if (outer && await operate(outer, false, depth + 1)) return true }
    } catch {}
    return false
  }
  return { viewed: anchor => operate(anchor, false), focus: anchor => operate(anchor, true), stop: () => atspi?.stop() }
}
module.exports = { createUnixTerminal, tmuxPanes, kittyPanes, executable }
