// AllPet 跨平台桌宠（Electron 主进程）
// 复用 Swift AllPetCore：以子进程跑 `allpet watch --json`，把 NDJSON 快照转发给渲染层。
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog, screen } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

// CI / 无头环境：禁用沙箱与 GPU，便于 xvfb 下冒烟测试。
if (process.env.ALLPET_NO_SANDBOX) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
}

let mainWindow = null
let petManagerWindow = null
let tray = null
let watchProc = null
let currentSnapshot = null
let pet = null // { bundlePath, spritesheetPath, manifestId, displayName }

// ---- 路径解析 ----

function allpetBinary() {
  const exe = process.platform === 'win32' ? 'allpet.exe' : 'allpet'
  const candidates = []
  // 打包后：sidecar 二进制位于 resourcesPath/sidecar/。
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'sidecar', exe))
  }
  const root = path.join(__dirname, '..')
  candidates.push(
    path.join(root, '.build', 'release', exe),
    path.join(root, '.build', 'debug', exe),
    path.join(root, exe)
  )
  for (const c of candidates) if (fs.existsSync(c)) return c
  return 'allpet' // 回退到 PATH
}

function configPath() {
  return path.join(os.homedir(), '.config', 'all-pet', 'config.json')
}

function readCurrentPet() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    const bundlePath = cfg && cfg.pet && cfg.pet.bundlePath
    if (!bundlePath || !fs.existsSync(path.join(bundlePath, 'pet.json'))) return null
    const manifest = JSON.parse(fs.readFileSync(path.join(bundlePath, 'pet.json'), 'utf8'))
    const sp = manifest.spritesheetPath || 'spritesheet.webp'
    return {
      bundlePath,
      spritesheetPath: path.join(bundlePath, sp),
      manifestId: manifest.id || path.basename(bundlePath),
      displayName: manifest.displayName || manifest.id || 'Pet'
    }
  } catch {
    return null
  }
}

const CELL_W = 192
const CELL_H = 208
const DEFAULT_SCALE = 112 / 192
const MIN_SCALE = 0.4
const MAX_SCALE = 1.2

function readScale() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    const s = cfg && cfg.pet && typeof cfg.pet.scale === 'number' ? cfg.pet.scale : DEFAULT_SCALE
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
  } catch {
    return DEFAULT_SCALE
  }
}

// 当前气泡高度（0 = 隐藏）；渲染层实时上报，用于窗口高度对齐 macOS 的「宠物在上、气泡在下」。
let bubbleHeight = 0

// 精灵按 scale 缩放；显示宽 clamp 80…224px（与 macOS layoutMetrics 一致）。
// 气泡宽度保持最小可读（160px），高度随气泡行数动态调整。
function spriteSizeForScale(scale) {
  const spriteW = Math.min(224, Math.max(80, Math.round(CELL_W * scale)))
  const spriteH = Math.round(spriteW * (CELL_H / CELL_W))
  return { width: spriteW, height: spriteH }
}

function windowSizeForScale(scale) {
  const sprite = spriteSizeForScale(scale)
  return {
    width: Math.max(sprite.width, 160) + 24,
    height: sprite.height + (bubbleHeight > 0 ? bubbleHeight + 14 : 8)
  }
}

function readAnchor() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    const a = cfg && cfg.pet && typeof cfg.pet.anchor === 'string' ? cfg.pet.anchor : 'bottom-right'
    return a
  } catch {
    return 'bottom-right'
  }
}

// 与 macOS 对齐：按 config.pet.anchor 定位到屏幕四角（默认右下角）。
function positionWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const anchor = readAnchor()
  const margin = 20
  const isLeft = anchor.endsWith('left')
  const isTop = anchor.startsWith('top')
  const area = screen.getPrimaryDisplay().workArea
  const size = mainWindow.getSize()
  const x = isLeft ? area.x + margin : area.x + area.width - size[0] - margin
  const y = isTop ? area.y + area.height - size[1] - margin : area.y + margin
  mainWindow.setPosition(Math.round(x), Math.round(y))
}

// ---- 任务历史（与 macOS 共享 ~/.config/all-pet/task-history.json）----

let taskHistory = {}      // { [platform]: [item] }
let dismissedTaskIDs = []
let dragStartScreen = null  // 精灵拖动起点（屏幕坐标）
let dragStartPosition = null // 拖动开始时窗口位置

const APPLE_REF_MS = Date.UTC(2001, 0, 1) // macOS Codable Date 基准：2001-01-01

