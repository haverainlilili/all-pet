// AllPet 跨平台桌宠（Electron 主进程）
// 复用 Swift AllPetCore：以子进程跑 `allpet watch --json`，把 NDJSON 快照转发给渲染层。
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog, screen } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { pathToFileURL } = require('url')
const {
  failedExternalWakePlan, isTrustedMainFrame, pickLaunchCandidate, platformLabel,
  platformLaunchSpec, rendererSnapshot, runCommandLauncher, wakePlanForTask
} = require('./src/wake')
const {
  attachRestartOnClose, chooseCurrentPet, createOperationGate, expandHomePath, finishMutationRefresh, petCapabilities, petMutationTarget,
  preservedWindowBounds, spriteSizeForPet
} = require('./src/pet-state')
const {
  APPLE_REF_MS, accumulateTaskHistory, canonicalID, dismissPlatformHistory, dismissTaskHistory, sessionDisplayName
} = require('./src/task-history')
const { platformMenuTitles, scalePercentText, petTrayRows } = require('./src/tray-menu')

const MAIN_RENDERER_URL = pathToFileURL(path.join(__dirname, 'src', 'renderer.html')).href
const PET_MANAGER_URL = pathToFileURL(path.join(__dirname, 'src', 'pets.html')).href

// CI / 无头环境：禁用沙箱与 GPU，便于 xvfb 下冒烟测试。
if (process.env.ALLPET_NO_SANDBOX) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

let mainWindow = null
let petManagerWindow = null
let tray = null
let watchProc = null
let watchRestartTimer = null
let petRefreshRetryTimer = null
let lifecycleCleaned = false
let currentSnapshot = null
let pet = null // { bundlePath, spritesheetPath, manifestId, displayName, atlas geometry }
let petCatalog = []
let petCatalogDefaults = []
let petStateEpoch = 0
let petOperationState = { busy: false, label: null }
const petOperationGate = createOperationGate((state) => {
  const mutationFinished = petOperationState.busy && !state.busy
  if (state.busy) petStateEpoch += 1
  petOperationState = state
  if (petManagerWindow && !petManagerWindow.isDestroyed()) {
    petManagerWindow.webContents.send('pet-operation', state)
    if (mutationFinished) petManagerWindow.webContents.send('pets-changed')
  }
  updateTrayMenu()
})

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
    const bundlePath = expandHomePath(cfg && cfg.pet && cfg.pet.bundlePath, os.homedir())
    if (!bundlePath || !fs.existsSync(path.join(bundlePath, 'pet.json'))) return null
    const manifest = JSON.parse(fs.readFileSync(path.join(bundlePath, 'pet.json'), 'utf8'))
    const sp = manifest.spritesheetPath || 'spritesheet.webp'
    const normalizedPath = path.resolve(bundlePath)
    const metadata = petCatalog.find(item => item && item.directoryPath && path.resolve(item.directoryPath) === normalizedPath)
    if (!metadata || !(metadata.columns > 0) || !(metadata.rows > 0) || !(metadata.cellWidth > 0) || !(metadata.cellHeight > 0)) {
      return null
    }
    return {
      bundlePath,
      spritesheetPath: path.join(bundlePath, sp),
      manifestId: manifest.id || path.basename(bundlePath),
      displayName: manifest.displayName || manifest.id || 'Pet',
      columns: metadata.columns,
      rows: metadata.rows,
      cellWidth: metadata.cellWidth,
      cellHeight: metadata.cellHeight
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

function readPetEnabled() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    return !cfg.pet || cfg.pet.enabled !== false
  } catch {
    return true
  }
}

function readScale() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    const s = cfg && cfg.pet && typeof cfg.pet.scale === 'number' ? cfg.pet.scale : DEFAULT_SCALE
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
  } catch {
    return DEFAULT_SCALE
  }
}

// 当前气泡尺寸（0 = 隐藏）；渲染层实时上报。AppKit 的任务托盘位于宠物上方。
let bubbleWidth = 0
let bubbleHeight = 0

// 精灵按 scale 缩放；显示宽 clamp 80…224px（与 macOS layoutMetrics 一致）。
// 三阶段气泡宽度由渲染层按 AppKit 304/324/334px 实时上报。
function spriteSizeForScale(scale, targetPet = pet) {
  return spriteSizeForPet(targetPet, scale)
}

function windowSizeForScale(scale, targetPet = pet) {
  const sprite = spriteSizeForScale(scale, targetPet)
  return {
    width: Math.max(sprite.width, bubbleWidth),
    height: sprite.height + (bubbleHeight > 0 ? bubbleHeight + 6 : 0)
  }
}

// 气泡、scale 或图集变化时，保持宠物本体左下角在屏幕上的位置不跳动。
function resizeWindowPreservingSprite(nextScale, previousScale = nextScale, nextPet = pet, previousPet = nextPet) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const oldBounds = mainWindow.getBounds()
  const oldSprite = spriteSizeForScale(previousScale, previousPet)
  const nextSprite = spriteSizeForScale(nextScale, nextPet)
  const nextWindow = windowSizeForScale(nextScale, nextPet)
  const bounds = preservedWindowBounds({
    oldBounds, oldSprite, nextSprite, nextWindow,
    workArea: screen.getDisplayMatching(oldBounds).workArea,
    margin: 20
  })
  mainWindow.setBounds(bounds, false)
}

