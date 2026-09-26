'use strict'

const fs = require('fs')
const path = require('path')
const { dismissTaskHistory } = require('./task-history')

function completedCodexTasks(state, hiddenPlatforms = []) {
  if (hiddenPlatforms.includes('codex')) return []
  return (state.platforms.codex || []).filter(task => task.phase === 'done' && task.sessionID)
    .map(task => ({ ...task, title: task.title || '', action: task.action || '' }))
}

const MANUAL_VIEW_PLATFORMS = ['codex', 'claude', 'dsh', 'grok', 'pi']
function completedViewTasks(state, hiddenPlatforms = []) {
  return MANUAL_VIEW_PLATFORMS.filter(platform => !hiddenPlatforms.includes(platform))
    .flatMap(platform => (state.platforms[platform] || [])
      .filter(task => task.phase === 'done' && task.sessionID)
      .map(task => ({ ...task, title: task.title || '', action: task.action || '' })))
}

function revision(task) {
  return JSON.stringify([task.id, task.sessionID, task.phase, task.updatedAt, task.title, task.sourcePath])
}

// An answer belongs to the completed turn that was inspected, not just to a session ID.
function dismissViewedTasks(state, inspected, viewedIDs, hiddenPlatforms = []) {
  const current = new Map(completedViewTasks(state, hiddenPlatforms).map(task => [task.id, task]))
  const viewed = new Set(viewedIDs)
  let changed = false
  for (const task of inspected) {
    const latest = current.get(task.id)
    if (viewed.has(task.id) && latest && revision(latest) === revision(task)) {
      changed = dismissTaskHistory(state, task.id) || changed
    }
  }
  return changed
}

// Read only the versioned read-state field, never persist/log the surrounding global state.
function readCodexUnread(home) {
  try {
    const file = path.join(home, '.codex', '.codex-global-state.json')
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return null
    return unreadGroups(JSON.parse(fs.readFileSync(file, 'utf8'))['electron-thread-read-state-v1'])
  } catch { return null }
}

function unreadGroups(state) {
  if (!state || state.version !== 1 || !state.unreadByIdentity || typeof state.unreadByIdentity !== 'object') return null
  const groups = new Map()
  for (const [identity, hosts] of Object.entries(state.unreadByIdentity)) {
    if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) return null
    for (const [host, ids] of Object.entries(hosts)) {
      if (!host.startsWith('local:')) continue
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) return null
      groups.set(JSON.stringify([identity, host]), new Set(ids))
    }
  }
  return groups
}

// Absence at startup is NOT proof of having read a task. Require an observed
// unread -> read transition in the same surviving identity and execution host.
function createReadTransitionTracker() {
  let previous = null
  let previousTasks = []
  return {
    observe(groups, tasks) {
      const read = new Set()
      if (groups && previous) {
        for (const [key, ids] of previous) {
          const next = groups.get(key)
          if (!next) continue // Logout / removed account is not a read receipt.
          for (const id of ids) if (!next.has(id)) read.add(id)
        }
        // A remaining unread copy in another account/host is ambiguous.
        for (const ids of groups.values()) for (const id of ids) read.delete(id)
      }
      const inspected = previousTasks.filter(task => task.platform === 'codex' && task.launchOrigin !== 'codex-cli' &&
        !task.terminalTTY && !task.terminalBinding && read.has(task.sessionID))
      previous = groups
      previousTasks = tasks.map(task => ({ ...task }))
      return inspected
    }
  }
}

// Own the timer separately from transcript updates. Only one native check can be
// outstanding per platform; a slow browser cannot block another platform.
function createManualViewMonitor({ getState, hiddenPlatforms, readUnread, sendCheck, onDismiss,
  now = Date.now, schedule = setInterval, cancel = clearInterval, timeoutMs = 5000 }) {
  const tracker = createReadTransitionTracker()
  const pending = new Map()
  let timer = null
  let serial = 0
  let pausedUntil = 0
  function apply(tasks, ids) {
    const state = getState()
    if (dismissViewedTasks(state, tasks, ids, hiddenPlatforms())) onDismiss(state)
  }
  function tick() {
    const tasks = completedViewTasks(getState(), hiddenPlatforms())
    const read = tracker.observe(readUnread(), tasks)
    apply(read, read.map(task => task.id))
    for (const [platform, request] of pending) {
      if (now() - request.at >= timeoutMs) pending.delete(platform)
    }
    if (now() < pausedUntil) return
    for (const platform of MANUAL_VIEW_PLATFORMS) {
      const candidates = tasks.filter(task => task.platform === platform)
      if (pending.has(platform) || !candidates.length) continue
      const request = { type: 'view-check', requestID: String(++serial), platform, tasks: candidates }
      pending.set(platform, { request, at: now() })
      if (!sendCheck(request)) pending.delete(platform)
    }
  }
  return {
    start() { if (timer !== null) return; tick(); timer = schedule(tick, 500) },
    stop() { if (timer !== null) cancel(timer); timer = null; pending.clear() },
    pause(milliseconds = 500) { pausedUntil = now() + milliseconds; pending.clear() },
    receive(message) {
      if (message.type !== 'view-result') return
      const entry = [...pending.entries()].find(([, value]) => value.request.requestID === message.requestID)
      if (!entry) return
      const [platform, request] = entry
      pending.delete(platform)
      if (now() - request.at >= timeoutMs || !Array.isArray(message.viewedIDs)) return
      apply(request.request.tasks, message.viewedIDs)
    }
  }
}

module.exports = { completedCodexTasks, completedViewTasks, dismissViewedTasks, readCodexUnread, unreadGroups,
  createReadTransitionTracker, createManualViewMonitor }