function historyURL() {
  return path.join(os.homedir(), '.config', 'all-pet', 'task-history.json')
}

function isUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '')
}

// 与 macOS TrayTaskItem.canonicalID 对齐：定时任务按名归并，其余按 sessionID（空则 title）。
function canonicalID(platform, task) {
  if (task.scheduledTaskName) return `${platform}|scheduled:${task.scheduledTaskName}`
  let identity = (task.sessionID || '').length ? task.sessionID : (task.title || '').trim()
  if (platform === 'dsh' && isUUID(identity)) identity = 'session-' + identity
  return `${platform}|${identity || 'current'}`
}

// 与 macOS TrayTaskItem.sessionDisplayName 对齐。
function sessionDisplayName(item) {
  if (item.scheduledTaskName) return `定时任务 · ${item.scheduledTaskName}`
  if (item.sessionName && item.sessionName.trim()) return item.sessionName.trim()
  if (item.sessionID) {
    const v = item.sessionID.indexOf('session-') === 0 ? item.sessionID.slice(8) : item.sessionID
    return `会话 ${String(v).slice(0, 8)}`
  }
  return '未命名会话'
}

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(historyURL(), 'utf8'))
    taskHistory = data.platforms || {}
    dismissedTaskIDs = Array.isArray(data.dismissedTaskIDs) ? data.dismissedTaskIDs : []
  } catch {
    taskHistory = {}
    dismissedTaskIDs = []
  }
}

function persistHistory() {
  try {
    const dir = path.dirname(historyURL())
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(historyURL(), JSON.stringify({ platforms: taskHistory, dismissedTaskIDs }, null, 2) + '\n')
  } catch (err) {
    console.error('[allpet] 保存任务历史失败:', err && err.message || err)
  }
}

// 从快照累积任务历史（按 canonicalID 去重更新，每平台最多 12 条，done/failed 终态保留）。
function accumulateHistory(snap) {
  let changed = false
  for (const p of snap.platforms || []) {
    if (p.phase === 'idle') continue
    const t = p.task
    if (!t || !(t.sessionID || t.scheduledTaskName)) continue
    const item = {
      id: canonicalID(p.platform, t),
      platform: p.platform,
      title: (t.title || '').trim() || (t.action || p.detail || ''),
      sessionName: t.sessionName,
      action: t.action || p.detail || '',
      phase: p.phase,
      progress: t.progressLabel,
      updatedAt: (Date.now() - APPLE_REF_MS) / 1000,
      sessionID: t.sessionID,
      workingDirectory: t.workingDirectory,
      scheduledTaskName: t.scheduledTaskName
    }
    // 复活：非终态任务出现新活动时移除 dismiss 标记（对齐 macOS）。
    if (item.phase !== 'done' && item.phase !== 'failed') {
      const di = dismissedTaskIDs.indexOf(item.id)
      if (di >= 0) { dismissedTaskIDs.splice(di, 1); changed = true }
    }
    // done/failed 且已 dismiss：不再显示、不再入历史。
    if ((item.phase === 'done' || item.phase === 'failed') && dismissedTaskIDs.includes(item.id)) {
      continue
    }
    let list = taskHistory[p.platform] || []
    const idx = list.findIndex(x => x.id === item.id)
    if (idx >= 0) {
      if (!(list[idx].phase === 'done' && item.phase === 'idle')) {
        // 保留原条目的扩展字段（macOS 写入的 sourcePath/launchOrigin/terminal 等），避免共享文件时丢失。
        const merged = Object.assign({}, list[idx], item)
        list[idx] = merged
        changed = true
      }
    } else {
      list.push(item)
      changed = true
    }
    const seen = new Set()
    list = list.filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)))
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    if (list.length > 12) list = list.slice(0, 12)
    taskHistory[p.platform] = list
  }
  if (changed) persistHistory()
}

function historyPayload() {
  // 只把展示所需的字段交给渲染层，附加 sessionDisplayName。
  const platforms = {}
  for (const [key, list] of Object.entries(taskHistory)) {
    platforms[key] = (list || []).map(item => ({
      id: item.id,
      platform: item.platform,
      sessionName: item.sessionName,
      action: item.action,
      phase: item.phase,
      phaseLabel: phaseLabelOf(item.phase),
      scheduledTaskName: item.scheduledTaskName,
      sessionID: item.sessionID,
      sessionDisplayName: sessionDisplayName(item)
    }))
  }
  return { platforms, dismissed: dismissedTaskIDs }
}

