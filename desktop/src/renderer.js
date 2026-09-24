// AllPet 渲染层：精灵图集动画 + 状态气泡。
// 动画行号与帧时长与 Swift AllPetCore 的 PetAnimation 保持一致。
(function () {
  const canvas = document.getElementById('pet')
  const bubble = document.getElementById('bubble')
  const ctx = canvas.getContext('2d')

  // Codex 图集默认为 8 列 × 9/11 行；实际 cell 几何由主进程按当前 PetBundle 下发。
  const COLS = 8
  const CELL_W = 192
  const CELL_H = 208
  const DEFAULT_SCALE = 112 / 192
  // 系统「降低动态效果」：与 macOS reduceMotion 对齐，只播放首帧、冻结 spinner 与轮播。
  const reduceMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  let reduceMotion = !!(reduceMotionQuery && reduceMotionQuery.matches)

  function applyScale(scale) {
    const s = Math.max(0.4, Math.min(1.2, typeof scale === 'number' ? scale : DEFAULT_SCALE))
    const w = Math.min(224, Math.max(80, Math.round(cellW * s)))
    const h = Math.round(w * (cellH / cellW))
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
  }

  const ANIMATIONS = {
    idle:          { row: 0, dur: [1680, 660, 660, 840, 840, 1920] },
    'running-right': { row: 1, dur: [120, 120, 120, 120, 120, 120, 120, 220] },
    'running-left':  { row: 2, dur: [120, 120, 120, 120, 120, 120, 120, 220] },
    waving:        { row: 3, dur: [140, 140, 140, 280] },
    jumping:       { row: 4, dur: [140, 140, 140, 140, 280] },
    failed:        { row: 5, dur: [140, 140, 140, 140, 140, 140, 140, 240] },
    waiting:       { row: 6, dur: [150, 150, 150, 150, 150, 260] },
    running:       { row: 7, dur: [120, 120, 120, 120, 120, 220] },
    review:        { row: 8, dur: [150, 150, 150, 150, 150, 280] }
  }

  let sprite = null // Image
  const petLoadGate = window.latestCommit.createLatestGate()
  let rows = 9
  let cellW = CELL_W
  let cellH = CELL_H
  let seq = null // { frames: [{row,col,dur}], loopStart }
  let frameIndex = 0
  let frameTimer = 0
  let lastTime = 0
  let currentAnimation = null
  let currentSnapshot = null
  let statusAnimation = 'idle'        // 状态动画（快照映射）
  let interactionAnimation = null     // 交互动画（悬停/拖动，优先于状态）

  function buildSequence(name) {
    const a = ANIMATIONS[name] || ANIMATIONS.idle
    if (reduceMotion) {
      return { frames: [{ row: a.row, col: 0, dur: 1e9 }], loopStart: 0 }
    }
    const frames = a.dur.map((d, col) => ({ row: a.row, col, dur: d }))
    if (name === 'idle') return { frames, loopStart: 0 }
    const idle = ANIMATIONS.idle.dur.map((d, col) => ({ row: ANIMATIONS.idle.row, col, dur: d }))
    const repeated = frames.concat(frames, frames)
    return { frames: repeated.concat(idle), loopStart: repeated.length }
  }

  function drawFrame(f) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!sprite) return
    ctx.drawImage(
      sprite,
      f.col * cellW, f.row * cellH, cellW, cellH,
      0, 0, canvas.width, canvas.height
    )
  }

  function drawPlaceholder() {
    // AppKit 在无可用宠物时不绘制替代精灵；若窗口此前存在，只保留透明任务托盘。
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  function tick(now) {
    requestAnimationFrame(tick)
    if (!seq || !sprite) return
    if (!lastTime) lastTime = now
    frameTimer += now - lastTime
    lastTime = now
    const f = seq.frames[frameIndex]
    if (frameTimer >= f.dur) {
      frameTimer = 0
      frameIndex += 1
      if (frameIndex >= seq.frames.length) frameIndex = seq.loopStart
    }
    drawFrame(seq.frames[frameIndex])
  }

  function setAnimation(name, force) {
    if (!force && name === currentAnimation) return
    currentAnimation = name
    seq = buildSequence(name)
    frameIndex = 0
    frameTimer = 0
  }

  function setStatusAnimation(name) {
    statusAnimation = name
    if (interactionAnimation === null) setAnimation(name)
  }

  function setInteractionAnimation(name) {
    interactionAnimation = name
    setAnimation(name || statusAnimation || 'idle')
  }

  // ---- 气泡三阶段（以 macOS TaskTrayView 为唯一行为基准）----

  let bubbleStage = 'collapsed' // collapsed | platforms | tasks
  let selectedPlatform = null
  let rotationIndex = 0
  let rotationTimer = null
  let lastBubbleWidth = -1
  let lastBubbleHeight = -1

  const PLATFORM_ORDER = ['codex', 'claude', 'dsh', 'grok']
  const PLATFORM_COLORS = {
    codex: '#0fa380',
    claude: '#cc6b4d',
    dsh: '#4d6bfa',
    grok: 'var(--grok-color)'
  }

  function labelOf(platform) {
    return { codex: 'Codex', claude: 'Claude Code', dsh: 'DSH', grok: 'Grok' }[platform] || platform
  }

  function phaseRank(phase) {
    return { failed: 0, running: 1, thinking: 1, waiting: 2, idle: 3, done: 4 }[phase] ?? 5
  }

  function platformRank(platform) {
    const rank = PLATFORM_ORDER.indexOf(platform)
    return rank < 0 ? PLATFORM_ORDER.length : rank
  }

  function sortedTasks(tasks) {
    return (tasks || []).slice().sort((a, b) => {
      const phaseDelta = phaseRank(a.phase) - phaseRank(b.phase)
      if (phaseDelta !== 0) return phaseDelta
      return (b.updatedAt || 0) - (a.updatedAt || 0)
    })
  }

  function canonicalTaskID(platform, task) {
    if (task && task.scheduledTaskName) return `${platform}|scheduled:${task.scheduledTaskName}`
    let identity = task && task.sessionID ? task.sessionID : String(task && task.title || '').trim()
    if (platform === 'dsh' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity)) {
      identity = `session-${identity}`
    }
    return `${platform}|${identity || 'current'}`
  }

  function buildData() {
    const snap = currentSnapshot || { platforms: [] }
    const historyMeta = snap.history || {}
    const history = historyMeta.platforms || {}
    const dismissed = new Set(historyMeta.dismissed || [])
    const hidden = new Set(historyMeta.hidden || [])
    const isLiveHidden = (platform, task) => {
      const id = canonicalTaskID(platform, task)
      // 主进程会在同一会话出现新非终态活动时先移除 dismissed；渲染层可直接按 ID 隐藏。
      return hidden.has(id) || dismissed.has(id)
    }

    const groups = (snap.platforms || [])
      .slice()
      .sort((a, b) => platformRank(a.platform) - platformRank(b.platform))
      .map((rawStatus) => {
        const liveTasks = (rawStatus.tasks && rawStatus.tasks.length) ? rawStatus.tasks : (rawStatus.task ? [rawStatus.task] : [])
        const visibleLiveTasks = liveTasks.filter(task => !isLiveHidden(rawStatus.platform, task))
        let status = rawStatus
        if (liveTasks.length > 0 && visibleLiveTasks.length === 0) {
          status = { ...rawStatus, phase: 'idle', phaseLabel: '空闲', detail: '空闲', task: null, tasks: [] }
        } else if (visibleLiveTasks.length !== liveTasks.length) {
          const primary = visibleLiveTasks[0]
          status = { ...rawStatus, phase: primary.phase || rawStatus.phase, task: primary, tasks: visibleLiveTasks }
        }
        return {
          status,
          platform: status.platform,
          label: status.label || labelOf(status.platform),
          tasks: sortedTasks((history[status.platform] || []).filter(task => !dismissed.has(task.id) && !hidden.has(task.id)))
        }
      })

    // 与 AppKit 一致：Stage 1 完成卡片从全部历史生成，不依赖当前快照是否仍含该平台。
    const completed = Object.entries(history)
      .flatMap(([platform, tasks]) => (tasks || []).map(task => ({ ...task, platform: task.platform || platform })))
      .filter(task => task.phase === 'done' && !dismissed.has(task.id) && !hidden.has(task.id))
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))

    const unfinished = groups.map((group) => {
      const task = group.tasks.find(item => item.phase !== 'done')
      if (task) return { ...task, platform: group.platform }
      const primary = group.status && group.status.task
      const hasStableIdentity = primary && (primary.sessionID || primary.scheduledTaskName)
      if (group.status && group.status.phase !== 'idle' && group.status.phase !== 'done' && hasStableIdentity) {
        return {
          id: canonicalTaskID(group.platform, primary),
          platform: group.platform,
          sessionDisplayName: primary.sessionName || primary.title || '未命名会话',
          action: primary.action || group.status.detail || '',
          progress: primary.progressLabel,
          phase: primary.phase || group.status.phase
        }
      }
      return null
    }).filter(Boolean)

    const hasNotification = completed.length > 0
      || unfinished.length > 0
      || groups.some(group => group.tasks.length > 0 || (
        group.status.phase !== 'idle'
        && group.status.phase !== 'done'
        && group.status.phase !== 'failed'
        && group.status.task
        && (group.status.task.sessionID || group.status.task.scheduledTaskName)
      ))

    return { groups, completed, unfinished, hasNotification }
  }

  function displayName(item) {
    if (item.sessionDisplayName) return item.sessionDisplayName
    if (item.scheduledTaskName) return `定时任务 · ${item.scheduledTaskName}`
    if (item.sessionName && item.sessionName.trim()) return item.sessionName.trim()
    if (item.sessionID) {
      const value = item.sessionID.startsWith('session-') ? item.sessionID.slice(8) : item.sessionID
      return `会话 ${String(value).slice(0, 8)}`
    }
    return '未命名会话'
  }

  function platformColor(platform) {
    return PLATFORM_COLORS[platform] || '#8e8e93'
  }

  function statusIndicator(phase) {
    const indicator = document.createElement('span')
    indicator.className = `status-indicator ${phase || 'idle'}`
    indicator.setAttribute('aria-label', phase || 'idle')
    return indicator
  }

  function dismissButton(kind, value) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'bc-dismiss'
    button.dataset.dismiss = kind
    button.dataset.value = value || ''
    button.setAttribute('aria-label', '关闭')
    button.textContent = '×'
    return button
  }

  function compactCard(item, options) {
    const opts = options || {}
    const card = document.createElement('div')
    card.className = 'bubble-card compact-card'
    card.dataset.kind = opts.kind || 'open-platforms'
    card.dataset.platform = item.platform || ''
    if (item.id) card.dataset.id = item.id

    const platform = document.createElement('div')
    platform.className = 'compact-platform'
    platform.style.color = platformColor(item.platform)
    platform.textContent = labelOf(item.platform)
    card.appendChild(platform)

    const title = document.createElement('div')
    title.className = 'compact-title'
    title.textContent = displayName(item)
    card.appendChild(title)
    card.appendChild(statusIndicator(item.phase))

    if (opts.dismiss && item.id) card.appendChild(dismissButton('task', item.id))
    return card
  }

  function taskCard(item) {
    const card = document.createElement('div')
    card.className = 'bubble-card task-card'
    card.dataset.kind = 'task'
    card.dataset.platform = item.platform || ''
    card.dataset.id = item.id || ''

    const title = document.createElement('div')
    title.className = 'task-title'
    const platform = document.createElement('span')
    platform.className = 'task-platform'
    platform.style.color = platformColor(item.platform)
    platform.textContent = labelOf(item.platform)
    const separator = document.createElement('span')
    separator.className = 'task-separator'
    separator.textContent = ' － '
    const name = document.createElement('span')
    name.textContent = displayName(item)
    title.append(platform, separator, name)
    card.appendChild(title)

    const subtitle = document.createElement('div')
    subtitle.className = 'task-subtitle'
    subtitle.textContent = [item.progress, item.action].filter(Boolean).join(' · ') || '暂无任务详情'
    card.appendChild(subtitle)

    card.appendChild(statusIndicator(item.phase))
    const arrow = document.createElement('span')
    arrow.className = 'task-arrow'
    arrow.textContent = '›'
    card.appendChild(arrow)
    if (item.id) card.appendChild(dismissButton('task', item.id))
    return card
  }

  function stageHeader(platform) {
    const header = document.createElement('div')
    header.className = 'bc-stage-header'

    if (platform) {
      const back = document.createElement('button')
      back.type = 'button'
      back.className = 'bc-back'
      back.dataset.back = 'platforms'
      back.setAttribute('aria-label', '返回平台任务')
      back.textContent = '‹'
      header.appendChild(back)

      const title = document.createElement('div')
      title.className = 'bc-stage-title'
      const platformName = document.createElement('span')
      platformName.style.color = platformColor(platform)
      platformName.textContent = labelOf(platform)
      title.appendChild(platformName)
      title.appendChild(document.createTextNode(' 的任务'))
      header.appendChild(title)
    } else {
      const title = document.createElement('div')
      title.className = 'bc-stage-title'
      title.textContent = '平台任务'
      header.appendChild(title)
    }

    const collapse = document.createElement('button')
    collapse.type = 'button'
    collapse.className = 'bc-collapse'
    collapse.dataset.back = 'collapsed'
    collapse.textContent = '收起'
    header.appendChild(collapse)
    return header
  }

  function platformGroup(group) {
    const tasks = group.tasks.slice(0, 5)
    const rows = Math.min(group.tasks.length, 5)
    const height = rows <= 1 ? 58 : Math.max(58, 29 + rows * 14)
    const card = document.createElement('div')
    card.className = 'bubble-card platform-group'
    card.style.height = `${height}px`
    card.dataset.kind = 'platform'
    card.dataset.platform = group.platform

    const title = document.createElement('div')
    title.className = 'platform-group-title'
    const name = document.createElement('span')
    name.style.color = platformColor(group.platform)
    name.textContent = group.label
    title.appendChild(name)
    if (group.tasks.length > 5) {
      const count = document.createElement('span')
      count.className = 'platform-group-count'
      count.textContent = ` +${group.tasks.length - 5}`
      title.appendChild(count)
    }
    card.appendChild(title)

    const list = document.createElement('div')
    list.className = 'platform-task-list'
    if (tasks.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'platform-task-empty'
      empty.textContent = '暂无会话 · 点击打开'
      list.appendChild(empty)
    } else {
      for (const task of tasks) {
        const row = document.createElement('div')
        row.className = 'platform-task-row'
        const dot = document.createElement('span')
        dot.className = `platform-task-dot ${task.phase || 'idle'}`
        const text = document.createElement('span')
        text.textContent = displayName(task)
        row.append(dot, text)
        list.appendChild(row)
      }
    }
    card.appendChild(list)
    card.appendChild(statusIndicator(tasks[0] ? tasks[0].phase : group.status.phase))
    if (group.tasks.length > 0) card.appendChild(dismissButton('platform', group.platform))
    return card
  }

  function fallbackBubbles(data) {
    return data.groups.filter(group => {
      const primary = group.status.task || {}
      return group.status.phase === 'idle' || primary.sessionID || primary.scheduledTaskName
    }).map((group) => {
      const primary = group.status.task || {}
      return {
        id: primary.sessionID || primary.scheduledTaskName ? canonicalTaskID(group.platform, primary) : null,
        platform: group.platform,
        sessionID: primary.sessionID,
        scheduledTaskName: primary.scheduledTaskName,
        sessionDisplayName: primary.sessionName || primary.title || (group.status.phase === 'idle' ? '暂无会话' : '未命名会话'),
        action: primary.action || group.status.detail || '',
        phase: primary.phase || group.status.phase
      }
    })
  }

  function renderCollapsed(data) {
    const completed = data.completed.slice(-3)
    if (data.completed.length > 3) {
      const count = document.createElement('div')
      count.className = 'bc-count completed-count'
      count.textContent = `+${data.completed.length - 3} 个已完成`
      bubble.appendChild(count)
    }

    for (const task of completed) {
      bubble.appendChild(compactCard(task, { kind: 'task', dismiss: true }))
    }

    let stackItems = data.unfinished
    if (stackItems.length === 0 && completed.length === 0) stackItems = fallbackBubbles(data)
    if (stackItems.length === 0) return
    rotationIndex %= stackItems.length

    const stack = document.createElement('div')
    const visibleCount = Math.min(3, stackItems.length)
    stack.className = `platform-stack visible-${visibleCount}`
    stack.dataset.kind = 'open-platforms'
    stack.style.height = `${stackItems.length > 1 ? 78 : 58}px`

    for (let depth = visibleCount - 1; depth >= 0; depth -= 1) {
      const index = (rotationIndex + depth) % stackItems.length
      const item = stackItems[index]
      const reveal = depth === 0 ? 0 : (visibleCount === 2 ? 18 : depth * 9)
      const inset = depth * 5
      const card = compactCard(item, { kind: 'open-platforms', dismiss: depth === 0 })
      card.classList.add('stack-card')
      card.style.left = `${inset}px`
      card.style.top = `${reveal}px`
      card.style.width = `calc(100% - ${inset * 2}px)`
      card.style.opacity = depth === 0 ? '1' : String(Math.max(0.70, 0.88 - depth * 0.09))
      card.style.zIndex = String(visibleCount - depth)
      if (depth !== 0) card.style.pointerEvents = 'none'
      stack.appendChild(card)
    }
    bubble.appendChild(stack)
  }

  function renderPlatforms(data) {
    bubble.appendChild(stageHeader(null))
    for (const group of data.groups.slice(0, 4)) bubble.appendChild(platformGroup(group))
  }

  function renderTasks(data) {
    const group = data.groups.find(item => item.platform === selectedPlatform) || data.groups[0]
    if (!group) return
    selectedPlatform = group.platform
    bubble.appendChild(stageHeader(group.platform))
    const tasks = group.tasks.slice(0, 6)
    if (tasks.length === 0) {
      const primary = group.status.task || {}
      bubble.appendChild(taskCard({
        id: '',
        platform: group.platform,
        sessionDisplayName: primary.sessionName || primary.title || '未命名会话',
        action: primary.action || group.status.detail || '点击打开平台',
        phase: primary.phase || group.status.phase
      }))
    } else {
      for (const task of tasks) bubble.appendChild(taskCard({ ...task, platform: group.platform }))
    }
    if (group.tasks.length > tasks.length) {
      const count = document.createElement('div')
      count.className = 'bc-count task-count'
      count.textContent = `+${group.tasks.length - tasks.length} 个任务`
      bubble.appendChild(count)
    }
  }

  function reportBubbleSize() {
    if (!window.petAPI || !window.petAPI.resizeForBubble) return
    requestAnimationFrame(() => {
      const hidden = bubble.classList.contains('hidden')
      const rect = hidden ? { width: 0, height: 0 } : bubble.getBoundingClientRect()
      const width = Math.max(0, Math.ceil(rect.width || 0))
      const height = Math.max(0, Math.ceil(rect.height || 0))
      if (width === lastBubbleWidth && height === lastBubbleHeight) return
      lastBubbleWidth = width
      lastBubbleHeight = height
      window.petAPI.resizeForBubble(width, height)
    })
  }

  function syncRotationTimer(data) {
    const motion = window.petMotion.plan({
      reduceMotion,
      stageIsCollapsed: bubbleStage === 'collapsed',
      hasActiveTask: data.unfinished.some(item => item.phase === 'running' || item.phase === 'thinking'),
      unfinishedPlatformCount: data.unfinished.length
    })
    const needsRotation = motion.rotatesPlatforms
    if (needsRotation && !rotationTimer) {
      rotationTimer = setInterval(() => {
        const latest = buildData()
        if (bubbleStage !== 'collapsed' || latest.unfinished.length <= 1) return
        rotationIndex = (rotationIndex + 1) % latest.unfinished.length
        renderBubble()
      }, 3200)
    } else if (!needsRotation && rotationTimer) {
      clearInterval(rotationTimer)
      rotationTimer = null
    }
  }

  function renderBubble(providedData) {
    const data = providedData || buildData()
    if (!data.hasNotification) {
      bubbleStage = 'collapsed'
      selectedPlatform = null
      rotationIndex = 0
      bubble.replaceChildren()
      bubble.className = 'hidden'
      syncRotationTimer(data)
      reportBubbleSize()
      return
    }

    if (bubbleStage === 'tasks' && !data.groups.some(group => group.platform === selectedPlatform)) {
      bubbleStage = 'platforms'
      selectedPlatform = null
    }

    bubble.replaceChildren()
    bubble.className = `stage-${bubbleStage}`
    if (bubbleStage === 'collapsed') renderCollapsed(data)
    else if (bubbleStage === 'platforms') renderPlatforms(data)
    else renderTasks(data)
    syncRotationTimer(data)
    bubble.dataset.reduceMotion = String(reduceMotion)
    bubble.dataset.rotationIndex = String(rotationIndex)
    reportBubbleSize()
  }

  function applyMotionPreference(nextReduceMotion) {
    if (reduceMotion === nextReduceMotion) return
    reduceMotion = nextReduceMotion
    if (reduceMotion) rotationIndex = 0
    setAnimation(interactionAnimation || statusAnimation || 'idle', true)
    renderBubble()
  }

  if (reduceMotionQuery) {
    const onMotionChange = event => applyMotionPreference(!!event.matches)
    if (typeof reduceMotionQuery.addEventListener === 'function') reduceMotionQuery.addEventListener('change', onMotionChange)
    else if (typeof reduceMotionQuery.addListener === 'function') reduceMotionQuery.addListener(onMotionChange)
  }

  function setStage(stage, platform) {
    bubbleStage = stage
    selectedPlatform = stage === 'tasks' ? platform : null
    renderBubble()
  }

  function launchPlatform(platform) {
    if (window.petAPI && window.petAPI.launchPlatform) window.petAPI.launchPlatform(platform)
    setStage('collapsed')
  }

  async function wakeTask(id, platform) {
    if (id && window.petAPI && window.petAPI.wakeTask) {
      try {
        const result = await window.petAPI.wakeTask(id)
        if (result && result.succeeded) setStage('collapsed')
      } catch (_) {}
      return
    }
    launchPlatform(platform)
  }

  function onPlatformClick(platform) {
    const group = buildData().groups.find(item => item.platform === platform)
    if (!group) return
    if (group.tasks.length === 0) {
      const task = group.status && group.status.task
      const hasStableIdentity = task && (task.sessionID || task.scheduledTaskName)
      if (group.status.phase !== 'idle' && !hasStableIdentity) return
      launchPlatform(platform)
    } else if (group.tasks.length === 1) {
      wakeTask(group.tasks[0].id, platform)
    } else {
      setStage('tasks', platform)
    }
  }

  bubble.addEventListener('click', (event) => {
    const dismiss = event.target.closest('[data-dismiss]')
    if (dismiss) {
      event.stopPropagation()
      const kind = dismiss.dataset.dismiss
      const value = dismiss.dataset.value
      if (kind === 'task' && window.petAPI && window.petAPI.dismissTask) window.petAPI.dismissTask(value)
      if (kind === 'platform' && window.petAPI && window.petAPI.dismissPlatform) {
        window.petAPI.dismissPlatform(value)
        setStage('collapsed')
      }
      return
    }

    const back = event.target.closest('[data-back]')
    if (back) {
      event.stopPropagation()
      setStage(back.dataset.back)
      return
    }

    const target = event.target.closest('[data-kind]')
    if (!target) return
    const kind = target.dataset.kind
    if (kind === 'open-platforms') setStage('platforms')
    else if (kind === 'platform') onPlatformClick(target.dataset.platform)
    else if (kind === 'task') wakeTask(target.dataset.id, target.dataset.platform)
  })

  function onPet(payload) {
    const isLatest = petLoadGate.begin()
    if (!payload || !payload.ok) {
      sprite = null
      cellW = CELL_W
      cellH = CELL_H
      rows = 9
      canvas.width = cellW
      canvas.height = cellH
      applyScale(payload && payload.scale)
      drawPlaceholder()
      return
    }
    const img = new Image()
    img.onload = () => {
      if (!isLatest()) return
      const atlas = window.petAtlas.validatedAtlas(payload, img.naturalWidth, img.naturalHeight)
      if (!atlas.ok) {
        sprite = null
        cellW = CELL_W
        cellH = CELL_H
        canvas.width = cellW
        canvas.height = cellH
        applyScale(payload.scale)
        drawPlaceholder()
        return
      }
      sprite = img
      rows = atlas.rows
      cellW = atlas.cellWidth
      cellH = atlas.cellHeight
      canvas.width = Math.round(cellW)
      canvas.height = Math.round(cellH)
      applyScale(payload.scale)
      // 首次载入后按当前快照设定动画（无快照则 idle）。
      setStatusAnimation(statusAnimation || 'idle')
    }
    img.onerror = () => {
      if (!isLatest()) return
      sprite = null
      cellW = CELL_W
      cellH = CELL_H
      canvas.width = cellW
      canvas.height = cellH
      applyScale(payload.scale)
      drawPlaceholder()
    }
    img.src = payload.spritesheet
  }

  function onSnapshot(snap) {
    currentSnapshot = snap
    const data = buildData()
    const visibleAnimation = window.petMotion.animationForStatuses(data.groups.map(group => group.status))
    setStatusAnimation(visibleAnimation)
    renderBubble(data)
  }

  // ---- 精灵交互（对齐 macOS SpriteView：悬停 jumping、拖动 running、点击展开）----

  let dragging = false
  let dragStart = null
  let didDrag = false
  let pointerInside = false

  canvas.addEventListener('mouseenter', () => {
    pointerInside = true
    if (!dragging) setInteractionAnimation('jumping')
  })
  canvas.addEventListener('mouseleave', () => {
    pointerInside = false
    if (!dragging) setInteractionAnimation(null)
  })

  canvas.addEventListener('mousedown', (e) => {
    dragging = true
    didDrag = false
    dragStart = { x: e.screenX, y: e.screenY }
    if (window.petAPI && window.petAPI.dragStart) window.petAPI.dragStart(e.screenX, e.screenY)
  })

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const dx = e.screenX - dragStart.x
    const dy = e.screenY - dragStart.y
    const next = window.petInteraction.dragMove(dx, dy, didDrag)
    if (!next.didDrag) return
    didDrag = true
    if (window.petAPI && window.petAPI.dragMove) window.petAPI.dragMove(e.screenX, e.screenY)
    setInteractionAnimation(next.animation)
  })

  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    if (window.petAPI && window.petAPI.dragEnd) window.petAPI.dragEnd()
    const release = window.petInteraction.dragRelease(didDrag, pointerInside)
    setInteractionAnimation(release.animation)
    if (release.openPlatforms) {
      // 点击精灵：展开到 Stage 2（与 macOS showPlatformStage 一致）。
      setStage('platforms')
    }
    dragStart = null
    didDrag = false
  })

  if (window.petAPI) {
    window.petAPI.onPet(onPet)
    window.petAPI.onSnapshot(onSnapshot)
    window.petAPI.onScaleChanged((scale) => applyScale(scale))
    window.petAPI.onCollapseBubble(() => {
      if (bubbleStage !== 'collapsed') setStage('collapsed')
    })
    window.petAPI.onDebugBubble((payload) => {
      if (!payload || !payload.snapshot) return
      onSnapshot(payload.snapshot)
      const stage = ['collapsed', 'platforms', 'tasks'].includes(payload.stage) ? payload.stage : 'collapsed'
      setStage(stage, stage === 'tasks' ? (payload.platform || 'codex') : null)
    })
    window.petAPI.onWatchError((msg) => {
      bubble.className = 'stage-collapsed'
      bubble.textContent = '监控异常：' + msg
      reportBubbleSize()
    })
  } else {
    drawPlaceholder()
  }

  requestAnimationFrame(tick)
})()
