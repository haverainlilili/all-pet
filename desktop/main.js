// AllPet 跨平台桌宠（Electron 主进程）
// 复用 Swift AllPetCore：以子进程跑 `allpet watch --json`，把 NDJSON 快照转发给渲染层。
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog, screen, protocol } = require('electron')
protocol.registerSchemesAsPrivileged([{
  scheme: 'allpet-thumbnail',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}])
const { spawn } = require('child_process')
const { createHash } = require('crypto')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { pathToFileURL } = require('url')
const {
  failedExternalWakePlan, isTrustedMainFrame, pickLaunchCandidate, platformLabel,
  platformLaunchSpec, rendererSnapshot, runCommandLauncher, wakePlanForTask
} = require('./src/wake')
const {
  attachRestartOnClose, catalogPetForBundle, chooseCurrentPet, createOperationGate, effectiveHome, expandHomePath, finishMutationRefresh, petCapabilities, petMutationTarget,
  preservedWindowBounds, runSerializedPetRefresh, spriteSizeForPet
} = require('./src/pet-state')
const {
  APPLE_REF_MS, accumulateTaskHistory, canonicalID, dismissPlatformHistory, dismissTaskHistory, expireTaskHistory, normalizeTaskHistory, sessionDisplayName
} = require('./src/task-history')
const { TRAY_PET_ICON_CACHE_VERSION, platformMenuTitles, scalePercentText, petTrayActionTitles, petTrayRows, reopensAfterTrayAction, trayPetIconFrames, trayPrimaryAction } = require('./src/tray-menu')
const { createBoundedThumbnailDataURL } = require('./src/pet-thumbnail')
const { reuseExistingDshTab } = require('./src/dsh-browser')
const { menuBridgeState } = require('./src/menu-bridge')
const { cropTrayPetIcon } = require('./src/tray-icon')

const MAIN_RENDERER_URL = pathToFileURL(path.join(__dirname, 'src', 'renderer.html')).href
const PET_MANAGER_URL = pathToFileURL(path.join(__dirname, 'src', 'pets.html')).href
const EFFECTIVE_HOME = effectiveHome(process.env, os.homedir())

// CI / 无头环境：禁用沙箱与 GPU，便于 xvfb 下冒烟测试。
if (process.env.ALLPET_NO_SANDBOX) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
}
if (process.env.ALLPET_REDUCE_MOTION_SMOKE) {
  app.commandLine.appendSwitch('force-prefers-reduced-motion')
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

let mainWindow = null
let petManagerWindow = null
let tray = null
let trayMenu = null
let nativeMenuBridgeProc = null
let nativeMenuBridgeBuffer = ''
let nativeMenuBridgeFailed = false
const activeSipsProcesses = new Map()
let nativeTrayPopupCount = 0
let trayFallbackIcon = null
let trayPetIconRefreshPromise = null
const trayPetIcons = new Map()
const trayDefaultPetIcons = new Map()
const wakeInFlight = new Map()
let watchProc = null
let watchRestartTimer = null
let petRefreshRetryTimer = null
let historyExpiryTimer = null
let lifecycleCleaned = false
let currentSnapshot = null
let pet = null // { bundlePath, spritesheetPath, manifestId, displayName, atlas geometry }
let petSurfaceAvailable = false // 对齐 AppKit：无宠物首启不创建可见桌面窗；曾有宠物后保留透明任务托盘。
let petCatalog = []
let petCatalogDefaults = []
const managerThumbnailPaths = new Map()
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
  return path.join(EFFECTIVE_HOME, '.config', 'all-pet', 'config.json')
}

function readCurrentPet() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    const bundlePath = expandHomePath(cfg && cfg.pet && cfg.pet.bundlePath, EFFECTIVE_HOME)
    return catalogPetForBundle(bundlePath, petCatalog)
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
  return path.join(EFFECTIVE_HOME, '.config', 'all-pet', 'task-history.json')
}

function isDSHBackedCodexHistoryTask(task) {
  if (!task || !task.sourcePath) return false
  let handle
  try {
    if (!fs.statSync(task.sourcePath).isFile()) return false
    handle = fs.openSync(task.sourcePath, 'r')
    const buffer = Buffer.alloc(16_384)
    const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0)
    const newline = buffer.subarray(0, bytes).indexOf(0x0A)
    if (newline < 0) return false
    const object = JSON.parse(buffer.subarray(0, newline).toString('utf8'))
    const payload = object && object.payload && typeof object.payload === 'object' ? object.payload : {}
    const originator = String(payload.originator || '').toLowerCase()
    const threadSource = String(payload.thread_source || '').toLowerCase()
    return originator.includes('dsh') || threadSource.includes('dsh')
  } catch {
    return false
  } finally {
    if (handle !== undefined) { try { fs.closeSync(handle) } catch {} }
  }
}

function writeJSONAtomically(target, value) {
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(temporary, target)
    try { fs.chmodSync(target, 0o600) } catch {}
  } finally {
    try { fs.unlinkSync(temporary) } catch {}
  }
}

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(historyURL(), 'utf8'))
    const normalized = normalizeTaskHistory(data, Date.now(), { isDSHBackedCodex: isDSHBackedCodexHistoryTask })
    taskHistory = normalized.platforms
    dismissedTaskIDs = normalized.dismissed
    manuallyHiddenTaskTitles = normalized.hidden
    persistHistory()
  } catch {
    taskHistory = {}
    dismissedTaskIDs = []
    manuallyHiddenTaskTitles = {}
  }
}