function readAnchor() {
  const debugAnchor = process.env.ALLPET_SCREENSHOT_ANCHOR
  if (['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(debugAnchor)) return debugAnchor
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
  // AppKit 初始隐藏托盘时仍按 304×72pt 预留位置，避免首次展开向屏幕外生长。
  const reservedWidth = bubbleWidth > 0 ? size[0] : Math.max(size[0], 304)
  const fullX = isLeft ? area.x + margin : area.x + area.width - reservedWidth - margin
  const x = bubbleWidth > 0 ? fullX : fullX + (reservedWidth - size[0]) / 2
  // Electron 屏幕坐标原点在左上；隐藏托盘的 top anchor 需为上方托盘预留 72+6px。
  const y = isTop
    ? area.y + margin + (bubbleHeight > 0 ? 0 : 78)
    : area.y + area.height - size[1] - margin
  mainWindow.setPosition(Math.round(x), Math.round(y))
}

// ---- 任务历史（与 macOS 共享 ~/.config/all-pet/task-history.json）----

let taskHistory = {}      // { [platform]: [item] }
let dismissedTaskIDs = []
let manuallyHiddenTaskTitles = {} // 非终态手动隐藏：同一标题保持隐藏，标题变化后视为新活动
let dragStartScreen = null  // 精灵拖动起点（屏幕坐标）
let dragStartPosition = null // 拖动开始时窗口位置

function historyURL() {
  return path.join(os.homedir(), '.config', 'all-pet', 'task-history.json')
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

// 从快照累积任务历史。纯 reducer 由三平台 Node 测试覆盖，主进程只负责持久化。
function mutableHistoryState() {
  return { platforms: taskHistory, dismissed: dismissedTaskIDs, hidden: manuallyHiddenTaskTitles }
}

function adoptHistoryState(state) {
  taskHistory = state.platforms
  dismissedTaskIDs = state.dismissed
  manuallyHiddenTaskTitles = state.hidden
}

function accumulateHistory(snap) {
  const state = mutableHistoryState()
  const changed = accumulateTaskHistory(state, snap, Date.now())
  adoptHistoryState(state)
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
      progress: item.progress,
      phase: item.phase,
      phaseLabel: phaseLabelOf(item.phase),
      scheduledTaskName: item.scheduledTaskName,
      sessionID: item.sessionID,
      updatedAt: item.updatedAt,
      sessionDisplayName: sessionDisplayName(item)
    }))
  }
  return { platforms, dismissed: dismissedTaskIDs, hidden: Object.keys(manuallyHiddenTaskTitles) }
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

async function readPetCatalog() {
  const epoch = petStateEpoch
  const result = await runAllpet(['pet', 'list', '--json'])
  if (result.code !== 0) throw new Error(result.err.trim() || result.out.trim() || `pet list exited ${result.code}`)
  const data = JSON.parse(result.out.trim())
  const pets = Array.isArray(data.pets) ? data.pets : []
  const defaults = Array.isArray(data.defaults) ? data.defaults : []
  // 变更开始前发出的旧 list 不得覆盖变更事务刷新出的目录。
  if (epoch === petStateEpoch) {
    petCatalog = pets
    petCatalogDefaults = defaults
  }
  return { pets, defaults, stale: epoch !== petStateEpoch }
}

async function ensureCurrentPetSelection() {
  let catalog = await readPetCatalog()
  const selected = chooseCurrentPet(catalog.pets)
  if (selected && !selected.current) {
    const result = await runAllpet(['pet', 'set', selected.id])
    if (result.code !== 0) throw new Error(result.err.trim() || result.out.trim() || `pet set exited ${result.code}`)
    catalog = await readPetCatalog()
  }
  return catalog
}

async function refreshDesktopState(options = {}) {
  if (petOperationGate.active && !options.fromMutation) {
    return { ok: false, busy: true, error: `正在${petOperationGate.active}，请稍候。` }
  }
  const previousPet = pet
  const scale = readScale()
  const refreshEpoch = petStateEpoch
  await readPetCatalog()
  if (!options.fromMutation && refreshEpoch !== petStateEpoch) {
    return { ok: false, stale: true, error: '宠物状态已由更新的事务刷新。' }
  }
  pet = readCurrentPet()
  if (mainWindow && !mainWindow.isDestroyed()) {
    resizeWindowPreservingSprite(scale, scale, pet, previousPet)
  }
  pushPet()
  updateTrayMenu()
  if (options.notifyManager !== false && petManagerWindow && !petManagerWindow.isDestroyed()) {
    petManagerWindow.webContents.send('pets-changed')
  }
  return { ok: true }
}

