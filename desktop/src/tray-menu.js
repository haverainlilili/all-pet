'use strict'

function graphemePrefix(value, maximumLength) {
  const text = String(value || '')
  const limit = Math.max(0, Number(maximumLength) || 0)
  if (!limit) return ''
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)
    return Array.from(segments, item => item.segment).slice(0, limit).join('')
  }
  return Array.from(text).slice(0, limit).join('')
}

function platformStatusTitle(status) {
  const label = String(status && status.label || status && status.platform || '')
  const phase = String(status && status.phaseLabel || status && status.phase || '')
  let title = `${label}：${phase}`
  const action = String(status && status.task && status.task.action || '').trim()
  if (action) title += ` · ${graphemePrefix(action, 28)}`
  return title
}

const { PLATFORMS } = require('./platforms')
const PLATFORM_ROWS = PLATFORMS.map(row => ({ platform: row.key, label: row.label }))

function platformMenuTitles(statuses, disabledPlatforms = []) {
  const list = Array.isArray(statuses) ? statuses : []
  const disabled = new Set(Array.isArray(disabledPlatforms) ? disabledPlatforms : [])
  return PLATFORM_ROWS.map(row => {
    const status = list.find(item => item && item.platform === row.platform)
    if (status) return platformStatusTitle({ ...status, label: row.label })
    return disabled.has(row.platform) ? `${row.label}：已禁用` : `${row.label}：加载中…`
  })
}

function trayPrimaryAction(platform) {
  return String(platform || '') === 'darwin' ? 'open-menu' : 'toggle-pet'
}

function reopensAfterTrayAction(platform, action) {
  return String(platform || '') === 'darwin' && (action === 'scale-decrease' || action === 'scale-increase')
}

const TRAY_PET_ICON_CACHE_VERSION = 'menu-v4'

function trayPetIconFrames() {
  return [[0, 0]]
}

function scalePercentText(scale) {
  const defaultScale = 112 / 192
  const value = Number.isFinite(Number(scale)) ? Number(scale) : defaultScale
  return `${Math.round(value / defaultScale * 100)}%`
}

function petTrayActionTitles(importLocalSupported) {
  return {
    install: '从 GitHub 安装宠物…',
    importLocal: importLocalSupported ? '导入本地宠物…' : '导入本地宠物（仅 macOS）',
    deletePet: '删除宠物…',
    refresh: '刷新宠物目录'
  }
}

function petTrayRows(pets, defaults) {
  const installed = (Array.isArray(pets) ? pets : []).map(item => ({
    kind: 'installed',
    label: String(item.displayName || item.id || '未命名宠物'),
    current: Boolean(item.current),
    target: String(item.directoryPath || item.target || item.id || '')
  }))
  const pending = (Array.isArray(defaults) ? defaults : []).map(item => ({
    kind: 'default',
    label: String(item.displayName || item.slug || '默认宠物'),
    source: String(item.slug || '')
  })).filter(item => item.source)
  return { installed, pending }
}

module.exports = { TRAY_PET_ICON_CACHE_VERSION, graphemePrefix, platformMenuTitles, platformStatusTitle, scalePercentText, petTrayActionTitles, petTrayRows, reopensAfterTrayAction, trayPetIconFrames, trayPrimaryAction }