function persistHistory() {
  try {
    writeJSONAtomically(historyURL(), { platforms: taskHistory, dismissedTaskIDs })
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

function startHistoryExpiryTimer() {
  if (historyExpiryTimer) clearInterval(historyExpiryTimer)
  historyExpiryTimer = setInterval(() => {
    const state = mutableHistoryState()
    if (!expireTaskHistory(state, Date.now())) return
    adoptHistoryState(state)
    persistHistory()
    if (currentSnapshot) sendSnapshot(currentSnapshot)
  }, 60_000)
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

function imageMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.webp' ? 'image/webp'
    : ext === '.png' ? 'image/png'
    : ext === '.gif' ? 'image/gif'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : 'application/octet-stream'
}

function managerThumbnailURL(filePath) {
  const token = Buffer.from(path.resolve(filePath)).toString('base64url')
  managerThumbnailPaths.set(token, path.resolve(filePath))
  return `allpet-thumbnail://pet/${token}`
}

function spritesheetDataUrl(filePath) {
  const buf = fs.readFileSync(filePath)
  return `data:${imageMimeType(filePath)};base64,${buf.toString('base64')}`
}

function systemZstdAvailable(environment) {
  const names = process.platform === 'win32' ? ['zstdcat.exe', 'zstdcat', 'zstd.exe', 'zstd'] : ['zstdcat', 'zstd']
  const entries = String(environment.PATH || '').split(path.delimiter).filter(Boolean)
  return names.some(name => entries.some(entry => {
    try { fs.accessSync(path.join(entry, name), fs.constants.X_OK); return true } catch { return false }
  }))
}

// 同步跑一次 allpet CLI 子命令，返回 { code, out, err }。
function sidecarEnvironment() {
  const environment = { ...process.env }
  const decoder = [
    path.join(process.resourcesPath, 'zstd', 'zstdcat.js'),
    path.join(__dirname, 'scripts', 'zstdcat.js')
  ].find(candidate => fs.existsSync(candidate))
  if (fs.existsSync(process.execPath) && decoder && !systemZstdAvailable(environment)) {
    environment.ALLPET_ZSTD_EXECUTABLE = process.execPath
    environment.ALLPET_ZSTD_PREFIX_JSON = JSON.stringify([decoder])
    environment.ALLPET_ZSTD_ELECTRON_NODE = '1'
    environment.ELECTRON_RUN_AS_NODE = '1'
  }
  if (process.env.ELECTRON_ENABLE_LOGGING) {
    console.log('[allpet] zstd bridge:', JSON.stringify({
      packaged: app.isPackaged, system: systemZstdAvailable(environment), executable: environment.ALLPET_ZSTD_EXECUTABLE || null,
      resourcesPath: process.resourcesPath
    }))
  }
  return environment
}

function runAllpet(args) {
  return new Promise((resolve, reject) => {
    const bin = allpetBinary()
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: sidecarEnvironment() })
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
  await ensureCurrentPetSelection()
  if (!options.fromMutation && refreshEpoch !== petStateEpoch) {
    return { ok: false, stale: true, error: '宠物状态已由更新的事务刷新。' }
  }
  pet = readCurrentPet()
  if (pet) petSurfaceAvailable = true
  if (mainWindow && !mainWindow.isDestroyed()) {
    resizeWindowPreservingSprite(scale, scale, pet, previousPet)
    if (!previousPet && pet && readPetEnabled()) mainWindow.show()
  }
  pushPet()
  updateTrayMenu()
  if (process.platform === 'darwin') refreshTrayPetIcons().catch(() => {})
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
    const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}
    cfg.pet = cfg.pet || { enabled: true, anchor: 'bottom-right' }
    cfg.pet.scale = next
    writeJSONAtomically(cfgPath, cfg)
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
  watchProc = spawn(bin, ['watch', '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: sidecarEnvironment() })
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
  watchProc.stderr.on('data', (chunk) => {
    if (process.env.ELECTRON_ENABLE_LOGGING) console.error('[allpet] sidecar:', chunk.toString('utf8').trim())
  })
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
  const plan = wakePlanForTask(task, process.platform)
  if (plan.kind !== 'external' && plan.kind !== 'application') return presentWakeFallback(plan, task)
  if (wakeInFlight.has(taskID)) return wakeInFlight.get(taskID)

  const request = (async () => {
    try {
      if (plan.kind === 'application') {
        const opened = await runCommandLauncher(spawn, plan.command, plan.args)
        return {
          ...opened,
          exact: false,
          openedApp: opened.succeeded,
          message: opened.succeeded ? plan.message : opened.message
        }
      }
      let reused = false
      if (task && task.platform === 'dsh' && process.platform === 'darwin') {
        const result = await reuseExistingDshTab(spawn, plan.url, process.platform)
        if (result.status === 'reused') reused = true
        else if (result.status === 'blocked' || result.status === 'error') {
          return presentWakeFallback({
            kind: 'fallback', platform: 'dsh', canOpenPlatform: false,
            message: `${result.message || '无法控制已有 DSH 标签页'}。为避免重复窗口，未打开新页面。`
          }, task)
        }
      }
      if (!reused) await shell.openExternal(plan.url)
      if (task && (task.phase === 'done' || task.phase === 'failed')) {
        const state = mutableHistoryState()
        if (dismissTaskHistory(state, taskID)) {
          adoptHistoryState(state)
          persistHistory()
          if (currentSnapshot) sendSnapshot(currentSnapshot)
        }
      }
      return {
        succeeded: true,
        requested: true,
        exact: reused,
        openedApp: !reused,
        message: reused ? '已复用现有 DSH 标签页并切换到原会话。' : '未发现已有 DSH 标签页，已打开原会话页面。'
      }
    } catch (err) {
      return presentWakeFallback(
        failedExternalWakePlan(task, String(err && err.message || err)),
        task
      )
    } finally {
      wakeInFlight.delete(taskID)
    }
  })()
  wakeInFlight.set(taskID, request)
  return request
}

// ---- 宠物管理 ----

function createPetManagerWindow(action) {
  const dispatchAction = () => {
    if (action && petManagerWindow && !petManagerWindow.isDestroyed()) {
      petManagerWindow.webContents.send('pet-manager-action', action)
    }
  }
  if (petManagerWindow && !petManagerWindow.isDestroyed()) {
    petManagerWindow.show()
    petManagerWindow.focus()
    if (petManagerWindow.webContents.isLoadingMainFrame()) petManagerWindow.webContents.once('did-finish-load', dispatchAction)
    else dispatchAction()
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
      dispatchAction()
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
    let thumbnail = null
    try {
      const image = nativeImage.createFromPath(item.spritesheetPath)
      thumbnail = createBoundedThumbnailDataURL(image, item.cellWidth, item.cellHeight)
    } catch { /* 单个缩略图失败不影响列表 */ }
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
      thumbnail,
      thumbnailURL: !thumbnail && item.spritesheetPath ? managerThumbnailURL(item.spritesheetPath) : null
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

function runSips(args) {
  return new Promise((resolve, reject) => {
    if (app.isQuitting) { reject(new Error('app is quitting')); return }
    const child = spawn('/usr/bin/sips', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    let timedOut = false
    let settled = false
    const finish = callback => {
      if (settled) return
      settled = true
      const timer = activeSipsProcesses.get(child)
      if (timer) clearTimeout(timer)
      activeSipsProcesses.delete(child)
      callback()
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
    }, 10000)
    activeSipsProcesses.set(child, timer)
    child.stderr.on('data', chunk => { error += chunk.toString('utf8') })
    child.on('error', err => finish(() => reject(err)))
    child.on('exit', code => finish(() => {
      if (timedOut) reject(new Error('sips timed out after 10 seconds'))
      else if (code === 0) resolve()
      else reject(new Error(error.trim() || `sips exited ${code}`))
    }))
  })
}

function trayPetIconDescriptor(item) {
  try {
    const source = path.resolve(String(item.spritesheetPath || ''))
    const stat = fs.statSync(source)
    if (!stat.isFile()) return null
    const rawCellWidth = Number(item.cellWidth)
    const rawCellHeight = Number(item.cellHeight)
    if (!Number.isFinite(rawCellWidth) || !Number.isFinite(rawCellHeight) || rawCellWidth < 1 || rawCellHeight < 1) return null
    const cellWidth = Math.round(rawCellWidth)
    const cellHeight = Math.round(rawCellHeight)
    const rows = Math.max(1, Math.round(Number(item.rows) || 1))
    const columns = Math.max(1, Math.round(Number(item.columns) || 1))
    const signature = createHash('sha256')
      .update(`${TRAY_PET_ICON_CACHE_VERSION}\0${source}\0${stat.size}\0${stat.mtimeMs}\0${cellWidth}\0${cellHeight}\0${rows}\0${columns}`)
      .digest('hex').slice(0, 24)
    const cacheDirectory = path.join(EFFECTIVE_HOME, '.config', 'all-pet', 'thumbnails', 'menu')
    return { source, cellWidth, cellHeight, rows, columns, signature, cacheDirectory, cachePath: path.join(cacheDirectory, `${signature}.png`) }
  } catch {
    return null
  }
}

function boundedPNGSize(filePath, maximumDimension = 24) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size < 24 || stat.size > 96 * 1024) return null
    const header = Buffer.alloc(24)
    const fd = fs.openSync(filePath, 'r')
    try {
      if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) return null
    } finally {
      fs.closeSync(fd)
    }
    if (!header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null
    const width = header.readUInt32BE(16)
    const height = header.readUInt32BE(20)
    if (width < 1 || height < 1 || width > maximumDimension || height > maximumDimension) return null
    return { width, height }
  } catch {
    return null
  }
}

async function generateTrayPetIcon(descriptor) {
  fs.mkdirSync(descriptor.cacheDirectory, { recursive: true, mode: 0o700 })
  if (fs.existsSync(descriptor.cachePath) && !boundedPNGSize(descriptor.cachePath, 20)) {
    try { fs.unlinkSync(descriptor.cachePath) } catch {}
  }
  if (!fs.existsSync(descriptor.cachePath)) {
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const outputPath = path.join(descriptor.cacheDirectory, `.${descriptor.signature}-${nonce}.png`)
    const convertedPath = path.join(os.tmpdir(), `allpet-menu-source-${nonce}.png`)
    try {
      // nativeImage.crop 使用明确的左上角像素坐标；不要再把 atlas 坐标传给
      // sips --cropOffset，后者的 (0, 0) 实际会裁到图集中心。
      // Electron 不能直接解码部分 WebP atlas 时，只让 sips 做格式转换，不让它决定裁切坐标。
      let cropDescriptor = descriptor
      const sourceImage = nativeImage.createFromPath(descriptor.source)
      if (sourceImage.isEmpty()) {
        await runSips(['-s', 'format', 'png', descriptor.source, '--out', convertedPath])
        cropDescriptor = { ...descriptor, source: convertedPath }
      }
      const [[row, column]] = trayPetIconFrames()
      const icon = cropTrayPetIcon(nativeImage, cropDescriptor, row, column, 20)
      fs.writeFileSync(outputPath, icon.toPNG(), { mode: 0o600 })
      if (!boundedPNGSize(outputPath, 20)) throw new Error('generated tray icon is not a bounded PNG')
      fs.renameSync(outputPath, descriptor.cachePath)
      try { fs.chmodSync(descriptor.cachePath, 0o600) } catch {}
    } finally {
      try { fs.unlinkSync(outputPath) } catch {}
      try { fs.unlinkSync(convertedPath) } catch {}
    }
  }
  const icon = nativeImage.createFromPath(descriptor.cachePath)
  return icon.isEmpty() ? null : icon
}
function fallbackTrayPetIcon() {
  if (trayFallbackIcon) return trayFallbackIcon
  const iconPath = path.join(__dirname, 'assets', 'icon.png')
  const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  trayFallbackIcon = image.isEmpty() ? undefined : image.resize({ width: 18, height: 18, quality: 'best' })
  return trayFallbackIcon
}

function trayIconCatalogRevision(items) {
  return JSON.stringify((Array.isArray(items) ? items : []).map(item => {
    const descriptor = trayPetIconDescriptor(item)
    return [petMutationTarget(item), descriptor && descriptor.signature]
  }))
}

async function refreshTrayPetIcons() {
  if (process.platform !== 'darwin') return
  if (trayPetIconRefreshPromise) return trayPetIconRefreshPromise
  trayPetIconRefreshPromise = (async () => {
    let revision
    do {
      if (app.isQuitting) break
      const catalog = [...petCatalog]
      revision = trayIconCatalogRevision(catalog)
      for (const item of catalog) {
        if (app.isQuitting) break
        const target = petMutationTarget(item)
        const descriptor = trayPetIconDescriptor(item)
        if (!target || !descriptor) continue
        const cached = trayPetIcons.get(target)
        if (cached && cached.signature === descriptor.signature) continue
        try {
          const icon = await generateTrayPetIcon(descriptor)
          if (icon) trayPetIcons.set(target, { signature: descriptor.signature, icon })
        } catch (err) {
          if (!app.isQuitting) console.error(`[allpet] 生成菜单宠物缩略图失败 (${item.id || target}):`, err && err.message || err)
        }
      }
    } while (!app.isQuitting && revision !== trayIconCatalogRevision(petCatalog))
    if (!app.isQuitting && (tray || nativeMenuBridgeProc)) updateTrayMenu()
  })().finally(() => { trayPetIconRefreshPromise = null })
  return trayPetIconRefreshPromise
}

function hydrateCachedTrayPetIcons() {
  if (process.platform !== 'darwin') return
  for (const item of petCatalog) {
    const target = petMutationTarget(item)
    const descriptor = trayPetIconDescriptor(item)
    if (!target || !descriptor || !boundedPNGSize(descriptor.cachePath, 20)) continue
    const icon = nativeImage.createFromPath(descriptor.cachePath)
    if (!icon.isEmpty()) trayPetIcons.set(target, { signature: descriptor.signature, icon })
  }
}

function trayPetIcon(target) {
  return trayPetIcons.get(String(target || ''))?.icon || fallbackTrayPetIcon()
}

function defaultTrayPetIcon(source) {
  const slug = String(source || '')
  if (/^[a-z0-9._-]+$/i.test(slug)) {
    const filePath = path.join(EFFECTIVE_HOME, '.config', 'all-pet', 'thumbnails', `${slug}.png`)
    const bounded = boundedPNGSize(filePath, 64)
    if (bounded) {
      try {
        const stat = fs.statSync(filePath)
        const signature = `${stat.size}:${stat.mtimeMs}`
        const cached = trayDefaultPetIcons.get(slug)
        if (cached && cached.signature === signature) return cached.icon
        const image = nativeImage.createFromPath(filePath)
        if (!image.isEmpty()) {
          const size = image.getSize()
          const scale = 20 / Math.max(size.width, size.height)
          const icon = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'best' })
          trayDefaultPetIcons.set(slug, { signature, icon })
          return icon
        }
      } catch {}
    }
  }
  return fallbackTrayPetIcon()
}