function schedulePetRefreshRetry(attempt = 1) {
  if (app.isQuitting || petRefreshRetryTimer || attempt > 5) return
  petRefreshRetryTimer = setTimeout(async () => {
    petRefreshRetryTimer = null
    if (app.isQuitting) return
    if (petOperationGate.active) { schedulePetRefreshRetry(attempt); return }
    try {
      await refreshDesktopState()
      console.log('[allpet] 宠物状态重试刷新成功')
    } catch (err) {
      console.error(`[allpet] 宠物状态第 ${attempt} 次重试刷新失败:`, err && err.message || err)
      schedulePetRefreshRetry(attempt + 1)
    }
  }, Math.min(8000, 1000 * attempt))
}

async function finishPetMutation(label, message) {
  return finishMutationRefresh({
    label, message,
    refresh: () => refreshDesktopState({ fromMutation: true, notifyManager: false }),
    scheduleRetry: () => schedulePetRefreshRetry()
  })
}

// ---- 窗口 ----

function createWindow(options = {}) {
  const { width, height } = windowSizeForScale(readScale())
  mainWindow = new BrowserWindow({
    width,
    height,
    show: options.show !== false,
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
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== MAIN_RENDERER_URL) {
      event.preventDefault()
      console.error('[allpet] blocked unexpected main-window navigation:', url)
    }
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer.html'))
  positionWindow()

  // 首次就绪后，把宠物素材 + 当前快照推给渲染层。
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow.webContents.getURL() !== MAIN_RENDERER_URL) return
    pushPet()
    if (currentSnapshot) sendSnapshot(currentSnapshot)
  })

  mainWindow.on('blur', () => {
    // 确定性截图必须保持指定阶段；正常运行时失焦收起到 Stage 1。
    if (!process.env.ALLPET_SCREENSHOT_STAGE && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('collapse-bubble')
    }
  })
  mainWindow.on('closed', () => { mainWindow = null; updateTrayMenu() })
}

function pushPet() {
  const scale = readScale()
  let payload
  try {
    payload = pet
      ? {
          ok: true,
          id: pet.manifestId,
          name: pet.displayName,
          spritesheet: spritesheetDataUrl(pet.spritesheetPath),
          columns: pet.columns,
          rows: pet.rows,
          cellWidth: pet.cellWidth,
          cellHeight: pet.cellHeight,
          scale
        }
      : { ok: false, scale }
  } catch (err) {
    console.error('[allpet] 读取宠物素材失败:', err && err.message || err)
    payload = { ok: false, scale }
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pet', payload)
}

// 相对调整宠物大小，写回 config.json，并保持拖动后的宠物左下角不跳动。
function applyScale(delta) {
  const current = readScale()
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current + delta))
  if (Math.abs(next - current) < 0.0001) return next
  try {
    const cfgPath = configPath()
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}
    cfg.pet = cfg.pet || { enabled: true, anchor: 'bottom-right' }
    cfg.pet.scale = next
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
  } catch (err) {
    console.error('[allpet] 保存 scale 失败:', err && err.message || err)
  }
  resizeWindowPreservingSprite(next, current, pet, pet)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pet-scale', next)
  if (petManagerWindow && !petManagerWindow.isDestroyed()) petManagerWindow.webContents.send('pet-scale', next)
  updateTrayMenu()
  return next
}

function sendSnapshot(snap) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('snapshot', { ...rendererSnapshot(snap), history: historyPayload() })
  }
}

// ---- 监控子进程 ----

