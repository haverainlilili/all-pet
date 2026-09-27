'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const APPLE_EPOCH = 978307200000

function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => execFile(command, args, {
    encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, windowsHide: true, ...options
  }, (error, stdout) => error ? reject(new Error(`终端接口不可用：${path.basename(command)}`)) : resolve(stdout.trim())))
}
function cliTask(task) {
  if (!task || !['codex', 'claude', 'grok', 'pi'].includes(task.platform)) return false
  if (['codex-desktop', 'claude-desktop-3p'].includes(task.launchOrigin) || task.sessionID?.startsWith('local_')) return false
  return task.platform !== 'codex' || task.launchOrigin === 'codex-cli' || Boolean(task.terminalBinding || task.terminalLocator || task.terminalTTY)
}
function normalizeTTY(tty) { return tty && (tty.startsWith('/dev/') ? tty : `/dev/${tty}`) }
function parseStat(text, boot) {
  const end = text.lastIndexOf(') ')
  if (end < 0) return null
  const rest = text.slice(end + 2).trim().split(/\s+/)
  const pid = Number(text.slice(0, text.indexOf(' ')))
  return { pid, ppid: Number(rest[1]), ttyNumber: rest[4], start: `${boot}:${rest[19]}` }
}
function linuxProcess(pid) {
  try {
    if (!Number.isInteger(Number(pid)) || Number(pid) <= 1) return null
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const row = parseStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), boot)
    if (!row) return null
    row.exe = fs.readlinkSync(`/proc/${pid}/exe`)
    row.argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    try { row.tty = fs.readlinkSync(`/proc/${pid}/fd/0`); if (!/^\/dev\/(pts\/\d+|tty\d+)$/.test(row.tty)) delete row.tty } catch {}
    return row
  } catch { return null }
}
function selectedEnvironment(pid, keys) {
  const values = {}
  try {
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const index = entry.indexOf('='); const key = entry.slice(0, index)
      if (keys.includes(key)) values[key] = entry.slice(index + 1)
    }
  } catch {}
  return values
}
function agentMatches(row, platform) {
  const base = value => path.basename(value || '').replace(/\.(exe|cmd|js|mjs|cjs)$/, '')
  if (base(row.exe) === platform) return true
  if (platform === 'claude' && row.exe?.includes('/claude/versions/')) return true
  if (!['node', 'bun', 'deno', 'python', 'python3'].includes(base(row.exe))) return false
  const script = (row.argv || []).slice(1).find(value => !value.startsWith('-')) || ''
  return base(script) === platform || (platform === 'claude' && script.includes('/claude-code/')) ||
    (platform === 'pi' && script.includes('/pi-coding-agent/'))
}
function linuxDiscover(task) {
  const candidates = []
  let sourceStat
  try { if (task.sourcePath) sourceStat = fs.statSync(task.sourcePath) } catch {}
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const row = linuxProcess(Number(name))
    if (!row?.tty || !agentMatches(row, task.platform)) continue
    let owns = Boolean(task.sessionID && row.argv.includes(task.sessionID))
    if (!owns && sourceStat) {
      try {
        owns = fs.readdirSync(`/proc/${row.pid}/fd`).some(fd => {
          try { const st = fs.statSync(`/proc/${row.pid}/fd/${fd}`); return st.dev === sourceStat.dev && st.ino === sourceStat.ino } catch { return false }
        })
      } catch {}
    }
    if (!owns && task.processID === row.pid && Number.isFinite(task.updatedAt)) {
      // Linux x64 USER_HZ is 100; boot/start bounds reject a recycled PID born after this task.
      const bootSeconds = Number(fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1])
      const started = bootSeconds * 1000 + Number(row.start.split(':').pop()) * 10
      owns = Number.isFinite(started) && started <= APPLE_EPOCH + task.updatedAt * 1000
    }
    if (!owns) continue
    let anchor = row
    const seen = new Set()
    while (anchor.ppid > 1 && !seen.has(anchor.ppid)) {
      seen.add(anchor.ppid); const parent = linuxProcess(anchor.ppid)
      if (!parent || parent.ttyNumber !== row.ttyNumber) break
      anchor = parent
    }
    candidates.push({ version: 1, os: 'linux', pid: anchor.pid, start: anchor.start, tty: row.tty })
  }
  return new Set(candidates.map(value => value.tty)).size === 1 ? candidates[0] : null
}
function sanitizeLocator(value) {
  if (!value || value.version !== 1 || !['linux', 'win32'].includes(value.os) || !Number.isInteger(value.pid) || value.pid <= 1 || typeof value.start !== 'string' || value.start.length > 128) return undefined
  const result = { version: 1, os: value.os, pid: value.pid, start: value.start }
  if (value.os === 'linux') {
    if (!/^\/dev\/(pts\/\d+|tty\d+)$/.test(value.tty || '')) return undefined
    result.tty = value.tty
  } else if (value.window && /^\d+$/.test(String(value.window))) {
    result.window = String(value.window)
    if (Array.isArray(value.control) && value.control.length <= 32 && value.control.every(Number.isInteger)) result.control = value.control
    if (Array.isArray(value.tab) && value.tab.length <= 32 && value.tab.every(Number.isInteger)) result.tab = value.tab
  }
  return result
}
module.exports = { run, cliTask, normalizeTTY, parseStat, linuxProcess, selectedEnvironment, agentMatches, linuxDiscover, sanitizeLocator, APPLE_EPOCH }
