'use strict'

const { PLATFORM_KEYS } = require('./platforms')

function trayPanelBounds(anchor, workArea) {
  const width = Math.min(304, workArea.width - 16)
  const height = Math.min(568, workArea.height - 16)
  const x = Math.max(workArea.x + 8, Math.min(anchor.x + anchor.width / 2 - width / 2, workArea.x + workArea.width - width - 8))
  const below = anchor.y + anchor.height + 6
  const y = below + height <= workArea.y + workArea.height - 8 ? below : anchor.y - height - 6
  return { x: Math.round(x), y: Math.round(Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - height - 8))), width, height }
}

function trayPanelLayout(anchor, workArea, expanded = false) {
  const bounds = trayPanelBounds(anchor, workArea)
  if (!expanded || workArea.width < 620) return { bounds, rootSide: 'left' }
  const extra = 294
  if (bounds.x + bounds.width + extra <= workArea.x + workArea.width - 8) {
    return { bounds: { ...bounds, width: bounds.width + extra }, rootSide: 'left' }
  }
  return { bounds: { ...bounds, x: Math.max(workArea.x + 8, bounds.x - extra), width: bounds.width + extra }, rootSide: 'right' }
}

// Only actions that open another window, a confirmation or an external app close the panel.
function keepsTrayPanelOpen(action) {
  return ['bubble-platform-toggle', 'bubble-platform-all', 'scale-decrease', 'scale-increase', 'pet-select', 'toggle-visibility', 'refresh-pets'].includes(action)
}

function validTrayPanelAction(action, value, state) {
  if (action === 'bubble-platform-toggle') return PLATFORM_KEYS.has(value)
  if (action === 'bubble-platform-all') return ['show', 'hide'].includes(value)
  if (action === 'integration-install') return ['cursor', 'qoder'].includes(value) && !state.busy
  if (action === 'pet-select' || action === 'pet-delete') return !state.busy && state.installedPets.some(row => row.target === value)
  if (action === 'pet-install') return !state.busy && state.defaultPets.some(row => row.source === value)
  if (action === 'scale-decrease' || action === 'scale-increase') return state.hasPet && !state.busy
  if (action === 'refresh-pets') return !state.busy
  if (action === 'open-manager') return !state.busy && [undefined, null, 'install', 'import'].includes(value)
  if (action === 'open-accessibility') return state.accessibility !== undefined
  return ['toggle-visibility', 'terminal-setup', 'open-config', 'quit'].includes(action)
}

module.exports = { trayPanelBounds, trayPanelLayout, keepsTrayPanelOpen, validTrayPanelAction }