function startWatch() {
  if (app.isQuitting || watchProc) return
  if (watchRestartTimer) { clearTimeout(watchRestartTimer); watchRestartTimer = null }
  const bin = allpetBinary()
  console.log('[allpet] 启动监控:', bin, 'watch --json')
  watchProc = spawn(bin, ['watch', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const thisWatch = watchProc
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
  attachRestartOnClose(thisWatch, {
    onError(err) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('watch-error', String(err && err.message || err))
      }
    },
    isCurrent: () => watchProc === thisWatch,
    clearCurrent: () => { watchProc = null },
    shouldRestart: () => !app.isQuitting && !watchRestartTimer,
    scheduleRestart: () => { watchRestartTimer = setTimeout(startWatch, 2000) }
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

function executableOnPath(command) {
  const entries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  return entries.some(entry => {
    try {
      fs.accessSync(path.join(entry, command), fs.constants.X_OK)
      return true
    } catch (_) {
      return false
    }
  })
}

async function launchPlatform(platform) {
  let spec = platformLaunchSpec(platform, process.platform)
  if (!spec) {
    return { succeeded: false, requested: false, exact: false, openedApp: false, message: `不支持打开 ${platformLabel(platform)}` }
  }
  if (spec.kind === 'external') {
    try {
      await shell.openExternal(spec.url)
      return {
        succeeded: true, requested: true, exact: false, openedApp: false,
        message: '系统已接受打开请求，但 Electron 无法验证目标页面是否已显示。'
      }
    } catch (err) {
      const message = String(err && err.message || err)
      console.error('[allpet] openExternal failed:', message)
      return { succeeded: false, requested: false, exact: false, openedApp: false, message }
    }
  }
  if (spec.kind === 'commandCandidates') {
    spec = pickLaunchCandidate(spec.candidates, executableOnPath)
    if (!spec) {
      return {
        succeeded: false, requested: false, exact: false, openedApp: false,
        message: '未找到受支持的可见终端（x-terminal-emulator/gnome-terminal/konsole/xfce4-terminal/xterm）。'
      }
    }
  }
  const result = await runCommandLauncher(spawn, spec.command, spec.args)
  if (!result.succeeded) console.error('[allpet] launchPlatform failed:', result.message)
  return result
}

async function showLaunchFailure(platform, result) {
  const options = {
    type: 'warning',
    title: `无法打开 ${platformLabel(platform)}`,
    message: '启动请求失败',
    detail: result.message || '没有找到可用的应用或终端启动器。',
    buttons: ['知道了']
  }
  if (mainWindow && !mainWindow.isDestroyed()) await dialog.showMessageBox(mainWindow, options)
  else await dialog.showMessageBox(options)
}

function taskByID(taskID) {
  for (const tasks of Object.values(taskHistory)) {
    const task = (tasks || []).find(item => item.id === taskID)
    if (task) return task
  }
  return null
}

async function presentWakeFallback(plan, task) {
  const canOpen = plan.canOpenPlatform && task && task.platform
  const options = {
    type: 'warning',
    title: `无法精确唤起${task ? platformLabel(task.platform) : '任务'}`,
    message: task ? `未定位到「${sessionDisplayName(task)}」` : '任务记录已不存在',
    detail: plan.message || '没有找到对应任务界面；任务卡片已保留。',
    buttons: canOpen ? ['取消', '只打开平台'] : ['知道了'],
    cancelId: 0,
    defaultId: 0,
    noLink: true
  }
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  if (canOpen && result.response === 1) {
    const opened = await launchPlatform(task.platform)
    if (!opened.succeeded) await showLaunchFailure(task.platform, opened)
    return { ...opened, exact: false, message: opened.succeeded ? plan.message : opened.message }
  }
  return { succeeded: false, exact: false, openedApp: false, message: plan.message }
}

async function wakeTask(taskID) {
  const task = taskByID(taskID)
  const plan = wakePlanForTask(task)
  if (plan.kind !== 'external') return presentWakeFallback(plan, task)

  try {
    await shell.openExternal(plan.url)
    return {
      succeeded: true,
      requested: true,
      exact: false,
      openedApp: false,
      message: '已将原会话深链交给系统；Electron 无法验证目标会话是否已显示，因此任务卡片会继续保留。'
    }
  } catch (err) {
    return presentWakeFallback(
      failedExternalWakePlan(task, String(err && err.message || err)),
      task
    )
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
  petManagerWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== PET_MANAGER_URL) {
      event.preventDefault()
      console.error('[allpet] blocked unexpected pet-manager navigation:', url)
    }
  })
  petManagerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  petManagerWindow.webContents.on('did-finish-load', () => {
    if (petManagerWindow && petManagerWindow.webContents.getURL() === PET_MANAGER_URL) {
      petManagerWindow.webContents.send('pet-operation', petOperationState)
    }
  })
  petManagerWindow.loadFile(path.join(__dirname, 'src', 'pets.html'))
  petManagerWindow.on('closed', () => { petManagerWindow = null })
}

function requireMainFrame(event) {
  if (!isTrustedMainFrame(event, mainWindow, MAIN_RENDERER_URL)) throw new Error('untrusted main-window IPC source')
}

function requirePetManagerFrame(event) {
  if (!isTrustedMainFrame(event, petManagerWindow, PET_MANAGER_URL)) throw new Error('untrusted pet-manager IPC source')
}

async function executePetCommand(label, args) {
  return petOperationGate.run(label, async () => {
    const result = await runAllpet(args)
    if (result.code !== 0) {
      return { ok: false, error: result.err.trim() || result.out.trim() || `${args.join(' ')} exited ${result.code}` }
    }
    return finishPetMutation(label, result.out.trim())
  })
}

function managerPetPayload(catalog) {
  const pets = (catalog.pets || []).map(item => {
    let spritesheet = null
    try { spritesheet = spritesheetDataUrl(item.spritesheetPath) } catch { /* 单个缩略图失败不影响列表 */ }
    return {
      id: item.id,
      displayName: item.displayName,
      description: item.description,
      current: !!item.current,
      builtin: !!item.builtin,
      columns: item.columns,
      rows: item.rows,
      cellWidth: item.cellWidth,
      cellHeight: item.cellHeight,
      target: petMutationTarget(item),
      spritesheet
    }
  })
  return {
    ok: true, pets, defaults: catalog.defaults || [],
    capabilities: petCapabilities(process.platform),
    operation: petOperationState
  }
}

function registerPetIpc() {
  ipcMain.handle('pets:list', async (event) => {
    requirePetManagerFrame(event)
    if (petOperationGate.active) {
      return managerPetPayload({ pets: petCatalog, defaults: petCatalogDefaults })
    }
    try { return managerPetPayload(await readPetCatalog()) }
    catch (err) { return { ok: false, error: String(err && err.message || err) } }
  })

  ipcMain.handle('pets:set', async (event, id) => {
    requirePetManagerFrame(event)
    return executePetCommand('切换宠物', ['pet', 'set', String(id || '')])
  })

  ipcMain.handle('pets:delete', async (event, id) => {
    requirePetManagerFrame(event)
    return executePetCommand('删除宠物', ['pet', 'delete', String(id || '')])
  })

  ipcMain.handle('pets:import', async (event) => {
    requirePetManagerFrame(event)
    const capabilities = petCapabilities(process.platform)
    if (!capabilities.importLocal) {
      return { ok: false, unsupported: true, error: capabilities.importLocalReason }
    }
    return petOperationGate.run('导入宠物', async () => {
      const dialogOptions = { title: '导入本地宠物', properties: ['openFile', 'openDirectory'] }
      const selected = petManagerWindow && !petManagerWindow.isDestroyed()
        ? await dialog.showOpenDialog(petManagerWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      if (selected.canceled || !selected.filePaths.length) return { ok: false, canceled: true }
      const result = await runAllpet(['pet', 'import', selected.filePaths[0]])
      if (result.code !== 0) return { ok: false, error: result.err.trim() || result.out.trim() || '导入失败' }
      return finishPetMutation('导入宠物', result.out.trim())
    })
  })

  ipcMain.handle('pets:install', async (event, source) => {
    requirePetManagerFrame(event)
    const value = String(source || '').trim()
    if (!value) return { ok: false, error: '请输入安装来源' }
    return executePetCommand('安装宠物', ['pet', 'install', value])
  })

  ipcMain.handle('pets:getScale', async (event) => {
    requirePetManagerFrame(event)
    return { ok: true, scale: readScale() }
  })

  ipcMain.handle('pets:setScale', async (event, delta) => {
    requirePetManagerFrame(event)
    const scale = applyScale(Number(delta) || 0)
    return { ok: true, scale }
  })

  ipcMain.handle('pets:resizeBubble', async (event, width, height) => {
    requireMainFrame(event)
    const w = Math.max(0, Math.round(Number(width) || 0))
    const h = Math.max(0, Math.round(Number(height) || 0))
    if (w === bubbleWidth && h === bubbleHeight) return { ok: true }
    bubbleWidth = w
    bubbleHeight = h
    resizeWindowPreservingSprite(readScale())
    return { ok: true }
  })

  ipcMain.handle('pets:launchPlatform', async (event, platform) => {
    requireMainFrame(event)
    const name = String(platform || '')
    const result = await launchPlatform(name)
    if (!result.succeeded) await showLaunchFailure(name, result)
    return result
  })

  ipcMain.handle('pets:wakeTask', async (event, id) => {
    requireMainFrame(event)
    return wakeTask(String(id || ''))
  })

  ipcMain.handle('pets:dismissTask', async (event, id) => {
    requireMainFrame(event)
    const state = mutableHistoryState()
    dismissTaskHistory(state, String(id || ''))
    adoptHistoryState(state)
    persistHistory()
    if (currentSnapshot) sendSnapshot(currentSnapshot)
    return { ok: true }
  })

  ipcMain.handle('pets:dismissPlatform', async (event, platform) => {
    requireMainFrame(event)
    const key = String(platform || '')
    const live = currentSnapshot && (currentSnapshot.platforms || []).find(item => item.platform === key)
    const state = mutableHistoryState()
    dismissPlatformHistory(state, key, live)
    adoptHistoryState(state)
    persistHistory()
    if (currentSnapshot) sendSnapshot(currentSnapshot)
    return { ok: true }
  })

  ipcMain.handle('pets:dragStart', async (event, x, y) => {
    requireMainFrame(event)
    if (mainWindow && !mainWindow.isDestroyed()) {
      dragStartScreen = { x: Number(x), y: Number(y) }
      dragStartPosition = mainWindow.getPosition()
    }
    return { ok: true }
  })

  ipcMain.handle('pets:dragMove', async (event, x, y) => {
    requireMainFrame(event)
    if (mainWindow && !mainWindow.isDestroyed() && dragStartScreen && dragStartPosition) {
      const dx = Number(x) - dragStartScreen.x
      const dy = Number(y) - dragStartScreen.y
      mainWindow.setPosition(dragStartPosition[0] + Math.round(dx), dragStartPosition[1] + Math.round(dy))
    }
    return { ok: true }
  })

  ipcMain.handle('pets:dragEnd', async (event) => {
    requireMainFrame(event)
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
  tray.on('click', togglePetVisibility)
  updateTrayMenu()
}

function showPet() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
  updateTrayMenu()
}

function hidePet() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
  updateTrayMenu()
}

function togglePetVisibility() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) hidePet()
  else showPet()
}