function phaseLabelOf(phase) {
  const labels = { idle: '空闲', running: '运行中', thinking: '思考中', waiting: '等待中', done: '完成', failed: '出错' }
  return labels[phase] || phase
}

function spritesheetDataUrl(filePath) {
  const buf = fs.readFileSync(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const mime = ext === '.webp' ? 'image/webp'
    : ext === '.png' ? 'image/png'
    : ext === '.gif' ? 'image/gif'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : 'application/octet-stream'
  return `data:${mime};base64,${buf.toString('base64')}`
}

// 同步跑一次 allpet CLI 子命令，返回 { code, out, err }。
function runAllpet(args) {
  return new Promise((resolve, reject) => {
    const bin = allpetBinary()
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', c => { out += c.toString('utf8') })
    child.stderr.on('data', c => { err += c.toString('utf8') })
    child.on('error', reject)
    child.on('exit', code => resolve({ code, out, err }))
  })
}

function refreshPet() {
  pushPet()
  if (petManagerWindow && !petManagerWindow.isDestroyed()) {
    petManagerWindow.webContents.send('pets-changed')
  }
}

// ---- 窗口 ----

function createWindow() {
  const { width, height } = windowSizeForScale(readScale())
  mainWindow = new BrowserWindow({
    width,
    height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin' || process.platform === 'linux') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer.html'))
  positionWindow()

  // 首次就绪后，把宠物素材 + 当前快照推给渲染层。
  mainWindow.webContents.on('did-finish-load', () => {
    pushPet()
    if (currentSnapshot) sendSnapshot(currentSnapshot)
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

function pushPet() {
  pet = readCurrentPet()
  const scale = readScale()
  const payload = pet
    ? {
        ok: true,
        id: pet.manifestId,
        name: pet.displayName,
        spritesheet: spritesheetDataUrl(pet.spritesheetPath),
        scale
      }
    : { ok: false, scale }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet', payload)
  }
}

// 相对调整宠物大小，写回 config.json 并同步主窗口与渲染层。
function applyScale(delta) {
  const current = readScale()
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current + delta))
  if (Math.abs(next - current) < 0.0001) return next
  try {
    const cfgPath = configPath()
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg.pet = cfg.pet || {}
    cfg.pet.scale = next
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
  } catch (err) {
    console.error('[allpet] 保存 scale 失败:', err && err.message || err)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    const size = windowSizeForScale(next)
    mainWindow.setSize(size.width, size.height)
    positionWindow()
  }
  pushPet()
  return next
}

function sendSnapshot(snap) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('snapshot', { ...snap, history: historyPayload() })
  }
}

// ---- 监控子进程 ----

function startWatch() {
  const bin = allpetBinary()
  console.log('[allpet] 启动监控:', bin, 'watch --json')
  watchProc = spawn(bin, ['watch', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let buf = ''
  watchProc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        onSnapshot(JSON.parse(line))
      } catch { /* 忽略坏行 */ }
    }
  })
  watchProc.stderr.on('data', () => {})
  watchProc.on('error', (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('watch-error', String(err && err.message || err))
    }
  })
  watchProc.on('exit', (code) => {
    watchProc = null
    // 简单自动重启（延迟 2s），保持监控不中断。
    if (!app.isQuitting) setTimeout(startWatch, 2000)
  })
}

let firstSnapshotLogged = false
function onSnapshot(snap) {
  if (!firstSnapshotLogged) {
    firstSnapshotLogged = true
    console.log('[allpet] 收到首个快照:', snap.summary, '| 动画:', snap.animation)
  }
  currentSnapshot = snap
  accumulateHistory(snap)
  sendSnapshot(snap)
  updateTrayMenu()
}

// ---- 唤起（跨平台尽力实现）----

function launchPlatform(platform) {
  const p = process.platform
  const commands = {
    codex: { darwin: ['open', ['-a', 'Codex']], win32: ['codex', []], linux: ['codex', []] },
    claude: { darwin: ['open', ['-a', 'Claude']], win32: ['claude', []], linux: ['claude', []] },
    grok: { darwin: ['open', ['-a', 'grok']], win32: ['grok', []], linux: ['grok', []] },
    dsh: { darwin: ['open', ['http://127.0.0.1:3080']], win32: ['start', ['http://127.0.0.1:3080']], linux: ['xdg-open', ['http://127.0.0.1:3080']] }
  }
  const c = commands[platform]
  if (!c) return
  const key = p === 'darwin' ? 'darwin' : p === 'win32' ? 'win32' : 'linux'
  const [cmd, args] = c[key] || []
  if (!cmd) return
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (err) {
    console.error('launchPlatform failed', err)
  }
}

