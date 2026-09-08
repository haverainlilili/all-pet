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

  function buildSequence(name) {
    const a = ANIMATIONS[name] || ANIMATIONS.idle
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

  function updateBubble(snap) {
    const idle = !snap.summary || snap.summary === '全部空闲'
    if (idle) {
      bubble.classList.add('hidden')
      return
    }
    bubble.classList.remove('hidden')
    bubble.textContent = snap.summary
  }

  function onPet(payload) {
    if (!payload || !payload.ok) {
      canvas.width = 192
      canvas.height = 208
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
      // 首次载入后按当前快照设定动画（无快照则 idle）。
      setAnimation(currentAnimation || 'idle')
    }
    img.src = payload.spritesheet
  }

  function onSnapshot(snap) {
    currentSnapshot = snap
    setAnimation(snap.animation || 'idle')
    updateBubble(snap)
  }

  if (window.petAPI) {
    window.petAPI.onPet(onPet)
    window.petAPI.onSnapshot(onSnapshot)
    window.petAPI.onWatchError((msg) => {
      bubble.classList.remove('hidden')
      bubble.textContent = '监控异常：' + msg
    })
  } else {
    drawPlaceholder()
  }

  requestAnimationFrame(tick)
})()
