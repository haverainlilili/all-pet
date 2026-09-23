'use strict'

const PLATFORM_LABELS = {
  codex: 'Codex',
  claude: 'Claude Code',
  dsh: 'DSH',
  grok: 'Grok'
}

function platformLabel(platform) {
  return PLATFORM_LABELS[platform] || platform || '平台'
}

function isCodexCLI(task) {
  return task && (
    task.launchOrigin === 'codex-cli'
    || Boolean(task.terminalTTY)
    || Boolean(task.terminalBinding && task.terminalBinding.tty)
  )
}

/**
 * 生成一次“安全唤醒”计划。只有来源明确的 Codex Desktop 才返回深链交接计划；
 * OS 接收深链不代表目标已显示，主进程仍须保留卡片。其余来源默认 fail-closed。
 */
function failedExternalWakePlan(task, errorMessage) {
  return {
    kind: 'fallback',
    platform: task && task.platform || null,
    canOpenPlatform: false,
    message: `无法发送原会话深链：${errorMessage}。未打开应用首页，任务卡片已保留。`
  }
}

function wakePlanForTask(task) {
  if (!task || !task.platform) {
    return {
      kind: 'missing',
      platform: null,
      canOpenPlatform: false,
      message: '任务记录已不存在，未打开其他平台或会话。'
    }
  }

  const platform = task.platform
  const label = platformLabel(platform)
  const sessionID = typeof task.sessionID === 'string' ? task.sessionID.trim() : ''
  const launchOrigin = typeof task.launchOrigin === 'string' ? task.launchOrigin.trim().toLowerCase() : ''

  if (platform === 'codex' && sessionID && launchOrigin === 'codex-desktop' && !isCodexCLI(task)) {
    return {
      kind: 'external',
      platform,
      url: `codex://threads/${encodeURIComponent(sessionID)}`,
      message: null
    }
  }

  const messages = {
    codex: isCodexCLI(task)
      ? '这是 Codex CLI 任务；Electron 无法安全聚焦此前的终端标签页。为避免创建重复任务，不会启动新的 Codex 进程，任务卡片会继续保留。'
      : '缺少可验证的 Codex Desktop 来源或会话标识，未发送深链、未打开应用首页。',
    claude: 'Claude Desktop 没有公开的“聚焦现有会话”深链，Claude CLI 也无法跨平台安全聚焦此前终端。为避免创建会话副本，不会启动新的 Claude 进程，任务卡片会继续保留。',
    dsh: 'Electron 无法跨浏览器安全写入 DSH 当前会话并验证切换结果。为避免声称已定位到错误会话，任务卡片会继续保留。',
    grok: 'Electron 无法跨平台安全聚焦此前的 Grok 终端标签页。为避免创建重复任务，不会启动新的 Grok 进程，任务卡片会继续保留。'
  }

  return {
    kind: 'fallback',
    platform,
    canOpenPlatform: platform === 'dsh',
    message: messages[platform] || `无法安全定位到原 ${label} 任务，任务卡片会继续保留。`
  }
}


const RENDER_TASK_FIELDS = [
  'sessionName', 'title', 'action', 'toolName', 'completedSteps', 'totalSteps',
  'progressLabel', 'sessionID', 'scheduledTaskName', 'phase'
]

function pickFields(value, fields) {
  const result = {}
  for (const field of fields) {
    if (value && value[field] !== undefined) result[field] = value[field]
  }
  return result
}

function rendererSnapshot(snapshot) {
  const safe = pickFields(snapshot, ['observedAt', 'animation', 'phase', 'summary'])
  safe.platforms = (snapshot && Array.isArray(snapshot.platforms) ? snapshot.platforms : []).map((platform) => {
    const item = pickFields(platform, [
      'platform', 'label', 'phase', 'phaseLabel', 'detail', 'activeSessions',
      'enabled', 'bubbleHeader', 'bubbleDetails'
    ])
    item.task = platform && platform.task ? pickFields(platform.task, RENDER_TASK_FIELDS) : null
    item.tasks = (platform && Array.isArray(platform.tasks) ? platform.tasks : []).map(task => pickFields(task, RENDER_TASK_FIELDS))
    return item
  })
  return safe
}