function nativeMenuIconPath(item) {
  const descriptor = trayPetIconDescriptor(item)
  return descriptor && boundedPNGSize(descriptor.cachePath, 20) ? descriptor.cachePath : null
}

function nativeMenuDefaultIconPath(source) {
  const slug = String(source || '')
  if (!/^[a-z0-9._-]+$/i.test(slug)) return null
  const filePath = path.join(EFFECTIVE_HOME, '.config', 'all-pet', 'thumbnails', `${slug}.png`)
  return boundedPNGSize(filePath, 64) ? filePath : null
}

function nativeMenuState() {
  const visible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())
  return menuBridgeState({
    type: 'state',
    visible,
    hasPet: Boolean(pet),
    busy: petOperationState.busy,
    busyLabel: petOperationState.label || null,
    scalePercent: scalePercentText(readScale()),
    tooltip: petOperationState.busy ? `AllPet · 正在${petOperationState.label || '操作'}` : `AllPet · ${pet && pet.displayName || '无宠物'}`,
    statusIconPath: app.isPackaged ? path.join(process.resourcesPath, 'tray', 'icon.png') : path.join(__dirname, 'assets', 'icon.png'),
    platformTitles: platformMenuTitles(currentSnapshot && currentSnapshot.platforms, disabledPlatformKeys()),
    installedPets: petCatalog.map(item => ({
      label: String(item.displayName || item.id || '未命名宠物'),
      target: petMutationTarget(item),
      current: Boolean(item.current),
      iconPath: nativeMenuIconPath(item)
    })),
    defaultPets: petCatalogDefaults.map(item => ({
      label: String(item.displayName || item.slug || '默认宠物'),
      source: String(item.slug || ''),
      iconPath: nativeMenuDefaultIconPath(item.slug)
    })).filter(item => item.source)
  })
}
function sendNativeMenuState() {
  if (!nativeMenuBridgeProc || !nativeMenuBridgeProc.stdin || nativeMenuBridgeProc.stdin.destroyed) return
  try { nativeMenuBridgeProc.stdin.write(`${JSON.stringify(nativeMenuState())}\n`) } catch {}
}