// ---- 宠物管理 ----

function createPetManagerWindow() {
  if (petManagerWindow && !petManagerWindow.isDestroyed()) {
    petManagerWindow.show()
    petManagerWindow.focus()
    return
  }
  petManagerWindow = new BrowserWindow({
    width: 440,
    height: 600,
    title: 'AllPet 宠物管理',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  petManagerWindow.loadFile(path.join(__dirname, 'src', 'pets.html'))
  petManagerWindow.on('closed', () => { petManagerWindow = null })
}

function registerPetIpc() {
  ipcMain.handle('pets:list', async () => {
    const { code, out } = await runAllpet(['pet', 'list', '--json'])
    if (code !== 0) return { ok: false, error: out || 'list failed' }
    try {
      const data = JSON.parse(out)
      const pets = (data.pets || []).map(p => {
        let spritesheet = null
        try { spritesheet = spritesheetDataUrl(p.spritesheetPath) } catch { /* 忽略 */ }
        return {
          id: p.id,
          displayName: p.displayName,
          description: p.description,
          current: !!p.current,
          builtin: !!p.builtin,
          cellWidth: p.cellWidth,
          cellHeight: p.cellHeight,
          spritesheet
        }
      })
      return { ok: true, pets, defaults: data.defaults || [] }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) }
    }
  })

  ipcMain.handle('pets:set', async (_e, id) => {
    const { code, out } = await runAllpet(['pet', 'set', id])
    if (code !== 0) return { ok: false, error: out || 'set failed' }
    refreshPet()
    return { ok: true }
  })

  ipcMain.handle('pets:delete', async (_e, id) => {
    const { code, out } = await runAllpet(['pet', 'delete', id])
    if (code !== 0) return { ok: false, error: out || 'delete failed' }
    refreshPet()
    return { ok: true }
  })

  ipcMain.handle('pets:import', async () => {
    const result = await dialog.showOpenDialog(petManagerWindow || undefined, {
      title: '导入本地宠物',
      properties: ['openFile', 'openDirectory']
    })
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }
    const { code, out } = await runAllpet(['pet', 'import', result.filePaths[0]])
    if (code !== 0) return { ok: false, error: out || 'import failed' }
    refreshPet()
    return { ok: true }
  })

  ipcMain.handle('pets:install', async (_e, source) => {
    const source2 = String(source || '').trim()
    if (!source2) return { ok: false, error: '请输入安装来源' }
    const { code, out } = await runAllpet(['pet', 'install', source2])
    if (code !== 0) return { ok: false, error: out || 'install failed' }
    refreshPet()
    return { ok: true }
  })

  ipcMain.handle('pets:getScale', async () => ({ ok: true, scale: readScale() }))

  ipcMain.handle('pets:setScale', async (_e, delta) => {
    const scale = applyScale(Number(delta) || 0)
    return { ok: true, scale }
  })

  ipcMain.handle('pets:resizeBubble', async (_e, height) => {
    const h = Math.max(0, Math.round(Number(height) || 0))
    if (h === bubbleHeight) return { ok: true }
    bubbleHeight = h
    if (mainWindow && !mainWindow.isDestroyed()) {
      const size = windowSizeForScale(readScale())
      mainWindow.setSize(size.width, size.height)
      positionWindow()
    }
    return { ok: true }
  })

  ipcMain.handle('pets:launchPlatform', async (_e, platform) => {
    launchPlatform(String(platform || ''))
    return { ok: true }
  })

  ipcMain.handle('pets:dismissTask', async (_e, id) => {
    const taskId = String(id || '')
    const platform = taskId.split('|')[0]
    if (platform && taskHistory[platform]) {
      taskHistory[platform] = taskHistory[platform].filter(t => t.id !== taskId)
    }
    if (taskId && !dismissedTaskIDs.includes(taskId)) dismissedTaskIDs.push(taskId)
    if (dismissedTaskIDs.length > 100) dismissedTaskIDs = dismissedTaskIDs.slice(-100)
    persistHistory()
    if (currentSnapshot) sendSnapshot(currentSnapshot)
    return { ok: true }
  })

  ipcMain.handle('pets:dismissPlatform', async (_e, platform) => {
    const key = String(platform || '')
    if (key && taskHistory[key]) {
      for (const t of taskHistory[key]) {
        if (!dismissedTaskIDs.includes(t.id)) dismissedTaskIDs.push(t.id)
      }
      taskHistory[key] = []
    }
    if (dismissedTaskIDs.length > 100) dismissedTaskIDs = dismissedTaskIDs.slice(-100)
    persistHistory()
    if (currentSnapshot) sendSnapshot(currentSnapshot)
    return { ok: true }
  })

  ipcMain.handle('pets:dragStart', async (_e, x, y) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      dragStartScreen = { x: Number(x), y: Number(y) }
      dragStartPosition = mainWindow.getPosition()
    }
    return { ok: true }
  })

  ipcMain.handle('pets:dragMove', async (_e, x, y) => {
    if (mainWindow && !mainWindow.isDestroyed() && dragStartScreen && dragStartPosition) {
      const dx = Number(x) - dragStartScreen.x
      const dy = Number(y) - dragStartScreen.y
      mainWindow.setPosition(dragStartPosition[0] + Math.round(dx), dragStartPosition[1] + Math.round(dy))
    }
    return { ok: true }
  })

  ipcMain.handle('pets:dragEnd', async () => {
    dragStartScreen = null
    dragStartPosition = null
    return { ok: true }
  })
}

