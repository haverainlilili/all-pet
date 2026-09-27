'use strict'

const { cliTask } = require('./terminal/process')
const { dshSessionURL } = require('./dsh-wake')

const { PLATFORMS, PLATFORM_KEYS } = require('./platforms')
const PLATFORM_LABELS = Object.fromEntries(PLATFORMS.map(row => [row.key, row.label]))

function platformLabel(platform) {
  return PLATFORM_LABELS[platform] || platform || '平台'
}

function isCodexCLI(task) {
  return task && task.launchOrigin !== 'codex-desktop' && (
    task.launchOrigin === 'codex-cli'
    || Boolean(task.terminalTTY)
    || Boolean(task.terminalBinding && task.terminalBinding.tty)
  )
}

/**
 * 根据可验证的来源生成唤起计划；请求接受不等于原会话已显示。
 * 终态通知的点击确认独立于定位结果。
 */
function failedExternalWakePlan(task, errorMessage) {
  return {
    kind: 'fallback',
    platform: task && task.platform || null,
    canOpenPlatform: false,
    message: `无法发送原会话深链：${errorMessage}。未打开应用首页，任务卡片已保留。`
  }
}

function wakePlanForTask(task, runtimePlatform = process.platform) {
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

  if (cliTask(task)) return { kind: 'terminal', platform, canOpenPlatform: false }

  if (platform === 'dsh' && sessionID) {
    return {
      kind: 'external',
      platform,
      url: dshSessionURL(sessionID),
      message: null
    }
  }

  if (platform === 'codex' && sessionID && launchOrigin === 'codex-desktop' && !isCodexCLI(task)) {
    return {
      kind: 'external',
      platform,
      url: `codex://threads/${encodeURIComponent(sessionID)}`,
      message: null
    }
  }

  if (platform === 'claude' && runtimePlatform === 'darwin' && sessionID && (
    launchOrigin === 'claude-desktop-3p' || sessionID.startsWith('local_')
  )) {
    return {
      kind: 'application',
      platform,
      command: '/usr/bin/open',
      args: ['-b', 'com.anthropic.claudefordesktop'],
      exact: false,
      message: '已向 Claude Desktop 发送激活请求；该应用没有公开的原会话深链，请在侧栏选择对应会话。任务卡片会继续保留。'
    }
  }

  if (['cursor', 'workbuddy', 'qoder', 'zcode'].includes(platform)) {
    const names = { cursor: 'Cursor', workbuddy: 'WorkBuddy', qoder: 'Qoder', zcode: 'ZCode' }
    const message = `已请求打开 ${label}，请在会话列表选择对应会话；未验证原会话已显示。`
    if (runtimePlatform === 'darwin') return { kind: 'application', platform, command: '/usr/bin/open', args: ['-a', names[platform]], exact: false, message }
    return { kind: 'fallback', platform, canOpenPlatform: true,
      message: `${label} 没有经过验证的原会话跳转接口，可选择打开平台后从会话列表查看。` }
  }

  const messages = {
    codex: isCodexCLI(task)
      ? '这是 Codex CLI 任务；Electron 无法安全聚焦此前的终端标签页。为避免创建重复任务，不会启动新的 Codex 进程，任务卡片会继续保留。'
      : '缺少可验证的 Codex Desktop 来源或会话标识，未发送深链、未打开应用首页。',
    claude: 'Claude Desktop 没有公开的“聚焦现有会话”深链，Claude CLI 也无法跨平台安全聚焦此前终端。为避免创建会话副本，不会启动新的 Claude 进程，任务卡片会继续保留。',
    dsh: '缺少可定位的 DSH 会话标识，未打开可能显示其它会话的首页。',
    pi: '未能定位原 pi 终端标签页，请在现有终端中查看该会话；不会自动重跑任务。',
    grok: 'Electron 无法跨平台安全聚焦此前的 Grok 终端标签页。为避免创建重复任务，不会启动新的 Grok 进程，任务卡片会继续保留。'
  }

  return {
    kind: 'fallback',
    platform,
    canOpenPlatform: false,
    message: messages[platform] || `无法安全定位到原 ${label} 任务，任务卡片会继续保留。`
  }
}

