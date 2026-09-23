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

function accumulateTaskHistory(state, snap, nowMilliseconds = Date.now()) {
  let changed = false
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
  if (expired.size) {
    for (const [platform, list] of Object.entries(state.platforms)) {
      state.platforms[platform] = (list || []).filter(item => !expired.has(item.id))
    }
    changed = true
  }

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
        if (!(list[existingIndex].phase === 'done' && item.phase === 'idle')) {
          list[existingIndex] = mergeDefined(list[existingIndex], item)
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
  dismissTaskHistory, sessionDisplayName
}