// ---- 托盘 ----

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png')
  let icon
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath)
    if (process.platform === 'darwin') icon = icon.resize({ width: 18, height: 18 })
  } else {
    icon = nativeImage.createEmpty()
  }
  tray = new Tray(icon)
  tray.setToolTip('AllPet')
  updateTrayMenu()
}

function updateTrayMenu() {
  if (!tray) return
  const s = currentSnapshot
  const template = []
  if (s) {
    template.push({ label: `🐾 ${s.summary}`, enabled: false })
    template.push({ type: 'separator' })
    for (const p of s.platforms) {
      template.push({
        label: `${p.phaseLabel === '空闲' ? '·' : '●'} ${p.label} — ${p.phaseLabel}`,
        submenu: [
          { label: p.bubbleHeader, enabled: false },
          ...(p.bubbleDetails || []).map(d => ({ label: d, enabled: false })),
          { type: 'separator' },
          { label: '打开平台', click: () => launchPlatform(p.platform) }
        ]
      })
    }
    template.push({ type: 'separator' })
  }
  if (pet) template.push({ label: `当前宠物：${pet.displayName}`, enabled: false })
  template.push({ label: '增大宠物 5%', click: () => applyScale(0.05) })
  template.push({ label: '减小宠物 5%', click: () => applyScale(-0.05) })
  template.push({ label: '宠物管理…', click: () => createPetManagerWindow() })
  template.push({ label: '刷新宠物', click: () => pushPet() })
  template.push({ type: 'separator' })
  template.push({ label: '退出 AllPet', click: () => quit() })
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function quit() {
  app.isQuitting = true
  if (watchProc) { try { watchProc.kill() } catch {} }
  app.quit()
}

// ---- 应用生命周期 ----

app.whenReady().then(() => {
  app.isQuitting = false
  loadHistory()
  registerPetIpc()
  createWindow()
  createTray()
  startWatch()

  // 调试：ALLPET_SCREENSHOT=/path.png 时，启动 5s 后截图退出（用于无头验证渲染）。
  if (process.env.ALLPET_SCREENSHOT) {
    const target = process.env.ALLPET_SCREENSHOT
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.capturePage().then((img) => {
          fs.writeFileSync(target, img.toPNG())
          console.log('[allpet] 截图已保存:', target)
        }).catch((e) => console.error('[allpet] 截图失败:', e)).finally(() => quit())
      } else {
        quit()
      }
    }, 5000)
  }

  // 调试：ALLPET_PET_MANAGER_SCREENSHOT=/path.png 时，打开宠物管理窗口并截图退出。
  if (process.env.ALLPET_PET_MANAGER_SCREENSHOT) {
    const target = process.env.ALLPET_PET_MANAGER_SCREENSHOT
    setTimeout(() => {
      createPetManagerWindow()
      setTimeout(() => {
        if (petManagerWindow && !petManagerWindow.isDestroyed()) {
          petManagerWindow.webContents.capturePage().then((img) => {
            fs.writeFileSync(target, img.toPNG())
            console.log('[allpet] 宠物管理截图已保存:', target)
          }).catch((e) => console.error('[allpet] 宠物管理截图失败:', e)).finally(() => quit())
        } else {
          quit()
        }
      }, 4000)
    }, 1500)
  }
})

app.on('window-all-closed', () => {
  // 桌宠应常驻：关窗即退出（托盘仍可保留，但 MVP 简化）。
  quit()
})