function isTrustedMainFrame(event, mainWindow, expectedURL) {
  if (!event || !mainWindow || !expectedURL || (mainWindow.isDestroyed && mainWindow.isDestroyed())) return false
  const contents = mainWindow.webContents
  return Boolean(
    contents
    && event.sender === contents
    && event.senderFrame === contents.mainFrame
    && event.senderFrame.url === expectedURL
  )
}

function mergeDefined(previous, update) {
  const defined = Object.fromEntries(Object.entries(update || {}).filter(([, value]) => value !== undefined))
  return Object.assign({}, previous || {}, defined)
}

function linuxTerminalCandidates(executable) {
  return [
    { command: 'x-terminal-emulator', args: ['-e', executable] },
    { command: 'gnome-terminal', args: ['--', executable] },
    { command: 'konsole', args: ['-e', executable] },
    { command: 'xfce4-terminal', args: [`--command=${executable}`] },
    { command: 'xterm', args: ['-e', executable] }
  ]
}

function pickLaunchCandidate(candidates, isAvailable) {
  return (candidates || []).find(candidate => isAvailable(candidate.command)) || null
}

function runCommandLauncher(spawnImpl, command, args, settleMs = 1200) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (succeeded, message) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({
        succeeded,
        requested: succeeded,
        exact: false,
        openedApp: false,
        message: message || null
      })
    }

    let child
    try {
      child = spawnImpl(command, args, { detached: true, stdio: 'ignore' })
    } catch (err) {
      finish(false, String(err && err.message || err))
      return
    }
    child.once('error', err => finish(false, String(err && err.message || err)))
    child.once('exit', (code, signal) => {
      if (code === 0) finish(true, '启动器已接受请求，但未验证目标应用或命令是否已显示。')
      else finish(false, `启动器退出（code=${code == null ? 'null' : code}, signal=${signal || 'none'}）`)
    })
    child.once('spawn', () => {
      child.unref()
      timer = setTimeout(() => {
        finish(true, '启动请求仍在运行，但未验证目标应用或命令是否已显示。')
      }, settleMs)
      if (timer.unref) timer.unref()
    })
  })
}

function platformLaunchSpec(platform, runtimePlatform) {
  if (platform === 'dsh') {
    return { kind: 'external', url: 'http://127.0.0.1:3080/' }
  }

  const commands = {
    codex: {
      darwin: { command: 'open', args: ['-a', 'Codex'] },
      win32: { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start \"\" codex'] },
      linux: { candidates: linuxTerminalCandidates('codex') }
    },
    claude: {
      darwin: { command: 'open', args: ['-a', 'Claude'] },
      win32: { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start \"\" claude'] },
      linux: { candidates: linuxTerminalCandidates('claude') }
    },
    grok: {
      darwin: { command: 'osascript', args: ['-e', 'tell application \"Terminal\" to do script \"grok\"'] },
      win32: { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start \"\" grok'] },
      linux: { candidates: linuxTerminalCandidates('grok') }
    }
  }

  const platformCommands = commands[platform]
  if (!platformCommands) return null
  const key = runtimePlatform === 'darwin' ? 'darwin' : runtimePlatform === 'win32' ? 'win32' : 'linux'
  const spec = platformCommands[key]
  if (!spec) return null
  return spec.candidates ? { kind: 'commandCandidates', candidates: spec.candidates } : { kind: 'command', ...spec }
}

module.exports = {
  failedExternalWakePlan,
  isCodexCLI,
  isTrustedMainFrame,
  mergeDefined,
  pickLaunchCandidate,
  platformLabel,
  rendererSnapshot,
  platformLaunchSpec,
  runCommandLauncher,
  wakePlanForTask
}
