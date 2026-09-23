'use strict'

const APPLE_REF_MS = Date.UTC(2001, 0, 1)
const DONE_TTL_SECONDS = 86400

function isUUID(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '')
}

function canonicalID(platform, task) {
  if (task && task.scheduledTaskName) return `${platform}|scheduled:${task.scheduledTaskName}`
  let identity = task && task.sessionID ? task.sessionID : String(task && task.title || '').trim()
  if (platform === 'dsh' && isUUID(identity)) identity = `session-${identity}`
  return `${platform}|${identity || 'current'}`
}

function sessionDisplayName(item) {
  if (item && item.scheduledTaskName) return `定时任务 · ${item.scheduledTaskName}`
  if (item && item.sessionName && item.sessionName.trim()) return item.sessionName.trim()
  if (item && item.sessionID) {
    const value = item.sessionID.indexOf('session-') === 0 ? item.sessionID.slice(8) : item.sessionID
    return `会话 ${String(value).slice(0, 8)}`
  }
  return '未命名会话'
}

const PLATFORM_KEYS = new Set(['codex', 'claude', 'dsh', 'grok'])
const PHASE_KEYS = new Set(['idle', 'waiting', 'thinking', 'running', 'done', 'failed'])
const STRING_FIELDS = [
  'title', 'sessionName', 'action', 'progress', 'sessionID', 'sourcePath',
  'workingDirectory', 'terminalTTY', 'launchOrigin', 'scheduledTaskName'
]

function optionalString(value) {
  return typeof value === 'string' ? value : undefined
}

function sanitizedTerminalBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const tty = optionalString(value.tty)
  const anchorProcessID = Number(value.anchorProcessID)
  const anchorStartedAtMicroseconds = Number(value.anchorStartedAtMicroseconds)
  if (!tty || !Number.isInteger(anchorProcessID) || !Number.isFinite(anchorStartedAtMicroseconds) || anchorStartedAtMicroseconds < 0) return undefined
  return { tty, anchorProcessID, anchorStartedAtMicroseconds }
}

function isSyntheticHistoryTask(task) {
  const title = String(task && task.title || '').trim()
  const lower = title.toLowerCase()
  if (lower.startsWith('[your previous response had no visible output')) return true
  return !task.sessionID && ['任务已完成', '等待后续活动', '正在处理命令结果', '正在生成回复'].includes(title)
}

function isDSHSubagentHistoryTask(task) {
  if (task.platform !== 'dsh' || !task.sourcePath) return false
  const pieces = String(task.sourcePath).replace(/\\/g, '/').split('/').filter(Boolean)
  const parent = pieces.length > 1 ? pieces[pieces.length - 2] : ''
  return !parent.startsWith('session-')
}

function sanitizedHistoryTask(platform, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const phase = optionalString(input.phase)
  if (!phase || !PHASE_KEYS.has(phase)) return null
  const task = { platform, phase }
  for (const field of STRING_FIELDS) {
    const value = optionalString(input[field])
    if (value !== undefined) task[field] = value
  }
  if (!task.sessionID || !task.sessionID.trim()) return null
  task.sessionID = task.sessionID.trim()
  if (platform === 'dsh' && isUUID(task.sessionID)) task.sessionID = `session-${task.sessionID}`
  const updatedAt = Number(input.updatedAt)
  if (Number.isFinite(updatedAt)) task.updatedAt = updatedAt
  const processID = Number(input.processID)
  if (Number.isInteger(processID)) task.processID = processID
  const terminalBinding = sanitizedTerminalBinding(input.terminalBinding)
  if (terminalBinding) task.terminalBinding = terminalBinding
  task.id = canonicalID(platform, task)
  return task
}