async function openConfig() {
  try {
    if (!fs.existsSync(configPath())) {
      const initialized = await runAllpet(['init'])
      if (initialized.code !== 0) throw new Error(initialized.err.trim() || initialized.out.trim() || '初始化配置失败')
    }
    const error = await shell.openPath(configPath())
    if (error) throw new Error(error)
  } catch (err) {
    await dialog.showMessageBox({
      type: 'warning', title: '无法打开配置', message: '打开 config.json 失败',
      detail: String(err && err.message || err), buttons: ['知道了']
    })
  }
}

async function runTrayPetCommand(label, args) {
  const result = await executePetCommand(label, args)
  if (result && result.ok) return
  await dialog.showMessageBox({
    type: result && result.changed ? 'warning' : 'error',
    title: result && result.changed ? `${label}已执行` : `${label}失败`,
    message: result && result.changed ? '宠物目录刷新失败，AllPet 将自动重试。' : `无法${label}`,
    detail: String(result && result.error || '未知错误'),
    buttons: ['知道了']
  })
}

function petTraySubmenu() {
  const busy = petOperationState.busy
  const rows = petTrayRows(petCatalog, petCatalogDefaults)
  const submenu = rows.installed.map(row => ({
    label: row.label, type: 'checkbox', checked: row.current,
    enabled: !busy && !row.current && Boolean(row.target),
    click: () => runTrayPetCommand('切换宠物', ['pet', 'set', row.target])
  }))
  if (!submenu.length) submenu.push({ label: '暂无已安装宠物', enabled: false })
  if (rows.pending.length) {
    submenu.push({ type: 'separator' })
    submenu.push({ label: '未安装的默认宠物', enabled: false })
    for (const row of rows.pending) {
      submenu.push({
        label: row.label, enabled: !busy,
        click: () => runTrayPetCommand('安装宠物', ['pet', 'install', row.source])
      })
    }
  }
  submenu.push({ type: 'separator' })
  submenu.push({ label: '宠物管理…', click: () => createPetManagerWindow() })
  submenu.push({
    label: '刷新宠物', enabled: !busy,
    click: async () => {
      try { await refreshDesktopState() }
      catch (err) {
        await dialog.showMessageBox({ type: 'warning', title: '刷新失败', message: '无法刷新宠物状态', detail: String(err && err.message || err), buttons: ['知道了'] })
      }
    }
  })
  submenu.push({ label: '格式：cc-haha · clawd-on-desk · LingChat', enabled: false })
  return submenu
}

