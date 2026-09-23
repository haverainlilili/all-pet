'use strict'

const statusEl = document.getElementById('status')
const petsEl = document.getElementById('pets')
const defaultsEl = document.getElementById('defaults')
const sizeDecEl = document.getElementById('sizeDec')
const sizeIncEl = document.getElementById('sizeInc')
const sizeLabelEl = document.getElementById('sizeLabel')
const modalEl = document.getElementById('modal')
const modalText = document.getElementById('modalText')
const modalInput = document.getElementById('modalInput')
const modalOk = document.getElementById('modalOk')
const modalCancel = document.getElementById('modalCancel')
const importBtn = document.getElementById('importBtn')
const installBtn = document.getElementById('installBtn')

let busy = false
const loadGate = window.latestCommit.createLatestGate()
let importLocalSupported = true
let importLocalReason = ''

const DEFAULT_SCALE = 112 / 192

function percentText(scale) {
  return Math.round((scale / DEFAULT_SCALE) * 100) + '%'
}

function setStatus(msg, isError) {
  statusEl.textContent = msg || ''
  statusEl.style.color = isError ? '#ff3b30' : '#888'
}

function setBusy(nextBusy, label) {
  busy = Boolean(nextBusy)
  document.body.classList.toggle('operation-busy', busy)
  for (const button of document.querySelectorAll('button')) button.disabled = busy
  importBtn.disabled = busy || !importLocalSupported
  importBtn.title = importLocalSupported ? '' : importLocalReason
  if (busy && label) setStatus(`正在${label}…`)
}

async function mutate(label, operation) {
  if (busy) return
  setBusy(true, label)
  try {
    const result = await operation()
    if (result && result.ok) setStatus(result.message || `${label}完成`)
    else if (result && result.canceled) setStatus('')
    else setStatus(`${label}失败：${result && result.error || '未知错误'}`, true)
    return result
  } catch (err) {
    setStatus(`${label}失败：${String(err && err.message || err)}`, true)
    return { ok: false }
  } finally {
    setBusy(false)
  }
}

// 简单的模态框：type = 'confirm' | 'prompt'
function openModal(type, text, placeholder) {
  return new Promise((resolve) => {
    modalText.textContent = text
    modalInput.value = ''
    modalInput.placeholder = placeholder || ''
    if (type === 'prompt') modalInput.classList.remove('hidden')
    else modalInput.classList.add('hidden')
    modalEl.classList.remove('hidden')
    modalInput.focus()
    const done = (val) => {
      modalEl.classList.add('hidden')
      modalOk.onclick = null
      modalCancel.onclick = null
      resolve(val)
    }
    modalOk.onclick = () => done(type === 'prompt' ? modalInput.value : true)
    modalCancel.onclick = () => done(type === 'prompt' ? null : false)
  })
}

function confirmModal(text) { return openModal('confirm', text) }
function promptModal(text, placeholder) { return openModal('prompt', text, placeholder) }