async function handleNativeMenuAction(message) {
  const action = String(message && message.action || '')
  const value = message && message.value
  if (action === 'toggle-visibility') togglePetVisibility()
  else if (action === 'scale-decrease') applyScale(-0.05)
  else if (action === 'scale-increase') applyScale(0.05)
  else if (action === 'pet-select' && value) await runTrayPetCommand('切换宠物', ['pet', 'set', String(value)])
  else if (action === 'pet-install' && value) await runTrayPetCommand('安装宠物', ['pet', 'install', String(value)])
  else if (action === 'pet-delete' && value) {
    const row = petCatalog.find(item => petMutationTarget(item) === String(value))
    const confirmation = await dialog.showMessageBox({
      type: 'warning', title: '删除宠物…', message: `删除宠物「${row && (row.displayName || row.id) || value}」？`,
      detail: `${value}\n此操作不可撤销。`, buttons: ['取消', '删除'], defaultId: 0, cancelId: 0
    })
    if (confirmation.response === 1) await runTrayPetCommand('删除宠物', ['pet', 'delete', String(value)])
  } else if (action === 'open-manager') createPetManagerWindow(value === 'install' || value === 'import' ? value : undefined)
  else if (action === 'refresh-pets') {
    const result = await runSerializedPetRefresh(petOperationGate, () => refreshDesktopState({ fromMutation: true }))
    if (!result || !result.ok) await dialog.showMessageBox({ type: 'warning', title: '刷新失败', message: '无法刷新宠物状态', detail: String(result && result.error || '未知错误'), buttons: ['知道了'] })
  } else if (action === 'open-config') await openConfig()
  else if (action === 'quit') quit()
}
function consumeNativeMenuBridgeOutput(chunk, onReady) {
  nativeMenuBridgeBuffer += chunk.toString('utf8')
  const lines = nativeMenuBridgeBuffer.split('\n')
  nativeMenuBridgeBuffer = lines.pop() || ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const message = JSON.parse(line)
      if (message.type === 'ready') onReady()
      else if (message.type === 'action') handleNativeMenuAction(message).catch(err => console.error('[allpet] 原生菜单动作失败:', err && err.message || err))
    } catch {}
  }
}