function normalizeTaskHistory(raw, nowMilliseconds = Date.now(), options = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const sourcePlatforms = source.platforms && typeof source.platforms === 'object' && !Array.isArray(source.platforms)
    ? source.platforms : {}
  const platforms = {}
  for (const platform of PLATFORM_KEYS) {
    const byID = new Map()
    const inputs = Array.isArray(sourcePlatforms[platform]) ? sourcePlatforms[platform] : []
    for (const input of inputs) {
      let task = sanitizedHistoryTask(platform, input)
      if (!task || isSyntheticHistoryTask(task) || isDSHSubagentHistoryTask(task)) continue
      if (platform === 'codex' && typeof options.isDSHBackedCodex === 'function' && options.isDSHBackedCodex(task)) continue
      const previous = byID.get(task.id)
      if (previous) {
        const previousDate = Number.isFinite(previous.updatedAt) ? previous.updatedAt : -Infinity
        const taskDate = Number.isFinite(task.updatedAt) ? task.updatedAt : -Infinity
        if (taskDate < previousDate) continue
        for (const field of ['terminalTTY', 'terminalBinding', 'processID', 'launchOrigin', 'sessionName']) {
          if (task[field] === undefined && previous[field] !== undefined) task[field] = previous[field]
        }
      }
      byID.set(task.id, task)
    }
    const tasks = [...byID.values()]
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
      .slice(0, 12)
    if (tasks.length) platforms[platform] = tasks
  }

  const dismissed = []
  const sourceDismissed = Array.isArray(source.dismissedTaskIDs) ? source.dismissedTaskIDs : []
  for (const rawID of sourceDismissed) {
    if (typeof rawID !== 'string') continue
    let id = rawID
    const separator = id.indexOf('|')
    if (separator <= 0 || !PLATFORM_KEYS.has(id.slice(0, separator)) || !id.slice(separator + 1)) continue
    if (id.startsWith('dsh|')) {
      const identity = id.slice('dsh|'.length)
      if (isUUID(identity)) id = `dsh|session-${identity}`
    }
    const previousIndex = dismissed.indexOf(id)
    if (previousIndex >= 0) dismissed.splice(previousIndex, 1)
    dismissed.push(id)
  }
  if (dismissed.length > 100) dismissed.splice(0, dismissed.length - 100)
  const dismissedSet = new Set(dismissed)
  for (const [platform, tasks] of Object.entries(platforms)) {
    platforms[platform] = tasks.filter(task =>
      !((task.phase === 'done' || task.phase === 'failed') && dismissedSet.has(task.id))
    )
    if (!platforms[platform].length) delete platforms[platform]
  }
  const state = { platforms, dismissed, hidden: {} }
  expireTaskHistory(state, nowMilliseconds)
  return state
}

function mergeDefined(previous, next) {
  const merged = { ...previous }
  for (const [key, value] of Object.entries(next || {})) {
    if (value !== undefined) merged[key] = value
  }
  return merged
}

function trimDismissed(state) {
  if (state.dismissed.length > 100) state.dismissed = state.dismissed.slice(-100)
}

function expireTaskHistory(state, nowMilliseconds = Date.now()) {
  const nowAppleSeconds = (nowMilliseconds - APPLE_REF_MS) / 1000
  const expired = new Set()
  for (const list of Object.values(state.platforms)) {
    for (const item of list || []) {
      if ((item.phase === 'done' || item.phase === 'failed')
          && (nowAppleSeconds - (item.updatedAt || 0)) > DONE_TTL_SECONDS) {
        expired.add(item.id)
        if (!state.dismissed.includes(item.id)) state.dismissed.push(item.id)
      }
    }
  }
  if (!expired.size) return false
  for (const [platform, list] of Object.entries(state.platforms)) {
    state.platforms[platform] = (list || []).filter(item => !expired.has(item.id))
  }
  trimDismissed(state)
  return true
}

