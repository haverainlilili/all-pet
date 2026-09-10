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

const DEFAULT_SCALE = 112 / 192

function percentText(scale) {
  return Math.round((scale / DEFAULT_SCALE) * 100) + '%'
}

function setStatus(msg, isError) {
  statusEl.textContent = msg || ''
  statusEl.style.color = isError ? '#ff3b30' : '#888'
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

async function load() {
  setStatus('加载中…')
  const result = await window.petAPI.listPets()
  if (!result.ok) {
    setStatus('加载失败：' + (result.error || '未知错误'), true)
    return
  }
  setStatus('')
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
      const yes = await confirmModal(`删除宠物「${p.displayName}」？此操作不可撤销。`)
      if (!yes) return
      setStatus(`删除中：${p.displayName}…`)
      const r = await window.petAPI.deletePet(p.id)
      if (r.ok) load()
      else setStatus('删除失败：' + (r.error || '未知错误'), true)
    }
    card.appendChild(del)

    card.onclick = async () => {
      if (p.current) return
      setStatus(`切换中：${p.displayName}…`)
      const r = await window.petAPI.setPet(p.id)
      if (r.ok) load()
      else setStatus('切换失败：' + (r.error || '未知错误'), true)
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
      setStatus(`安装中：${d.displayName}…`)
      const r = await window.petAPI.installPet(d.installCommand)
      if (r.ok) load()
      else setStatus('安装失败：' + (r.error || '未知错误'), true)
    }
    defaultsEl.appendChild(row)
  }
}

document.getElementById('importBtn').onclick = async () => {
  setStatus('选择宠物文件或目录…')
  const r = await window.petAPI.importPet()
  if (r.ok) load()
  else if (r.canceled) setStatus('')
  else setStatus('导入失败：' + (r.error || '未知错误'), true)
}

document.getElementById('installBtn').onclick = async () => {
  const source = await promptModal('输入安装来源', '如 petdex install boba 或 https://github.com/…')
  if (source === null || !source.trim()) return
  setStatus(`安装中：${source.trim()}…`)
  const r = await window.petAPI.installPet(source.trim())
  if (r.ok) load()
  else setStatus('安装失败：' + (r.error || '未知错误'), true)
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

window.petAPI.onPetsChanged(() => load())
refreshScale()
load()