// 用 Chromium 解码精灵图（原生支持 webp），裁出 idle 首帧并缩放为缩略图。
function makeThumbnail(spritesheetDataUrl, cellWidth, cellHeight) {
  return new Promise((resolve) => {
    if (!spritesheetDataUrl) { resolve(null); return }
    const img = new Image()
    img.onload = () => {
      try {
        const cw = cellWidth || Math.floor(img.naturalWidth / 8)
        const ch = cellHeight || Math.floor(img.naturalHeight / 9)
        const src = document.createElement('canvas')
        src.width = cw
        src.height = ch
        src.getContext('2d').drawImage(img, 0, 0, cw, ch, 0, 0, cw, ch)
        const target = 72
        const scale = Math.min(1, target / cw, target / ch)
        const out = document.createElement('canvas')
        out.width = Math.max(1, Math.round(cw * scale))
        out.height = Math.max(1, Math.round(ch * scale))
        out.getContext('2d').drawImage(src, 0, 0, out.width, out.height)
        resolve(out.toDataURL('image/png'))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = spritesheetDataUrl
  })
}

async function load(options = {}) {
  const isLatest = loadGate.begin()
  if (!options.preserveStatus) setStatus('加载中…')
  const result = await window.petAPI.listPets()
  if (!isLatest()) return
  if (!result.ok) {
    setStatus('加载失败：' + (result.error || '未知错误'), true)
    return
  }
  const capabilities = result.capabilities || {}
  importLocalSupported = capabilities.importLocal !== false
  importLocalReason = capabilities.importLocalReason || ''
  importBtn.textContent = importLocalSupported ? '导入本地宠物…' : '导入本地宠物（仅 macOS）'
  setBusy(Boolean(result.operation && result.operation.busy), result.operation && result.operation.label)
  if (!options.preserveStatus && !busy) setStatus('')
  renderPets(result.pets || [])
  renderDefaults(result.defaults || [])
}

function renderPets(pets) {
  petsEl.innerHTML = ''
  if (!pets.length) {
    const empty = document.createElement('div')
    empty.textContent = '暂无已安装宠物'
    empty.style.cssText = 'color:#999;font-size:13px;'
    petsEl.appendChild(empty)
    return
  }
  for (const p of pets) {
    const card = document.createElement('div')
    card.className = 'pet-card' + (p.current ? ' current' : '')
    if (p.current) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = '当前'
      card.appendChild(badge)
    }
    const img = document.createElement('img')
    img.alt = p.displayName
    img.style.opacity = '0.4'
    card.appendChild(img)
    makeThumbnail(p.spritesheet, p.cellWidth, p.cellHeight).then((url) => {
      img.src = url || ''
      img.style.opacity = ''
    })
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = p.displayName
    card.appendChild(name)

    const del = document.createElement('button')
    del.className = 'del'
    del.textContent = '✕'
    del.title = '删除宠物'
    del.onclick = async (e) => {
      e.stopPropagation()
      if (busy) return
      const yes = await confirmModal(`删除宠物「${p.displayName}」？此操作不可撤销。`)
      if (!yes) return
      await mutate('删除宠物', () => window.petAPI.deletePet(p.target || p.id))
    }
    card.appendChild(del)

    card.onclick = async () => {
      if (p.current || busy) return
      await mutate('切换宠物', () => window.petAPI.setPet(p.target || p.id))
    }
    petsEl.appendChild(card)
  }
}

function renderDefaults(defaults) {
  defaultsEl.innerHTML = ''
  if (!defaults.length) return
  for (const d of defaults) {
    const row = document.createElement('div')
    row.className = 'row'
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.textContent = '↓'
    row.appendChild(dot)
    const info = document.createElement('div')
    info.className = 'info'
    const n = document.createElement('div')
    n.className = 'n'
    n.textContent = d.displayName
    info.appendChild(n)
    const s = document.createElement('div')
    s.className = 's'
    s.textContent = d.installCommand
    info.appendChild(s)
    row.appendChild(info)
    row.onclick = async () => {
      if (busy) return
      await mutate('安装宠物', () => window.petAPI.installPet(d.installCommand))
    }
    defaultsEl.appendChild(row)
  }
}

importBtn.onclick = async () => {
  if (!importLocalSupported) { setStatus(importLocalReason, true); return }
  await mutate('导入宠物', () => window.petAPI.importPet())
}

installBtn.onclick = async () => {
  if (busy) return
  const source = await promptModal('输入安装来源', '如 petdex install boba 或 https://github.com/…')
  if (source === null || !source.trim()) return
  await mutate('安装宠物', () => window.petAPI.installPet(source.trim()))
}

async function refreshScale() {
  const r = await window.petAPI.getScale()
  if (r && r.ok) sizeLabelEl.textContent = percentText(r.scale)
}

sizeDecEl.onclick = async () => {
  const r = await window.petAPI.setScale(-0.05)
  if (r && r.ok) sizeLabelEl.textContent = percentText(r.scale)
}

sizeIncEl.onclick = async () => {
  const r = await window.petAPI.setScale(0.05)
  if (r && r.ok) sizeLabelEl.textContent = percentText(r.scale)
}

window.petAPI.onPetsChanged(() => load({ preserveStatus: true }))
window.petAPI.onPetOperation((state) => {
  if (state && state.busy) loadGate.invalidate()
  setBusy(state && state.busy, state && state.label)
})
refreshScale()
load()