function shouldUseLegacyMacTray() {
  return Boolean(process.env.ALLPET_TRAY_NATIVE_SMOKE || process.env.ALLPET_TRAY_NATIVE_HEADLESS_SMOKE || process.env.ALLPET_TRAY_NATIVE_PREVIEW || process.env.ALLPET_TRAY_PETS_PREVIEW)
}

function startNativeMenuBridge() {
  if (process.platform !== 'darwin' || nativeMenuBridgeFailed || shouldUseLegacyMacTray()) return Promise.resolve(false)
  return new Promise(resolve => {
    let settled = false
    let child
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    try {
      child = spawn(allpetBinary(), ['menu-bridge'], { stdio: ['pipe', 'pipe', 'pipe'], env: sidecarEnvironment() })
    } catch (err) {
      console.error('[allpet] 启动原生菜单桥接失败:', err && err.message || err)
      resolve(false)
      return
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; finish(false) }, 4000)
    child.stdout.on('data', chunk => consumeNativeMenuBridgeOutput(chunk, () => {
      if (settled) return
      nativeMenuBridgeProc = child
      sendNativeMenuState()
      finish(true)
    }))
    child.stderr.on('data', chunk => { if (!app.isQuitting) console.error('[allpet] 原生菜单桥接:', chunk.toString('utf8').trim()) })
    child.once('error', err => { console.error('[allpet] 原生菜单桥接错误:', err && err.message || err); finish(false) })
    child.once('close', () => {
      const wasActive = nativeMenuBridgeProc === child
      if (wasActive) nativeMenuBridgeProc = null
      if (!app.isQuitting && wasActive) {
        nativeMenuBridgeFailed = true
        console.error('[allpet] 原生菜单桥接已退出，回退 Electron 原生菜单')
        setTimeout(() => createTray().catch(err => console.error('[allpet] 托盘回退失败:', err && err.message || err)), 250)
      }
      finish(false)
    })
  })
}

function popUpMacTrayMenu() {
  if (process.platform !== 'darwin' || !tray || !trayMenu) return
  if (!process.env.ALLPET_TRAY_NATIVE_HEADLESS_SMOKE) tray.popUpContextMenu(trayMenu)
  nativeTrayPopupCount += 1
}

function applyTrayScale(delta, action) {
  applyScale(delta)
  if (reopensAfterTrayAction(process.platform, action)) setTimeout(popUpMacTrayMenu, 30)
}

async function createTray() {
  if (await startNativeMenuBridge()) return
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
  if (trayPrimaryAction(process.platform) === 'open-menu') {
    tray.on('click', popUpMacTrayMenu)
    tray.on('right-click', popUpMacTrayMenu)
  } else {
    tray.on('click', togglePetVisibility)
  }
  updateTrayMenu()
}

