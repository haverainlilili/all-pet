// AllPet 跨平台桌宠（Electron 主进程）
// 复用 Swift AllPetCore：以子进程跑 `allpet watch --json`，把 NDJSON 快照转发给渲染层。
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog } = require('electron')
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
  mainWindow = new BrowserWindow({
    width: 216,
    height: 256,
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

  // 首次就绪后，把宠物素材 + 当前快照推给渲染层。
  mainWindow.webContents.on('did-finish-load', () => {
    pushPet()
    if (currentSnapshot) sendSnapshot(currentSnapshot)
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

function pushPet() {
  pet = readCurrentPet()
  const payload = pet
    ? {
        ok: true,
        id: pet.manifestId,
        name: pet.displayName,
        spritesheet: spritesheetDataUrl(pet.spritesheetPath)
      }
    : { ok: false }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet', payload)
  }
}

function sendSnapshot(snap) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('snapshot', snap)
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