function accumulateTaskHistory(state, snap, nowMilliseconds = Date.now()) {
  let changed = expireTaskHistory(state, nowMilliseconds)
  const nowAppleSeconds = (nowMilliseconds - APPLE_REF_MS) / 1000

  for (const platformStatus of snap && snap.platforms || []) {
    const platform = platformStatus.platform
    if (platformStatus.phase === 'idle') {
      const before = state.platforms[platform] || []
      const kept = before.filter(item => item.phase === 'done' || item.phase === 'failed')
      if (kept.length !== before.length) { state.platforms[platform] = kept; changed = true }
      continue
    }

    const tasks = platformStatus.tasks && platformStatus.tasks.length
      ? platformStatus.tasks
      : (platformStatus.task ? [platformStatus.task] : [])
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index]
      if (!task || !(task.sessionID || task.scheduledTaskName)) continue
      const item = {
        id: canonicalID(platform, task),
        platform,
        title: String(task.title || '').trim() || task.action || platformStatus.detail || '',
        sessionName: task.sessionName,
        action: task.action || platformStatus.detail || '',
        phase: task.phase || platformStatus.phase,
        progress: task.progressLabel,
        updatedAt: nowAppleSeconds,
        sessionID: task.sessionID,
        sourcePath: task.sourcePath,
        workingDirectory: task.workingDirectory,
        processID: task.processID,
        terminalTTY: task.terminalTTY,
        terminalBinding: task.terminalBinding,
        launchOrigin: task.launchOrigin,
        scheduledTaskName: task.scheduledTaskName
      }
      const hiddenTitle = state.hidden[item.id]
      if (hiddenTitle !== undefined) {
        if (hiddenTitle === item.title) {
          const before = state.platforms[platform] || []
          const kept = before.filter(existing => existing.id !== item.id)
          if (kept.length !== before.length) { state.platforms[platform] = kept; changed = true }
          continue
        }
        delete state.hidden[item.id]
      }
      if (item.phase !== 'done' && item.phase !== 'failed') {
        const dismissedIndex = state.dismissed.indexOf(item.id)
        if (dismissedIndex >= 0) { state.dismissed.splice(dismissedIndex, 1); changed = true }
      }
      if ((item.phase === 'done' || item.phase === 'failed') && state.dismissed.includes(item.id)) continue

      let list = state.platforms[platform] || []
      if (index === 0) {
        const kept = list.filter(existing => existing.phase === 'done' || existing.phase === 'failed' || existing.id === item.id)
        if (kept.length !== list.length) { list = kept; changed = true }
      }
      const existingIndex = list.findIndex(existing => existing.id === item.id)
      if (existingIndex >= 0) {
        const previous = list[existingIndex]
        const sameTerminalPhase = (item.phase === 'done' || item.phase === 'failed') && previous.phase === item.phase
        if (sameTerminalPhase && previous.updatedAt) item.updatedAt = previous.updatedAt
        if (!(previous.phase === 'done' && item.phase === 'idle')) {
          list[existingIndex] = mergeDefined(previous, item)
          changed = true
        }
      } else {
        list.push(item)
        changed = true
      }
      const seen = new Set()
      list = list.filter(existing => seen.has(existing.id) ? false : (seen.add(existing.id), true))
      list.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
      if (list.length > 12) list = list.slice(0, 12)
      state.platforms[platform] = list
    }
  }
  trimDismissed(state)
  return changed
}

function dismissTaskHistory(state, taskID) {
  const platform = String(taskID || '').split('|')[0]
  const task = (state.platforms[platform] || []).find(item => item.id === taskID)
  if (!task) return false
  if (task.phase === 'done') {
    if (!state.dismissed.includes(taskID)) state.dismissed.push(taskID)
  } else {
    state.hidden[taskID] = task.title || task.action || ''
  }
  state.platforms[platform] = (state.platforms[platform] || []).filter(item => item.id !== taskID)
  trimDismissed(state)
  return true
}

function dismissPlatformHistory(state, platform, liveStatus) {
  const key = String(platform || '')
  function remember(id, title, phase) {
    if (!id) return
    if (phase === 'done') {
      if (!state.dismissed.includes(id)) state.dismissed.push(id)
    } else {
      state.hidden[id] = title || ''
    }
  }
  for (const task of state.platforms[key] || []) remember(task.id, task.title || task.action, task.phase)
  const liveTasks = liveStatus
    ? (liveStatus.tasks && liveStatus.tasks.length ? liveStatus.tasks : (liveStatus.task ? [liveStatus.task] : []))
    : []
  for (const task of liveTasks) {
    remember(canonicalID(key, task), String(task.title || '').trim() || task.action || liveStatus.detail || '', task.phase || liveStatus.phase)
  }
  if (key) state.platforms[key] = []
  trimDismissed(state)
}

module.exports = {
  APPLE_REF_MS, DONE_TTL_SECONDS, accumulateTaskHistory, canonicalID, dismissPlatformHistory,
  dismissTaskHistory, expireTaskHistory, normalizeTaskHistory, sessionDisplayName
}
