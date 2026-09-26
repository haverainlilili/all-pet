'use strict'
const { cliTask, linuxProcess, linuxDiscover, sanitizeLocator } = require('./process')
const { createUnixTerminal } = require('./unix')
const { createWindowsTerminal } = require('./windows')
const { createDesktopBridges } = require('./desktop-bridges')
const { createWezTermBridge } = require('./wezterm')

const identity = task => JSON.stringify([task.id, task.sessionID, task.sourcePath, task.processID, task.launchOrigin])
const anchorKey = task => task.terminalBinding
  ? `mac:${task.terminalBinding.anchorProcessID}:${task.terminalBinding.anchorStartedAtMicroseconds}`
  : task.terminalLocator ? `${task.terminalLocator.os}:${task.terminalLocator.pid}:${task.terminalLocator.start}` : null
function applyBindings(tasks, inspected, bindings) {
  const originals = new Map(inspected.map(task => [task.id, identity(task)]))
  let changed = false
  for (const update of bindings || []) {
    const task = tasks.find(task => task.id === update.id)
    if (!task || originals.get(task.id) !== identity(task)) continue
    if (update.terminalBinding && JSON.stringify(task.terminalBinding) !== JSON.stringify(update.terminalBinding)) {
      task.terminalBinding = update.terminalBinding; task.terminalTTY = update.terminalBinding.tty; changed = true
    }
    const locator = sanitizeLocator(update.terminalLocator)
    if (locator && JSON.stringify(task.terminalLocator) !== JSON.stringify(locator)) { task.terminalLocator = locator; changed = true }
  }
  return changed
}
function ownsAnchor(task, tasks) {
  const key = anchorKey(task)
  if (!key) return false
  return !tasks.some(other => other.id !== task.id && anchorKey(other) === key && Number(other.updatedAt || 0) >= Number(task.updatedAt || 0))
}
function createTerminalService({ platform = process.platform, home, native, getTasks, onBindings, config }) {
  const windows = platform === 'win32' ? createWindowsTerminal() : null
  const editors = createDesktopBridges(home), wezterm = createWezTermBridge(home)
  const bridges = {
    has: anchor => editors.has(anchor) || wezterm.has(anchor),
    viewed: anchor => editors.has(anchor) ? editors.viewed(anchor) : wezterm.viewed(anchor),
    focus: anchor => editors.has(anchor) ? editors.focus(anchor) : wezterm.focus(anchor)
  }
  let inFlight = false, timer = null, stopped = false
  const misses = new Map(), captured = new Map()
  async function anchor(task) {
    if (platform === 'darwin' && task.terminalBinding) {
      if (!(await native.request('valid', { binding: task.terminalBinding })).valid) return null
      return { pid: task.terminalBinding.anchorProcessID, tty: task.terminalBinding.tty, binding: task.terminalBinding }
    }
    const loc = sanitizeLocator(task.terminalLocator)
    if (!loc || loc.os !== platform) return null
    if (platform === 'linux') {
      const process = linuxProcess(loc.pid)
      return process?.start === loc.start && process.tty === loc.tty ? loc : null
    }
    const result = await windows.request('valid', { locator: loc })
    return result.valid ? { ...loc, pids: result.pids || [loc.pid] } : null
  }
  async function terminalForTTY(tty) {
    if (platform === 'darwin') {
      const result = await native.request('binding-for-tty', { tty })
      return result.binding ? { pid: result.binding.anchorProcessID, tty, binding: result.binding } : null
    }
    const fs = require('node:fs')
    const rows = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => linuxProcess(Number(name))).filter(row => row?.tty === tty)
    const roots = rows.filter(row => !rows.some(parent => parent.pid === row.ppid))
    return roots.length === 1 ? { pid: roots[0].pid, start: roots[0].start, tty } : null
  }
  const unix = platform !== 'win32' ? createUnixTerminal({ platform, native, bridges, config, terminalForTTY }) : null
  async function capture(taskList = getTasks()) {
    if (inFlight || stopped) return
    inFlight = true
    try {
      const candidates = []
      for (const task of taskList.filter(cliTask).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))) {
        if ((misses.get(identity(task)) || 0) > Date.now()) continue
        if (anchorKey(task)) continue // validated at every focus/read, never rebound from a recycled PID
        candidates.push({ ...task, title: task.title || '', action: task.action || '' })
        if (candidates.length >= 24) break
      }
      if (!candidates.length) return
      let bindings
      if (platform === 'darwin') bindings = (await native.request('bind', { tasks: candidates }, 10000)).bindings
      else if (platform === 'win32') bindings = (await windows.request('bind', { tasks: candidates })).bindings
      else bindings = candidates.map(task => ({ id: task.id, terminalLocator: linuxDiscover(task) })).filter(value => value.terminalLocator)
      if (stopped) return
      for (const task of candidates) misses.set(identity(task), Date.now() + 3000)
      if (misses.size > 512) misses.clear()
      for (const update of bindings || []) {
        const original = candidates.find(task => task.id === update.id)
        if (original) captured.set(identity(original), update)
      }
      if (captured.size > 512) captured.clear()
      onBindings(candidates, bindings || [])
    } catch {} finally { inFlight = false }
  }
  return {
    start() { if (timer) return; capture(); timer = setInterval(() => capture(), 1000) },
    capture,
    async viewed(task) {
      if (!cliTask(task) || !ownsAnchor(task, getTasks())) return false
      try {
        const target = await anchor(task)
        if (!target) return false
        if (bridges.has(target)) return bridges.viewed(target)
        return platform === 'win32' ? Boolean((await windows.request('view', { locator: target })).viewed) : unix.viewed(target)
      } catch { return false }
    },
    async focus(task) {
      try {
        if (!anchorKey(task)) await capture([task])
        const current = getTasks().find(value => value.id === task.id) || { ...task, ...captured.get(identity(task)) }
        // A clicked done task may already be removed from history; capture can still update it via onBindings.
        if (anchorKey(current) && getTasks().some(other => other.id !== current.id && anchorKey(other) === anchorKey(current) && Number(other.updatedAt) >= Number(current.updatedAt))) throw new Error('原终端已被另一项任务使用')
        const target = await anchor(current)
        const exact = target && (bridges.has(target) ? await bridges.focus(target) : platform === 'win32'
          ? (await windows.request('focus', { locator: target })).succeeded : await unix.focus(target))
        return { succeeded: Boolean(exact), exact: Boolean(exact), message: exact ? '已定位原终端标签页或分屏。' : '未能验证原终端位置。请检查终端接入设置或手动打开原任务；不会新建终端或重新运行任务。' }
      } catch (error) { return { succeeded: false, exact: false, message: error.message || '原终端不可用' } }
    },
    stop() { stopped = true; clearInterval(timer); timer = null; editors.stop(); windows?.stop(); unix?.stop() }
  }
}
module.exports = { createTerminalService, applyBindings, ownsAnchor, identity, anchorKey }
