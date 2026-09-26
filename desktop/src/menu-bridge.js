'use strict'

function createLineDecoder(onValue, onError = () => {}) {
  let buffer = ''
  return {
    push(chunk) {
      buffer += String(chunk || '')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try { onValue(JSON.parse(line)) } catch (error) { onError(error, line) }
      }
    },
    pending() { return buffer }
  }
}

function menuBridgeState(input = {}) {
  const installed = Array.isArray(input.installedPets) ? input.installedPets : []
  const defaults = Array.isArray(input.defaultPets) ? input.defaultPets : []
  return {
    type: 'state',
    visible: Boolean(input.visible),
    hasPet: Boolean(input.hasPet),
    busy: Boolean(input.busy),
    busyLabel: input.busyLabel == null ? null : String(input.busyLabel),
    scalePercent: String(input.scalePercent || '100%'),
    tooltip: String(input.tooltip || 'AllPet'),
    statusIconPath: input.statusIconPath ? String(input.statusIconPath) : null,
    bubblePlatforms: (Array.isArray(input.bubblePlatforms) ? input.bubblePlatforms : []).map(row => ({ key: String(row.key), label: String(row.label), visible: row.visible !== false })),
    platformTitles: (Array.isArray(input.platformTitles) ? input.platformTitles : []).map(String),
    installedPets: installed.map(item => ({
      label: String(item.label || ''), target: String(item.target || ''), current: Boolean(item.current),
      iconPath: item.iconPath ? String(item.iconPath) : null
    })),
    defaultPets: defaults.map(item => ({
      label: String(item.label || ''), source: String(item.source || ''),
      iconPath: item.iconPath ? String(item.iconPath) : null
    }))
  }
}

module.exports = { createLineDecoder, menuBridgeState }