function updateTrayMenu() {
  if (!tray) return
  const snapshot = currentSnapshot
  const visible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())
  const busy = petOperationState.busy
  const template = [
    { label: visible ? '隐藏宠物' : '显示宠物', click: togglePetVisibility },
    { label: `宠物大小：${scalePercentText(readScale())}`, enabled: false },
    { label: '减小宠物 5%', enabled: Boolean(pet) && !busy, click: () => applyScale(-0.05) },
    { label: '增大宠物 5%', enabled: Boolean(pet) && !busy, click: () => applyScale(0.05) },
    { label: '宠物', submenu: petTraySubmenu() },
    { type: 'separator' }
  ]
  for (const label of platformMenuTitles(snapshot && snapshot.platforms)) {
    template.push({ label, enabled: false })
  }
  template.push({ type: 'separator' })
  if (busy) template.push({ label: `正在${petOperationState.label}…`, enabled: false })
  template.push({ label: '打开配置', click: () => openConfig() })
  template.push({ label: '退出', click: () => quit() })
  tray.setToolTip(busy ? `AllPet · 正在${petOperationState.label}` : `AllPet · ${pet ? pet.displayName : '无宠物'}`)
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function cleanupLifecycle() {
  if (lifecycleCleaned) return
  lifecycleCleaned = true
  app.isQuitting = true
  if (watchRestartTimer) { clearTimeout(watchRestartTimer); watchRestartTimer = null }
  if (petRefreshRetryTimer) { clearTimeout(petRefreshRetryTimer); petRefreshRetryTimer = null }
  if (watchProc) {
    const child = watchProc
    watchProc = null
    try { child.kill() } catch {}
  }
}

function quit() {
  cleanupLifecycle()
  app.quit()
}