async function showPet() {
  if (!petSurfaceAvailable) {
    const result = await runSerializedPetRefresh(
      petOperationGate,
      () => refreshDesktopState({ fromMutation: true })
    )
    if (!result || !result.ok || !petSurfaceAvailable) return
  }
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
    icon: process.platform === 'darwin' ? trayPetIcon(row.target) : undefined,
    enabled: !busy && !row.current && Boolean(row.target),
    click: () => runTrayPetCommand('切换宠物', ['pet', 'set', row.target])
  }))
  if (!submenu.length) submenu.push({ label: '暂无已安装宠物', enabled: false })
  if (rows.pending.length) {
    submenu.push({ type: 'separator' })
    submenu.push({ label: '未安装的默认宠物', enabled: false })
    for (const row of rows.pending) {
      const defaultIcon = process.platform === 'darwin' ? defaultTrayPetIcon(row.source) : undefined
      submenu.push({
        label: row.label, enabled: !busy,
        icon: defaultIcon,
        click: () => runTrayPetCommand('安装宠物', ['pet', 'install', row.source])
      })
    }
  }
  const capabilities = petCapabilities(process.platform)
  const actionTitles = petTrayActionTitles(capabilities.importLocal)
  const deleteRows = rows.installed.map(row => ({
    label: row.label, enabled: !busy && Boolean(row.target),
    icon: process.platform === 'darwin' ? trayPetIcon(row.target) : undefined,
    click: async () => {
      const confirmation = await dialog.showMessageBox({
        type: 'warning', title: actionTitles.deletePet,
        message: `删除宠物「${row.label}」？`,
        detail: `${row.target}\n此操作不可撤销。`,
        buttons: ['取消', '删除'], defaultId: 0, cancelId: 0
      })
      if (confirmation.response === 1) await runTrayPetCommand('删除宠物', ['pet', 'delete', row.target])
    }
  }))
  submenu.push({ type: 'separator' })
  submenu.push({ label: '宠物管理…', click: () => createPetManagerWindow() })
  submenu.push({ label: actionTitles.install, enabled: !busy, click: () => createPetManagerWindow('install') })
  submenu.push({
    label: actionTitles.importLocal, enabled: !busy && capabilities.importLocal,
    click: () => createPetManagerWindow('import')
  })
  submenu.push({ label: actionTitles.deletePet, enabled: !busy && deleteRows.length > 0, submenu: deleteRows })
  submenu.push({
    label: actionTitles.refresh, enabled: !busy,
    click: async () => {
      const result = await runSerializedPetRefresh(
        petOperationGate,
        () => refreshDesktopState({ fromMutation: true })
      )
      if (!result || !result.ok) {
        await dialog.showMessageBox({
          type: 'warning', title: '刷新失败', message: '无法刷新宠物状态',
          detail: String(result && result.error || '未知错误'), buttons: ['知道了']
        })
      }
    }
  })
  submenu.push({ label: '格式：cc-haha · clawd-on-desk · LingChat', enabled: false })
  return submenu
}

function disabledPlatformKeys() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    const platforms = cfg && cfg.platforms && typeof cfg.platforms === 'object' ? cfg.platforms : {}
    return ['codex', 'claude', 'dsh', 'grok'].filter(key => platforms[key] && platforms[key].enabled === false)
  } catch {
    return []
  }
}

function updateTrayMenu() {
  if (nativeMenuBridgeProc) {
    sendNativeMenuState()
    return
  }
  if (!tray) return
  const snapshot = currentSnapshot
  const visible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())
  const busy = petOperationState.busy
  const template = [
    { label: '显示/隐藏宠物', click: togglePetVisibility },
    { label: `宠物大小：${scalePercentText(readScale())}`, enabled: false },
    { label: '减小宠物 5%', enabled: Boolean(pet) && !busy, click: () => applyTrayScale(-0.05, 'scale-decrease') },
    { label: '增大宠物 5%', enabled: Boolean(pet) && !busy, click: () => applyTrayScale(0.05, 'scale-increase') },
    { label: '宠物', submenu: petTraySubmenu() },
    { type: 'separator' }
  ]
  for (const label of platformMenuTitles(snapshot && snapshot.platforms, disabledPlatformKeys())) {
    template.push({ label, enabled: false })
  }
  template.push({ type: 'separator' })
  if (busy) template.push({ label: `正在${petOperationState.label}…`, enabled: false })
  template.push({ label: '打开配置', click: () => openConfig() })
  template.push({ label: '退出', click: () => quit() })
  tray.setToolTip(busy ? `AllPet · 正在${petOperationState.label}` : `AllPet · ${pet ? pet.displayName : '无宠物'}`)
  trayMenu = Menu.buildFromTemplate(template)
  if (process.platform !== 'darwin') tray.setContextMenu(trayMenu)
}