function withTaskAcknowledgement(result, acknowledged) {
  if (!acknowledged) return result
  const acknowledgement = '已确认该任务通知，气泡已移除。'
  const message = String(result.message || '')
    .replace(/，?任务卡片(?:会继续保留|已保留)。/g, value => value.startsWith('，') ? '。' : '')
  return {
    ...result,
    acknowledged: true,
    message: message.includes(acknowledgement) ? message : `${message}${acknowledgement}`
  }
}

/**
 * 点击任一平台终态通知即确认已读，确认与能否聚焦原会话相互独立。
 * 必须在第一个异步操作之前确认，避免唤起结束后误删同一会话的新一轮任务。
 * 唤起结果不会重复确认，避免误清除同会话的新一轮任务。
 */
async function performTaskWake(task, {
  runtimePlatform = process.platform,
  dismissTerminalTask,
  launchApplication,
  openExternal,
  reuseDSHTab,
  focusTerminal,
  presentFallback
}) {
  const terminal = task && (task.phase === 'done' || task.phase === 'failed')
  const acknowledged = Boolean(task && PLATFORM_KEYS.has(task.platform) && terminal && dismissTerminalTask(task))
  const fallback = async plan => withTaskAcknowledgement(
    await presentFallback(withTaskAcknowledgement(plan, acknowledged), task), acknowledged
  )
  const plan = wakePlanForTask(task, runtimePlatform)
  if (plan.kind !== 'external' && plan.kind !== 'application' && plan.kind !== 'terminal') return fallback(plan)

  try {
    if (plan.kind === 'terminal') {
      const result = focusTerminal ? await focusTerminal(task) : { succeeded: false, message: '终端接入尚未就绪，不会启动新的终端进程，任务卡片会继续保留。' }
      if (result.succeeded && result.exact) return withTaskAcknowledgement(result, acknowledged)
      return fallback({ kind: 'fallback', platform: task.platform, canOpenPlatform: false, message: result.message })
    }
    if (plan.kind === 'application') {
      const opened = await launchApplication(plan.command, plan.args)
      if (!opened.succeeded) {
        return fallback({
          kind: 'fallback', platform: task.platform, canOpenPlatform: false,
          message: `无法唤起 ${platformLabel(task.platform)}：${opened.message || '启动请求失败'}。任务卡片已保留。`
        })
      }
      return withTaskAcknowledgement({
        ...opened,
        exact: false,
        openedApp: opened.succeeded,
        message: plan.message
      }, acknowledged)
    }

    let reused = false
    if (task.platform === 'dsh' && runtimePlatform === 'darwin') {
      const result = await reuseDSHTab(plan.url)
      if (result.status === 'reused') reused = true
      else if (result.status === 'blocked' || result.status === 'error') {
        return fallback({
          kind: 'fallback', platform: 'dsh', canOpenPlatform: false,
          message: `${result.message || '无法控制已有 DSH 标签页'}。为避免重复窗口，未打开新页面。`
        })
      }
    }
    if (!reused) await openExternal(plan.url)
    if (terminal && !acknowledged) dismissTerminalTask(task)
    return withTaskAcknowledgement({
      succeeded: true,
      requested: true,
      exact: reused,
      openedApp: !reused,
      message: reused ? '已复用现有 DSH 标签页并切换到原会话。' : '已发送原会话跳转请求。'
    }, acknowledged)
  } catch (err) {
    return fallback(failedExternalWakePlan(task, String(err && err.message || err)))
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

  const desktopNames = { cursor: 'Cursor', workbuddy: 'WorkBuddy', qoder: 'Qoder', zcode: 'ZCode' }
  if (desktopNames[platform]) {
    if (runtimePlatform === 'darwin') return { kind: 'command', command: '/usr/bin/open', args: ['-a', desktopNames[platform]] }
    if (runtimePlatform === 'win32') return { kind: 'command', command: 'cmd.exe', args: ['/d', '/s', '/c', `start "" ${desktopNames[platform]}`] }
    return { kind: 'command', command: platform, args: [] }
  }
  if (platform === 'pi') {
    if (runtimePlatform === 'linux') return { kind: 'commandCandidates', candidates: linuxTerminalCandidates('pi') }
    if (runtimePlatform === 'win32') return { kind: 'command', command: 'cmd.exe', args: ['/d', '/s', '/c', 'start "" pi'] }
    return null
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
  performTaskWake,
  runCommandLauncher,
  wakePlanForTask
}