// 仅用于截图/CI 的确定性气泡数据，不写入用户历史。
function debugBubbleSnapshot() {
  const now = (Date.now() - APPLE_REF_MS) / 1000
  const task = (platform, id, sessionName, action, phase, offset, extra = {}) => ({
    id: `${platform}|${id}`,
    platform,
    title: action,
    sessionName,
    sessionDisplayName: sessionName,
    action,
    phase,
    updatedAt: now + offset,
    sessionID: id,
    ...extra
  })
  const codexTasks = [
    task('codex', 'codex-running', '重构跨平台任务气泡', '正在调整窗口尺寸与卡片层级', 'running', 7, { progress: '进度 4/6' }),
    task('codex', 'codex-waiting', 'Windows DPI 与透明窗口验证', '等待测试环境', 'waiting', 6),
    task('codex', 'codex-done-1', 'Electron 状态图标设计', '任务已完成', 'done', 5),
    task('codex', 'codex-done-2', 'macOS 深浅色基准', '任务已完成', 'done', 4),
    task('codex', 'codex-extra-1', '超长中文会话名称用于验证卡片文本截断不会越界', '检查超长文本省略号', 'running', 3),
    task('codex', 'codex-extra-2', 'Retina 缩放测试', '正在采集截图', 'thinking', 2),
    task('codex', 'codex-extra-3', '第七个任务', '用于验证 +N 任务提示', 'waiting', 1)
  ]
  const claudeTasks = [
    task('claude', 'claude-done-1', '定时审查 · 每日代码检查', '任务已完成', 'done', 8, { scheduledTaskName: '每日代码检查' }),
    task('claude', 'claude-done-2', 'Claude Desktop 会话', '任务已完成', 'done', 2)
  ]
  const dshTasks = [
    task('dsh', 'session-debug-running', '全平台桌面宠物', '运行命令：Electron screenshot smoke', 'running', 9),
    task('dsh', 'session-debug-failed', 'DSH 失败状态示例', '工具执行失败', 'failed', 3)
  ]
  const grokTasks = [
    task('grok', 'grok-waiting', 'Grok 终端会话', '等待后续活动', 'waiting', 4)
  ]
  return {
    observedAt: new Date().toISOString(),
    animation: 'running',
    phase: 'running',
    summary: 'Codex 运行中 · Claude Code 完成 · DSH 运行中 · Grok 等待中',
    platforms: [
      { platform: 'codex', label: 'Codex', phase: 'running', phaseLabel: '运行中', detail: codexTasks[0].action, task: codexTasks[0], tasks: codexTasks, activeSessions: 7 },
      { platform: 'claude', label: 'Claude Code', phase: 'done', phaseLabel: '完成', detail: claudeTasks[0].action, task: claudeTasks[0], tasks: claudeTasks, activeSessions: 2 },
      { platform: 'dsh', label: 'DSH', phase: 'running', phaseLabel: '运行中', detail: dshTasks[0].action, task: dshTasks[0], tasks: dshTasks, activeSessions: 2 },
      { platform: 'grok', label: 'Grok', phase: 'waiting', phaseLabel: '等待中', detail: grokTasks[0].action, task: grokTasks[0], tasks: grokTasks, activeSessions: 1 }
    ],
    history: {
      platforms: { codex: codexTasks, claude: claudeTasks, dsh: dshTasks, grok: grokTasks },
      dismissed: []
    }
  }
}