function cleanupLifecycle() {
  if (lifecycleCleaned) return
  lifecycleCleaned = true
  app.isQuitting = true
  if (watchRestartTimer) { clearTimeout(watchRestartTimer); watchRestartTimer = null }
  if (petRefreshRetryTimer) { clearTimeout(petRefreshRetryTimer); petRefreshRetryTimer = null }
  if (historyExpiryTimer) { clearInterval(historyExpiryTimer); historyExpiryTimer = null }
  if (nativeMenuBridgeProc) {
    const child = nativeMenuBridgeProc
    nativeMenuBridgeProc = null
    try { child.stdin.end() } catch {}
    try { child.kill() } catch {}
  }
  for (const [child, timer] of activeSipsProcesses) {
    clearTimeout(timer)
    try { child.kill('SIGKILL') } catch {}
  }
  activeSipsProcesses.clear()
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
  protocol.handle('allpet-thumbnail', (request) => {
    try {
      const token = new URL(request.url).pathname.replace(/^\//, '')
      const filePath = managerThumbnailPaths.get(token)
      if (!filePath || !fs.statSync(filePath).isFile()) return new Response(null, { status: 404 })
      return new Response(fs.readFileSync(filePath), {
        headers: { 'content-type': imageMimeType(filePath), 'access-control-allow-origin': '*' }
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
  app.isQuitting = false
  lifecycleCleaned = false
  loadHistory()
  startHistoryExpiryTimer()
  registerPetIpc()
  try { await ensureCurrentPetSelection() }
  catch (err) { console.error('[allpet] 首选宠物初始化失败:', err && err.message || err) }
  if (process.platform === 'darwin') hydrateCachedTrayPetIcons()
  pet = readCurrentPet()
  petSurfaceAvailable = Boolean(pet)
  createWindow({ show: readPetEnabled() && petSurfaceAvailable })
  await createTray()
  if (process.platform === 'darwin') refreshTrayPetIcons().catch(() => {})
  // 三阶段截图使用确定性 fixture，避免真实 watcher 快照覆盖测试数据。
  if (!process.env.ALLPET_SCREENSHOT_STAGE) startWatch()

  if (process.platform === 'darwin' && process.env.ALLPET_TRAY_NATIVE_PREVIEW) {
    setTimeout(() => {
      console.log('[allpet] 菜单栏图标边界:', JSON.stringify(tray.getBounds()))
      popUpMacTrayMenu()
    }, 900)
  }
  if (process.platform === 'darwin' && process.env.ALLPET_TRAY_PETS_PREVIEW) {
    setTimeout(() => {
      const item = trayMenu && trayMenu.items.find(candidate => candidate.label === '宠物')
      if (item && item.submenu) tray.popUpContextMenu(item.submenu)
    }, 900)
  }

  // 调试：本机模式调用真实原生 popup；CI headless 模式验证同一菜单/回调路径但不进入无会话可关闭的 AppKit tracking loop。
  const trayNativeSmokeTarget = process.env.ALLPET_TRAY_NATIVE_SMOKE || process.env.ALLPET_TRAY_NATIVE_HEADLESS_SMOKE
  if (process.platform === 'darwin' && trayNativeSmokeTarget) {
    const target = trayNativeSmokeTarget
    const headlessPopup = Boolean(process.env.ALLPET_TRAY_NATIVE_HEADLESS_SMOKE)
    setTimeout(async () => {
      try {
        const wait = delay => new Promise(resolve => setTimeout(resolve, delay))
        await refreshTrayPetIcons()
        if (!trayMenu || trayMenu.items.length < 1) throw new Error('native tray menu missing')
        const generatedIcons = petCatalog.map(item => {
          const target = petMutationTarget(item)
          const descriptor = trayPetIconDescriptor(item)
          const cached = trayPetIcons.get(target)
          return { target, current: Boolean(descriptor && cached && cached.signature === descriptor.signature) }
        })
        const visibleBefore = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())
        setTimeout(() => { try { tray.closeContextMenu() } catch {} }, 100)
        tray.emit('click')
        await wait(140)
        const visibleAfterClick = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())
        const petItem = trayMenu.items.find(item => item.label === '宠物')
        const petRows = petItem && petItem.submenu ? petItem.submenu.items.slice(0, petCatalog.length) : []
        const iconSizes = petRows.map(item => {
          const size = item.icon && !item.icon.isEmpty() ? item.icon.getSize() : { width: 0, height: 0 }
          return { label: item.label, width: size.width, height: size.height }
        })
        const scaleBefore = readScale()
        const scaleLabel = scaleBefore >= MAX_SCALE - 0.0001 ? '减小宠物 5%' : '增大宠物 5%'
        const scaleItem = trayMenu.items.find(item => item.label === scaleLabel)
        if (!scaleItem || typeof scaleItem.click !== 'function') throw new Error('native scale item missing')
        scaleItem.click(scaleItem, undefined, {})
        setTimeout(() => { try { tray.closeContextMenu() } catch {} }, 120)
        await wait(180)
        const scaleAfter = readScale()
        applyScale(scaleBefore - scaleAfter)
        const diagnostics = {
          nativeMenu: trayPrimaryAction(process.platform) === 'open-menu',
          popupMode: headlessPopup ? 'headless-callback' : 'native-popup',
          visibleBefore, visibleAfterClick,
          popupCount: nativeTrayPopupCount,
          scaleChanged: Math.abs(scaleAfter - scaleBefore) > 0.0001,
          petCount: petCatalog.length,
          generatedIconCount: generatedIcons.filter(item => item.current).length,
          iconSizes
        }
        if (!diagnostics.nativeMenu || visibleAfterClick !== visibleBefore || diagnostics.popupCount < 2 || !diagnostics.scaleChanged || diagnostics.generatedIconCount !== petCatalog.length || iconSizes.length !== petCatalog.length || iconSizes.some(size => size.width < 1 || size.height < 1 || size.width > 20 || size.height > 20)) {
          throw new Error(`native tray validation failed: ${JSON.stringify(diagnostics)}`)
        }
        fs.writeFileSync(target, JSON.stringify(diagnostics, null, 2))
        console.log('[allpet] macOS 原生菜单校验通过:', JSON.stringify(diagnostics))
        try { tray.closeContextMenu() } catch {}
        cleanupLifecycle()
        app.exit(0)
      } catch (err) {
        console.error('[allpet] macOS 原生菜单校验失败:', err && err.stack || err)
        try { tray.closeContextMenu() } catch {}
        cleanupLifecycle()
        app.exit(1)
      }
    }, 800)
  }

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
                reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
                rotationIndex: Number(document.getElementById('bubble').dataset.rotationIndex || -1),
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
            metrics.windowVisible = mainWindow.isVisible()
            metrics.hasPet = Boolean(pet)
            const windowFits = windowBounds.x >= workArea.x - epsilon
              && windowBounds.y >= workArea.y - epsilon
              && windowBounds.x + windowBounds.width <= workArea.x + workArea.width + epsilon
              && windowBounds.y + windowBounds.height <= workArea.y + workArea.height + epsilon
            const expectedSprite = spriteSizeForScale(readScale(), pet)
            const spriteFits = Math.abs((metrics.pet.right - metrics.pet.left) - expectedSprite.width) <= epsilon
              && Math.abs((metrics.pet.bottom - metrics.pet.top) - expectedSprite.height) <= epsilon
              && Math.abs(metrics.pet.top - metrics.bubble.bottom - 6) <= epsilon
            const reduceMotionValid = !process.env.ALLPET_REDUCE_MOTION_SMOKE
              || (metrics.reducedMotion && metrics.rotationIndex === 0)
            const noPetStartValid = !process.env.ALLPET_EXPECT_NO_PET_START
              || (!metrics.hasPet && !metrics.windowVisible && !petSurfaceAvailable)
            if (Math.abs(metrics.bubble.width - expected.width) > epsilon || Math.abs(metrics.bubble.height - expected.height) > epsilon || metrics.bubble.right > metrics.viewport.width + epsilon || metrics.bubble.bottom > metrics.viewport.height + epsilon || metrics.pet.bottom > metrics.viewport.height + epsilon || metrics.cardCount !== expected.cards || !cardsFit || !spriteFits || !windowFits || !reduceMotionValid || !noPetStartValid) {
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
    const runLifecycleSmoke = (attempt = 0) => {
      const expectedDSHTitle = process.env.ALLPET_EXPECT_DSH_TASK_TITLE
      const pendingDSH = currentSnapshot && Array.isArray(currentSnapshot.platforms)
        ? currentSnapshot.platforms.find(item => item && item.platform === 'dsh') : null
      const pendingDSHTitle = pendingDSH && pendingDSH.task && pendingDSH.task.title || null
      if (expectedDSHTitle && pendingDSHTitle !== expectedDSHTitle && attempt < 20) {
        setTimeout(() => runLifecycleSmoke(attempt + 1), 500)
        return
      }
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
        const dshStatus = currentSnapshot && Array.isArray(currentSnapshot.platforms)
          ? currentSnapshot.platforms.find(item => item && item.platform === 'dsh') : null
        const result = {
          initiallyVisible, hidden, shown, petID: pet && pet.manifestId || null, oldAnchor, nextAnchor,
          preserved: oldAnchor.x === nextAnchor.x && oldAnchor.bottom === nextAnchor.bottom,
          dshTaskTitle: dshStatus && dshStatus.task && dshStatus.task.title || null
        }
        fs.writeFileSync(target, JSON.stringify(result, null, 2))
        const expectedHiddenStart = process.env.ALLPET_EXPECT_HIDDEN_START === '1'
        if ((expectedHiddenStart && initiallyVisible) || !hidden || !shown || !result.petID || !result.preserved
            || (expectedDSHTitle && result.dshTaskTitle !== expectedDSHTitle)) {
          throw new Error(`lifecycle smoke mismatch: ${JSON.stringify(result)}`)
        }
        console.log('[allpet] 生命周期校验通过:', JSON.stringify(result))
        quit()
      } catch (err) {
        console.error('[allpet] 生命周期校验失败:', err)
        cleanupLifecycle()
        app.exit(1)
      }
    }
    setTimeout(runLifecycleSmoke, 1500)
  }

  // 调试：ALLPET_PET_MANAGER_SCREENSHOT=/path.png 时，打开宠物管理窗口并截图退出。
  if (process.env.ALLPET_PET_MANAGER_SCREENSHOT) {
    const target = process.env.ALLPET_PET_MANAGER_SCREENSHOT
    setTimeout(() => {
      createPetManagerWindow()
      setTimeout(() => {
        if (petManagerWindow && !petManagerWindow.isDestroyed()) {
          petManagerWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.pet-card img')).map(img => ({ width: img.naturalWidth, height: img.naturalHeight, bytes: img.src.length }))`).then((thumbnails) => {
            if (!thumbnails.length || thumbnails.some(item => item.width < 1 || item.height < 1 || item.width > 72 || item.height > 72 || item.bytes > 96 * 1024)) {
              throw new Error(`pet thumbnail bounds mismatch: ${JSON.stringify(thumbnails)}`)
            }
            console.log('[allpet] 宠物缩略图边界校验通过:', JSON.stringify(thumbnails))
            return petManagerWindow.webContents.capturePage()
          }).then((img) => {
            fs.writeFileSync(target, img.toPNG())
            console.log('[allpet] 宠物管理截图已保存:', target)
          }).catch((e) => { console.error('[allpet] 宠物管理截图失败:', e); process.exitCode = 1 }).finally(() => quit())
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
