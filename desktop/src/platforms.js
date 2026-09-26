'use strict'

const PLATFORMS = [
  { key: 'codex', label: 'Codex', color: '#0fa380' },
  { key: 'claude', label: 'Claude Code', color: '#cc6b4d' },
  { key: 'dsh', label: 'DSH', color: '#4d6bfa' },
  { key: 'grok', label: 'Grok', color: '#8e8e93' },
  { key: 'cursor', label: 'Cursor', color: '#6366f1' },
  { key: 'workbuddy', label: 'WorkBuddy', color: '#0891b2' },
  { key: 'qoder', label: 'Qoder', color: '#a855f7' },
  { key: 'pi', label: 'pi', color: '#ea8b22' },
  { key: 'zcode', label: 'Z Code', color: '#3478f6' }
]
const PLATFORM_KEYS = new Set(PLATFORMS.map(row => row.key))

function hiddenBubblePlatforms(config) {
  return new Set((Array.isArray(config && config.hiddenBubblePlatforms) ? config.hiddenBubblePlatforms : [])
    .filter(key => PLATFORM_KEYS.has(key)))
}

function bubblePlatformRows(config) {
  const hidden = hiddenBubblePlatforms(config)
  return PLATFORMS.map(row => ({ ...row, visible: !hidden.has(row.key) }))
}

function setBubblePlatformVisibility(config, key, visible) {
  if (key !== 'all' && !PLATFORM_KEYS.has(key)) throw new Error('未知平台')
  const hidden = hiddenBubblePlatforms(config)
  for (const row of PLATFORMS) {
    if (key !== 'all' && row.key !== key) continue
    if (visible) hidden.delete(row.key)
    else hidden.add(row.key)
  }
  return { ...config, hiddenBubblePlatforms: [...hidden] }
}

function filterBubbleSnapshot(snapshot, config) {
  const hidden = hiddenBubblePlatforms(config)
  return {
    ...snapshot,
    platforms: (snapshot.platforms || []).filter(row => !hidden.has(row.platform)),
    history: { ...snapshot.history, platforms: Object.fromEntries(
      Object.entries(snapshot.history && snapshot.history.platforms || {}).filter(([key]) => !hidden.has(key))
    ) }
  }
}

function platformPage(groups, requestedPage = 0) {
  const count = Math.max(1, Math.ceil(groups.length / 4))
  const index = Math.max(0, Math.min(count - 1, requestedPage))
  return { index, count, groups: groups.slice(index * 4, index * 4 + 4) }
}

const platformExports = { PLATFORMS, PLATFORM_KEYS, bubblePlatformRows, hiddenBubblePlatforms, setBubblePlatformVisibility, filterBubbleSnapshot, platformPage }
if (typeof module !== 'undefined' && module.exports) module.exports = platformExports
else window.AllPetPlatforms = platformExports
