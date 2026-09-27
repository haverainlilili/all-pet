'use strict'
const api = window.allpetMenu
const root = document.getElementById('root')
const child = document.getElementById('items')
let items = root
let hoverTimer = null
let state = null
let page = 'root'
let actionPending = false
function node(tag, text, className) {
  const value = document.createElement(tag)
  if (text != null) value.textContent = text
  if (className) value.className = className
  return value
}
function separator() { items.append(node('hr')) }
function navigate(next) {
  clearTimeout(hoverTimer)
  page = next; child.scrollTop = 0; render()
  api.layout(page !== 'root').then(layout => { document.body.dataset.side = layout.rootSide })
}
async function act(action, value) {
  if (actionPending) return
  actionPending = true
  const error = document.getElementById('error')
  error.hidden = true
  try {
    const result = await api.action(action, value)
    if (!result.ok) throw new Error(result.error || '操作未完成')
    if (result.state) state = result.state
  } catch (reason) { error.textContent = reason.message; error.hidden = false }
  finally { actionPending = false; render() }
}
function button(label, action, value, disabled = false) {
  const row = node('button', null, 'row')
  row.type = 'button'; row.disabled = disabled
  row.dataset.action = action; if (value != null) row.dataset.value = value
  row.append(node('span', label, 'label'))
  row.addEventListener('click', () => act(action, value))
  row.addEventListener('mouseenter', () => { if (row.parentElement === root) { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => navigate('root'), 160) } })
  return row
}
function menu(label, target) {
  const row = node('button', null, 'row')
  row.dataset.page = target
  row.append(node('span', label, 'label'), node('span', '›', 'chevron'))
  row.setAttribute('aria-haspopup', 'menu'); row.setAttribute('aria-expanded', String(page === target))
  row.classList.toggle('selected', page === target)
  row.addEventListener('click', () => navigate(target))
  row.addEventListener('mouseenter', () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => navigate(target), 120) })
  row.addEventListener('mouseleave', () => clearTimeout(hoverTimer))
  items.append(row)
}
function render() {
  if (!state) return
  const active = document.activeElement
  const key = active && JSON.stringify([active.dataset.action, active.dataset.value, active.dataset.page])
  const scroll = items.scrollTop
  // Refresh rows without closing or recreating the panel window.
  root.replaceChildren(); child.replaceChildren()
  items = root
  renderRoot()
  const submenu = document.getElementById('submenu')
  submenu.hidden = page === 'root'
  const anchorRow = root.querySelector(`[data-page="${page}"]`)
  submenu.style.marginTop = `${anchorRow ? Math.min(anchorRow.offsetTop, 160) : 0}px`
  items = child
  if (page === 'platforms') {
    for (const platform of state.bubblePlatforms) {
      const row = button(platform.label, 'bubble-platform-toggle', platform.key)
      row.setAttribute('role', 'menuitemcheckbox'); row.setAttribute('aria-checked', String(platform.visible))
      row.prepend(node('span', platform.visible ? '✓' : '', 'mark')); items.append(row)
    }
    separator()
    items.append(button('全部显示', 'bubble-platform-all', 'show'), button('全部隐藏', 'bubble-platform-all', 'hide'))
    items.append(node('p', '仅影响气泡显示，保留任务历史', 'note'))
  } else if (page === 'pets') {
    for (const pet of state.installedPets) {
      const wrapper = node('div', null, 'pet-row')
      const row = button(pet.label, 'pet-select', pet.target, state.busy || pet.current)
      const sprite = node('span', null, 'sprite')
      if (pet.thumbnailURL) {
        const img = node('img'); img.src = pet.thumbnailURL; img.alt = ''
        img.style.width = `${22 * pet.columns}px`; img.style.height = `${24 * pet.rows}px`; sprite.append(img)
      }
      row.prepend(node('span', pet.current ? '✓' : '', 'mark'), sprite)
      const remove = button('×', 'pet-delete', pet.target, state.busy)
      remove.className = 'delete'; remove.setAttribute('aria-label', `删除 ${pet.label}`)
      wrapper.append(row, remove); items.append(wrapper)
    }
    if (!state.installedPets.length) items.append(node('p', '暂无已安装宠物', 'note'))
    separator()
    if (state.defaultPets.length) items.append(node('p', '未安装的默认宠物', 'note'))
    for (const pet of state.defaultPets) items.append(button(pet.label, 'pet-install', pet.source, state.busy))
    separator()
    items.append(button('宠物管理…', 'open-manager', null, state.busy), button('从 GitHub 安装宠物…', 'open-manager', 'install', state.busy))
    items.append(button(state.importLocal ? '导入本地宠物…' : '导入本地宠物（仅 macOS）', 'open-manager', 'import', state.busy || !state.importLocal))
    items.append(button('刷新宠物目录', 'refresh-pets', null, state.busy))
  } else if (page === 'integrations') {
    items.append(button('启用/修复 Cursor', 'integration-install', 'cursor', state.busy), button('启用/修复 Qoder', 'integration-install', 'qoder', state.busy), button('终端接入说明与扩展…', 'terminal-setup'))
  }
  items.scrollTop = scroll
  const match = [...document.querySelectorAll('.menu button')].find(row => JSON.stringify([row.dataset.action, row.dataset.value, row.dataset.page]) === key)
  if (match && !match.disabled) match.focus({ preventScroll: true })
}
function renderRoot() {
    items.append(button(state.visible ? '隐藏宠物' : '显示宠物', 'toggle-visibility'))
    const scale = node('div', null, 'group')
    const decrease = button('−', 'scale-decrease', null, state.busy || !state.hasPet)
    const increase = button('＋', 'scale-increase', null, state.busy || !state.hasPet)
    decrease.setAttribute('aria-label', '减小宠物 5%'); increase.setAttribute('aria-label', '增大宠物 5%')
    scale.append(node('span', '宠物大小', 'label'), decrease, node('span', state.scalePercent, 'percent'), increase); items.append(scale)
    menu('宠物', 'pets'); separator(); menu('气泡显示平台', 'platforms'); menu('实时状态接入', 'integrations')
    separator()
    for (const title of state.platformTitles) { const row = node('p', title, 'status'); row.title = title; items.append(row) }
    separator()
    if (state.busy) items.append(node('p', `正在${state.busyLabel || '操作'}…`, 'note'))
    if (state.accessibility !== undefined) items.append(button(state.accessibility ? '自动确认：辅助功能权限已开启' : '自动确认：开启辅助功能权限…', 'open-accessibility'))
    items.append(button('打开配置', 'open-config'), button('退出', 'quit'))
}
document.getElementById('back').addEventListener('click', () => navigate('root'))
document.body.addEventListener('mousedown', event => { if (event.target === document.body) api.close() })
document.getElementById('submenu').addEventListener('mouseenter', () => clearTimeout(hoverTimer))
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); api.close() }
  if (event.key === 'ArrowRight' && document.activeElement.dataset.page) { event.preventDefault(); navigate(document.activeElement.dataset.page); child.querySelector('button:not(:disabled)')?.focus() }
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault()
    const menu = document.activeElement.closest('.menu') || root
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')].filter(button => button.offsetParent !== null)
    const index = buttons.indexOf(document.activeElement), direction = event.key === 'ArrowDown' ? 1 : -1
    buttons[(index + direction + buttons.length) % buttons.length]?.focus()
  }
  if (event.key === 'ArrowLeft' && page !== 'root') { event.preventDefault(); navigate('root') }
})
api.onState(next => { state = next; render() })
api.state().then(next => { state = next; render() })
