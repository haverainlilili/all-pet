'use strict'

const path = require('node:path')

const DEFAULT_CELL_WIDTH = 192
const DEFAULT_CELL_HEIGHT = 208

function attachRestartOnClose(child, options) {
  child.on('error', error => options.onError(error))
  child.once('close', () => {
    if (!options.isCurrent()) return
    options.clearCurrent()
    if (options.shouldRestart()) options.scheduleRestart()
  })
}

function petCapabilities(runtimePlatform) {
  return {
    importLocal: runtimePlatform === 'darwin',
    importLocalReason: runtimePlatform === 'darwin'
      ? null
      : '本地多格式宠物转换当前依赖 macOS AppKit/ImageIO；Windows 与 Linux 可安装标准宠物包。'
  }
}

function expandHomePath(value, homeDirectory) {
  const raw = String(value || '')
  if (raw === '~') return homeDirectory
  if (/^~[\\/]/.test(raw)) {
    return path.join(homeDirectory, raw.slice(2).replace(/[\\/]+/g, path.sep))
  }
  return raw
}

function petMutationTarget(pet) {
  return String(pet && (pet.directoryPath || pet.target || pet.id) || '')
}

function chooseCurrentPet(pets) {
  const list = Array.isArray(pets) ? pets : []
  return list.find(item => item && item.current) || list.find(Boolean) || null
}

function createOperationGate(onChange) {
  let active = null
  const notify = typeof onChange === 'function' ? onChange : () => {}
  return {
    get active() { return active },
    async run(label, operation) {
      if (active) {
        return { ok: false, busy: true, error: `正在${active}，请稍候。` }
      }
      active = label
      notify({ busy: true, label })
      try {
        const result = await operation()
        return result && typeof result === 'object' ? result : { ok: true }
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) }
      } finally {
        active = null
        notify({ busy: false, label: null })
      }
    }
  }
}

function spriteSizeForPet(pet, scale) {
  const cellWidth = Number(pet && pet.cellWidth) > 0 ? Number(pet.cellWidth) : DEFAULT_CELL_WIDTH
  const cellHeight = Number(pet && pet.cellHeight) > 0 ? Number(pet.cellHeight) : DEFAULT_CELL_HEIGHT
  const width = Math.min(224, Math.max(80, Math.round(cellWidth * scale)))
  return { width, height: Math.round(width * (cellHeight / cellWidth)) }
}

function preservedWindowBounds(options) {
  const { oldBounds, oldSprite, nextWindow, nextSprite, workArea } = options
  const margin = Number.isFinite(options.margin) ? options.margin : 20
  const oldSpriteX = oldBounds.x + Math.round((oldBounds.width - oldSprite.width) / 2)
  const oldSpriteBottom = oldBounds.y + oldBounds.height
  let x = oldSpriteX - Math.round((nextWindow.width - nextSprite.width) / 2)
  let y = oldSpriteBottom - nextWindow.height
  const minX = workArea.x + margin
  const maxX = workArea.x + workArea.width - nextWindow.width - margin
  const minY = workArea.y + margin
  const maxY = workArea.y + workArea.height - nextWindow.height - margin
  x = maxX < minX ? workArea.x : Math.min(maxX, Math.max(minX, x))
  y = maxY < minY ? workArea.y : Math.min(maxY, Math.max(minY, y))
  return { x: Math.round(x), y: Math.round(y), width: nextWindow.width, height: nextWindow.height }
}

module.exports = {
  attachRestartOnClose,
  chooseCurrentPet,
  createOperationGate,
  expandHomePath,
  petCapabilities,
  petMutationTarget,
  preservedWindowBounds,
  spriteSizeForPet
}