// ---- 应用生命周期 ----

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  app.isQuitting = false
  lifecycleCleaned = false
  loadHistory()
  registerPetIpc()
  try { await ensureCurrentPetSelection() }
  catch (err) { console.error('[allpet] 首选宠物初始化失败:', err && err.message || err) }
  pet = readCurrentPet()
  createWindow({ show: readPetEnabled() })
  createTray()
  // 三阶段截图使用确定性 fixture，避免真实 watcher 快照覆盖测试数据。
  if (!process.env.ALLPET_SCREENSHOT_STAGE) startWatch()

  // 调试：ALLPET_SCREENSHOT=/path.png 时，启动 5s 后截图退出（用于无头验证渲染）。
  if (process.env.ALLPET_SCREENSHOT) {
    const target = process.env.ALLPET_SCREENSHOT
    const screenshotStage = process.env.ALLPET_SCREENSHOT_STAGE
    if (screenshotStage) {
      const sendFixture = () => {
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('debug-bubble', {
              snapshot: debugBubbleSnapshot(),
              stage: screenshotStage,
              platform: process.env.ALLPET_SCREENSHOT_PLATFORM || 'codex'
            })
          }
        }, 500)
      }
      if (mainWindow.webContents.isLoadingMainFrame()) {
        mainWindow.webContents.once('did-finish-load', sendFixture)
      } else {
        sendFixture()
      }
    }
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const validate = screenshotStage
          ? mainWindow.webContents.executeJavaScript(`(() => {
              const bubble = document.getElementById('bubble').getBoundingClientRect()
              const pet = document.getElementById('pet').getBoundingClientRect()
              const cards = Array.from(document.querySelectorAll('.bubble-card')).map((node) => {
                const rect = node.getBoundingClientRect()
                return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
              })
              return {
                stage: ${JSON.stringify(screenshotStage)},
                viewport: { width: innerWidth, height: innerHeight },
                bubble: { left: bubble.left, top: bubble.top, right: bubble.right, bottom: bubble.bottom, width: bubble.width, height: bubble.height },
                pet: { left: pet.left, top: pet.top, right: pet.right, bottom: pet.bottom },
                cardCount: cards.length,
                cards
              }
            })()`)
          : Promise.resolve(null)
        validate.then((metrics) => {
          if (metrics) {
            const expected = {
              collapsed: { width: 304, height: 281, cards: 6 },
              platforms: { width: 324, height: 336, cards: 4 },
              tasks: { width: 334, height: 429, cards: 6 }
            }[metrics.stage]
            const epsilon = 1
            const cardsFit = metrics.cards.every((rect) => rect.left >= -epsilon && rect.right <= metrics.viewport.width + epsilon && rect.top >= -epsilon && rect.bottom <= metrics.viewport.height + epsilon)
            const windowBounds = mainWindow.getBounds()
            const workArea = screen.getDisplayMatching(windowBounds).workArea
            metrics.window = windowBounds
            metrics.workArea = workArea
            const windowFits = windowBounds.x >= workArea.x - epsilon
              && windowBounds.y >= workArea.y - epsilon
              && windowBounds.x + windowBounds.width <= workArea.x + workArea.width + epsilon
              && windowBounds.y + windowBounds.height <= workArea.y + workArea.height + epsilon
            const expectedSprite = spriteSizeForScale(readScale(), pet)
            const spriteFits = Math.abs((metrics.pet.right - metrics.pet.left) - expectedSprite.width) <= epsilon
              && Math.abs((metrics.pet.bottom - metrics.pet.top) - expectedSprite.height) <= epsilon
              && Math.abs(metrics.pet.top - metrics.bubble.bottom - 6) <= epsilon
            if (Math.abs(metrics.bubble.width - expected.width) > epsilon || Math.abs(metrics.bubble.height - expected.height) > epsilon || metrics.bubble.right > metrics.viewport.width + epsilon || metrics.bubble.bottom > metrics.viewport.height + epsilon || metrics.pet.bottom > metrics.viewport.height + epsilon || metrics.cardCount !== expected.cards || !cardsFit || !spriteFits || !windowFits) {
              throw new Error(`bubble geometry mismatch: ${JSON.stringify(metrics)}`)
            }
            console.log('[allpet] 气泡几何校验通过:', JSON.stringify(metrics))
          }
          return mainWindow.webContents.capturePage()
        }).then((img) => {
          fs.writeFileSync(target, img.toPNG())
          console.log('[allpet] 截图已保存:', target)
        }).catch((e) => {
          console.error('[allpet] 截图失败:', e)
          if (watchProc) { try { watchProc.kill() } catch {} }
          app.isQuitting = true
          app.exit(1)
        }).finally(() => {
          if (!app.isQuitting) quit()
        })
      } else {
        quit()
      }
    }, 5000)
  }

  // CI：验证托盘 show/hide 与缩放后拖动位置保持，不依赖人工点击。
  if (process.env.ALLPET_LIFECYCLE_SMOKE) {
    const target = process.env.ALLPET_LIFECYCLE_SMOKE
    setTimeout(() => {
      try {
        const initiallyVisible = mainWindow.isVisible()
        hidePet()
        const hidden = !mainWindow.isVisible()
        showPet()
        const shown = mainWindow.isVisible()
        mainWindow.setPosition(180, 180)
        const previousScale = readScale()
        const delta = previousScale >= MAX_SCALE - 0.01 ? -0.05 : 0.05
        const oldBounds = mainWindow.getBounds()
        const oldSprite = spriteSizeForScale(previousScale, pet)
        const oldAnchor = {
          x: oldBounds.x + Math.round((oldBounds.width - oldSprite.width) / 2),
          bottom: oldBounds.y + oldBounds.height
        }
        const nextScale = applyScale(delta)
        const nextBounds = mainWindow.getBounds()
        const nextSprite = spriteSizeForScale(nextScale, pet)
        const nextAnchor = {
          x: nextBounds.x + Math.round((nextBounds.width - nextSprite.width) / 2),
          bottom: nextBounds.y + nextBounds.height
        }
        applyScale(-delta)
        const result = {
          initiallyVisible, hidden, shown, petID: pet && pet.manifestId || null, oldAnchor, nextAnchor,
          preserved: oldAnchor.x === nextAnchor.x && oldAnchor.bottom === nextAnchor.bottom
        }
        fs.writeFileSync(target, JSON.stringify(result, null, 2))
        const expectedHiddenStart = process.env.ALLPET_EXPECT_HIDDEN_START === '1'
        if ((expectedHiddenStart && initiallyVisible) || !hidden || !shown || !result.petID || !result.preserved) {
          throw new Error(`lifecycle smoke mismatch: ${JSON.stringify(result)}`)
        }
        console.log('[allpet] 生命周期校验通过:', JSON.stringify(result))
        quit()
      } catch (err) {
        console.error('[allpet] 生命周期校验失败:', err)
        cleanupLifecycle()
        app.exit(1)
      }
    }, 1500)
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

if (hasSingleInstanceLock) {
  app.on('second-instance', () => showPet())
  app.on('activate', () => showPet())
}

app.on('before-quit', () => cleanupLifecycle())

app.on('window-all-closed', () => {
  // 与 AppKit accessory app 一致：窗口关闭后仍由托盘常驻，用户可再次“显示宠物”。
  if (!app.isQuitting) updateTrayMenu()
})
