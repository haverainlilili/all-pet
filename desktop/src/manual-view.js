'use strict'

const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
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
  if (task.turnID && Number.isFinite(task.completedAt)) return JSON.stringify([task.id, task.turnID, task.phase, task.completedAt])
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
    const groups = unreadGroups(JSON.parse(fs.readFileSync(file, 'utf8'))['electron-thread-read-state-v1'])
    if (groups) groups.observedAt = stat.mtimeMs
    return groups
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
      groups.set(digest(JSON.stringify([identity, host])), new Set(ids))
    }
  }
  return groups
}

// Absence at startup is NOT proof of having read a task. Require an observed
// unread -> read transition in the same surviving identity and execution host.
const RECEIPT_TTL = 24 * 60 * 60 * 1000
function digest(value) { return createHash('sha256').update(value).digest('hex') }
function readReceiptCheckpoint(file) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { return null }
}

function createReadTransitionTracker({ checkpoint, now = Date.now, onCheckpoint = () => {} } = {}) {
  let previous = null
  let previousTasks = new Map()
  let receipts = new Map()
  let lastSaved = ''
  if (checkpoint?.version === 1 && Number.isFinite(checkpoint.savedAt) && now() >= checkpoint.savedAt && now() - checkpoint.savedAt < RECEIPT_TTL) {
    try {
      if (!Array.isArray(checkpoint.groups) || !Array.isArray(checkpoint.tasks) || !Array.isArray(checkpoint.receipts)) throw new Error('invalid checkpoint')
      previous = new Map(checkpoint.groups.map(([key, ids]) => {
        if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('invalid group')
        return [key, new Set(ids)]
      }))
      previousTasks = new Map(checkpoint.tasks.filter(([id, rev]) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(rev)))
      receipts = new Map(checkpoint.receipts.filter(([id, value]) => typeof id === 'string' && Number.isFinite(value?.at)
        && previous.has(value.group) && value.at <= now() && now() - value.at < RECEIPT_TTL))
    } catch { previous = null; previousTasks = new Map(); receipts = new Map() }
  }
  return {
    observe(groups, tasks) {
      const at = now()
      const readAt = Number.isFinite(groups?.observedAt) ? Math.min(at, groups.observedAt) : at
      if (groups && previous) {
        for (const [key, ids] of previous) {
          const next = groups.get(key)
          if (!next) continue // Logout / removed account is not a read receipt.
          for (const id of ids) if (!next.has(id)) receipts.set(id, { at: readAt, group: key, legacyRevision: previousTasks.get(id) })
        }
      }
      // A remaining unread copy in another account/host is ambiguous; logout and
      // unavailable state invalidate receipts instead of acknowledging unrelated tasks.
      for (const [id, receipt] of receipts) {
        if (!groups?.has(receipt.group) || at - receipt.at >= RECEIPT_TTL || receipt.at > at
          || [...groups.values()].some(ids => ids.has(id))) receipts.delete(id)
      }
      const eligible = tasks.filter(task => task.platform === 'codex' && task.phase === 'done' && task.launchOrigin !== 'codex-cli'
        && !task.terminalTTY && !task.terminalBinding && !task.terminalLocator)
      const inspected = eligible.filter(task => {
        const receipt = receipts.get(task.sessionID)
        if (!receipt) return false
        // This also covers a read receipt arriving before the slower transcript poll.
        // A completion after the read receipt is a new notification and must survive.
        if (task.turnID && Number.isFinite(task.completedAt)) return task.completedAt > 0 && task.completedAt <= receipt.at
        return receipt.legacyRevision === digest(revision(task))
      })
      previous = groups
      previousTasks = new Map(eligible.map(task => [task.sessionID, digest(revision(task))]))
      receipts = new Map([...receipts].sort((a, b) => b[1].at - a[1].at).slice(0, 200))
      const data = { version: 1, groups: groups ? [...groups].map(([key, ids]) => [key, [...ids]]) : [],
        tasks: [...previousTasks], receipts: [...receipts] }
      const serialized = JSON.stringify(data)
      if (serialized !== lastSaved && onCheckpoint({ ...data, savedAt: at }) !== false) lastSaved = serialized
      return inspected
    }
  }
}

// Own the timer separately from transcript updates. Only one native check can be
// outstanding per platform; a slow browser cannot block another platform.
function createManualViewMonitor({ getState, hiddenPlatforms, readUnread, sendCheck, onDismiss,
  checkpoint, onCheckpoint, now = Date.now, schedule = setInterval, cancel = clearInterval, timeoutMs = 5000 }) {
  const tracker = createReadTransitionTracker({ checkpoint, onCheckpoint, now })
  const pending = new Map()
  let timer = null
  let serial = 0
  let pausedUntil = 0
  function apply(tasks, ids) {
    const state = getState()
    if (dismissViewedTasks(state, tasks, ids, hiddenPlatforms())) onDismiss(state)
  }
  function tick() {
    let tasks = completedViewTasks(getState(), hiddenPlatforms())
    const read = tracker.observe(hiddenPlatforms().includes('codex') ? null : readUnread(), tasks)
    apply(read, read.map(task => task.id))
    tasks = completedViewTasks(getState(), hiddenPlatforms())
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

module.exports = { completedCodexTasks, completedViewTasks, dismissViewedTasks, readCodexUnread, unreadGroups, readReceiptCheckpoint,
  createReadTransitionTracker, createManualViewMonitor }
