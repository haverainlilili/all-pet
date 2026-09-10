// AllPet 渲染层：精灵图集动画 + 状态气泡。
// 动画行号与帧时长与 Swift AllPetCore 的 PetAnimation 保持一致。
(function () {
  const canvas = document.getElementById('pet')
  const bubble = document.getElementById('bubble')
  const ctx = canvas.getContext('2d')

  // Codex 图集：8 列，cell 192×208（v1=9 行，v2=11 行，cell 高度固定 208）。
  const COLS = 8
  const CELL_W = 192
  const CELL_H = 208
  const DEFAULT_SCALE = 112 / 192
  // 系统「降低动态效果」：与 macOS reduceMotion 对齐，只播放首帧。
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  function applyScale(scale) {
    const s = Math.max(0.4, Math.min(1.2, typeof scale === 'number' ? scale : DEFAULT_SCALE))
    const w = Math.min(224, Math.max(80, Math.round(CELL_W * s)))
    const h = Math.round(w * (CELL_H / CELL_W))
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
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.font = '72px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('🐾', canvas.width / 2, canvas.height / 2)
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

  function setAnimation(name) {
    if (name === currentAnimation) return
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

  // ---- 气泡三阶段（对齐 macOS TaskTrayView：collapsed / platforms / tasks）----

  let stage = 'collapsed' // 'collapsed' | 'platforms' | 'tasks'
  let stagePlatform = null
  let bubbleData = null
  let lastReportedBubbleHeight = -1

  const PLATFORM_LABELS = { codex: 'Codex', claude: 'Claude Code', dsh: 'DSH', grok: 'Grok' }
  const PLATFORM_COLORS = { codex: '#0a84ff', claude: '#ff9f0a', dsh: '#30d158', grok: '#bf5af2' }

  function platformLabel(p) { return PLATFORM_LABELS[p] || p }
  function platformColor(p) { return PLATFORM_COLORS[p] || '#8e8e93' }

  function sessionDisplayNameOf(t) {
    if (t.scheduledTaskName) return '定时任务 · ' + t.scheduledTaskName
    if (t.sessionName && t.sessionName.trim()) return t.sessionName.trim()
    if (t.sessionID) {
      const v = t.sessionID.indexOf('session-') === 0 ? t.sessionID.slice(8) : t.sessionID
      return '会话 ' + String(v).slice(0, 8)
    }
    return '未命名会话'
  }

  function reportBubbleHeight() {
    if (!window.petAPI || !window.petAPI.resizeForBubble) return
    const h = bubble.classList.contains('hidden') ? 0 : Math.ceil(bubble.offsetHeight)
    if (h === lastReportedBubbleHeight) return
    lastReportedBubbleHeight = h
    window.petAPI.resizeForBubble(h)
  }

  function buildBubbleData(snap) {
    const history = (snap.history && snap.history.platforms) || {}
    const dismissed = (snap.history && snap.history.dismissed) || []
    const current = snap.platforms || []

    // 完成/失败任务（未 dismiss），跨平台，最新在前。
    const completed = []
    for (const [platform, list] of Object.entries(history)) {
      for (const item of list) {
        if (item.phase === 'done' || item.phase === 'failed') {
          if (dismissed.includes(item.id)) continue
          completed.push(Object.assign({}, item, { platform }))
        }
      }
    }
    completed.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))

    // 未完成平台：当前非 idle/done/failed。
    const unfinished = current.filter(p => p.phase !== 'idle' && p.phase !== 'done' && p.phase !== 'failed')

    // 平台卡片（Stage 2）：当前平台 + 该平台历史任务（未 dismiss）。
    const platforms = current.map(p => {
      const tasks = (history[p.platform] || []).filter(t => !dismissed.includes(t.id))
      return Object.assign({}, p, { tasks })
    })

    return {
      completed,
      unfinished,
      platforms,
      hasNotification: completed.length > 0 || unfinished.length > 0
    }
  }

  function buildCard(item, opts) {
    const o = opts || {}
    const card = document.createElement('div')
    card.className = 'bubble-card'
    card.dataset.platform = item.platform
    if (o.kind === 'platform') card.dataset.kind = 'platform'
    else if (item.id) card.dataset.id = item.id

    const header = document.createElement('div')
    header.className = 'bc-header'
    const pname = document.createElement('span')
    pname.className = 'bc-platform'
    pname.textContent = platformLabel(item.platform)
    pname.style.color = platformColor(item.platform)
    header.appendChild(pname)
    const status = document.createElement('span')
    status.className = 'bc-status ' + (item.phase || 'idle')
    header.appendChild(status)
    card.appendChild(header)

    const title = document.createElement('div')
    title.className = 'bc-title'
    title.textContent = item.sessionDisplayName || sessionDisplayNameOf(item)
    card.appendChild(title)

    if (o.showAction && item.action) {
      const action = document.createElement('div')
      action.className = 'bc-action'
      action.textContent = item.action
      card.appendChild(action)
    }

    if (o.dismiss) {
      const x = document.createElement('button')
      x.className = 'bc-dismiss'
      x.textContent = '×'
      x.dataset.kind = o.dismiss // 'task' | 'platform'
      x.title = o.dismiss === 'platform' ? '清除该平台' : '清除该任务'
      card.appendChild(x)
    }
    return card
  }

  function renderBubble() {
    if (!bubbleData || !bubbleData.hasNotification) {
      bubble.classList.add('hidden')
      bubble.innerHTML = ''
      reportBubbleHeight()
      return
    }
    bubble.classList.remove('hidden')
    bubble.innerHTML = ''
    if (stage === 'platforms') renderStage2()
    else if (stage === 'tasks') renderStage3(stagePlatform)
    else renderStage1()
    reportBubbleHeight()
  }

  function renderStage1() {
    const d = bubbleData
    const completed = d.completed.slice(0, 3)
    for (const item of completed) {
      bubble.appendChild(buildCard(item, { showAction: true, dismiss: 'task' }))
    }
    if (d.completed.length > 3) {
      const more = document.createElement('div')
      more.className = 'bc-count'
      more.textContent = `+${d.completed.length - 3} 个已完成`
      bubble.appendChild(more)
    }
    for (const p of d.unfinished.slice(0, 3)) {
      const t = p.task || {}
      bubble.appendChild(buildCard({
        id: p.platform + '|current',
        platform: p.platform,
        phase: p.phase,
        action: t.action || p.detail || '',
        sessionName: t.sessionName,
        sessionID: t.sessionID,
        scheduledTaskName: t.scheduledTaskName
      }, { showAction: true, kind: 'platform' }))
    }
  }

  function renderStage2() {
    const header = document.createElement('div')
    header.className = 'bc-stage-header'
    const title = document.createElement('span')
    title.textContent = '平台任务'
    header.appendChild(title)
    const close = document.createElement('button')
    close.className = 'bc-back'
    close.textContent = '收起'
    close.dataset.back = 'collapsed'
    header.appendChild(close)
    bubble.appendChild(header)

    for (const p of bubbleData.platforms.slice(0, 4)) {
      const t = p.task || {}
      bubble.appendChild(buildCard({
        id: p.platform + '|current',
        platform: p.platform,
        phase: p.phase,
        action: t.action || p.detail || '',
        sessionName: t.sessionName,
        sessionID: t.sessionID,
        scheduledTaskName: t.scheduledTaskName,
        taskCount: p.tasks ? p.tasks.length : 0
      }, { kind: 'platform', dismiss: 'platform' }))
    }
  }

  function renderStage3(platform) {
    const p = bubbleData.platforms.find(x => x.platform === platform)
    const header = document.createElement('div')
    header.className = 'bc-stage-header'
    const title = document.createElement('span')
    title.textContent = platformLabel(platform) + ' 的任务'
    header.appendChild(title)
    const back = document.createElement('button')
    back.className = 'bc-back'
    back.textContent = '返回'
    back.dataset.back = 'platforms'
    header.appendChild(back)
    bubble.appendChild(header)

    const tasks = p ? p.tasks.slice(0, 6) : []
    for (const item of tasks) {
      bubble.appendChild(buildCard(item, { showAction: true, dismiss: 'task' }))
    }
    if (p && p.tasks.length > 6) {
      const more = document.createElement('div')
      more.className = 'bc-count'
      more.textContent = `+${p.tasks.length - 6} 个任务`
      bubble.appendChild(more)
    }
  }

  function setStage(next, platform) {
    stage = next
    stagePlatform = platform || null
    renderBubble()
  }

  function onPlatformClick(platform) {
    const p = bubbleData.platforms.find(x => x.platform === platform)
    const tasks = p ? p.tasks : []
    if (!tasks.length) {
      if (window.petAPI.launchPlatform) window.petAPI.launchPlatform(platform)
      setStage('collapsed')
    } else if (tasks.length === 1) {
      if (window.petAPI.launchPlatform) window.petAPI.launchPlatform(platform)
    } else {
      setStage('tasks', platform)
    }
  }

  // 气泡点击委托：× 删除；返回/收起；平台卡片；任务卡片（唤醒）。
  bubble.addEventListener('click', (e) => {
    const dismiss = e.target.closest('.bc-dismiss')
    if (dismiss) {
      const card = dismiss.closest('.bubble-card')
      if (!card) return
      if (dismiss.dataset.kind === 'platform') {
        if (window.petAPI.dismissPlatform) window.petAPI.dismissPlatform(card.dataset.platform)
      } else if (card.dataset.id) {
        if (window.petAPI.dismissTask) window.petAPI.dismissTask(card.dataset.id)
      }
      return
    }
    const back = e.target.closest('.bc-back')
    if (back) {
      setStage(back.dataset.back === 'platforms' ? 'platforms' : 'collapsed')
      return
    }
    const card = e.target.closest('.bubble-card')
    if (!card) return
    if (card.dataset.kind === 'platform') {
      onPlatformClick(card.dataset.platform)
    } else if (card.dataset.id) {
      const platform = card.dataset.platform
      if (window.petAPI.launchPlatform) window.petAPI.launchPlatform(platform)
    }
  })

  function updateBubble(snap) {
    bubbleData = buildBubbleData(snap)
    if (!bubbleData.hasNotification) {
      // 全部空闲：收起回 Stage 1（与 macOS collapseToStage1 一致）。
      stage = 'collapsed'
      stagePlatform = null
    } else if (stage === 'tasks' && stagePlatform) {
      if (!bubbleData.platforms.some(x => x.platform === stagePlatform)) {
        stage = 'platforms'
        stagePlatform = null
      }
    }
    renderBubble()
  }

  function onPet(payload) {
    if (!payload || !payload.ok) {
      canvas.width = 192
      canvas.height = 208
      canvas.style.width = '192px'
      canvas.style.height = '208px'
      drawPlaceholder()
      return
    }
    const img = new Image()
    img.onload = () => {
      sprite = img
      cellW = img.naturalWidth / COLS
      cellH = CELL_H
      rows = Math.max(1, Math.round(img.naturalHeight / cellH))
      canvas.width = cellW
      canvas.height = cellH
      applyScale(payload.scale)
      // 首次载入后按当前快照设定动画（无快照则 idle）。
      setStatusAnimation(statusAnimation || 'idle')
    }
    img.src = payload.spritesheet
  }

  function onSnapshot(snap) {
    currentSnapshot = snap
    setStatusAnimation(snap.animation || 'idle')
    updateBubble(snap)
  }

  // ---- 精灵交互（对齐 macOS SpriteView：悬停 jumping、拖动 running、点击展开）----

  let dragging = false
  let dragStart = null
  let didDrag = false

  canvas.addEventListener('mouseenter', () => { if (!dragging) setInteractionAnimation('jumping') })
  canvas.addEventListener('mouseleave', () => { if (!dragging) setInteractionAnimation(null) })

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
    if (!didDrag && Math.hypot(dx, dy) < 4) return
    didDrag = true
    if (window.petAPI && window.petAPI.dragMove) window.petAPI.dragMove(e.screenX, e.screenY)
    setInteractionAnimation(dx >= 0 ? 'running-right' : 'running-left')
  })

  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    if (window.petAPI && window.petAPI.dragEnd) window.petAPI.dragEnd()
    if (didDrag) {
      setInteractionAnimation(null)
    } else {
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
    window.petAPI.onWatchError((msg) => {
      bubble.classList.remove('hidden')
      bubble.textContent = '监控异常：' + msg
    })
  } else {
    drawPlaceholder()
  }

  requestAnimationFrame(tick)
})()
