'use strict'
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { spriteBounds, dockBounds } = require('./edge-dock')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
module.exports = async function ({ window, display, sprite, state, snapshot, scale, output, restoring }) {
  const read = () => window.webContents.executeJavaScript(`(() => {
    const pet = document.getElementById('pet'), bubble = document.getElementById('bubble');
    const pixels = pet.getContext('2d').getImageData(0,0,pet.width,pet.height).data;
    return { edge: document.body.dataset.dockEdge || '', dragging: document.body.dataset.petDragging,
      bubbleHidden: getComputedStyle(bubble).display === 'none', width: innerWidth, height: innerHeight,
      visiblePixels: pixels.some((value,index) => index % 4 === 3 && value > 24),
      petRect: { x: pet.offsetLeft, y: pet.offsetTop, width: pet.clientWidth, height: pet.clientHeight } };
  })()`)
  async function until(check, label) { for (let n = 0; n < 60; n++) { if (await check()) return; await sleep(50) }; throw Error(`${label}: ${JSON.stringify(await read())}; ${JSON.stringify(await window.webContents.executeJavaScript('window.edgeTestEvents || []'))}`) }
  await until(async () => !window.webContents.isLoading() && (await read()).visiblePixels, 'pet image ready')
  const results = { ok: false, restoring, edges: [] }, initialHistory = JSON.stringify(state().history)
  if (restoring) {
    const value = await read()
    assert.equal(value.edge, 'bottom'); assert.equal(value.bubbleHidden, true)
    results.restoredAfterRestart = true
  } else {
    const area = display().workArea
    window.setBounds({ x: area.x + 350, y: area.y + 200, width: sprite().width, height: sprite().height })
    window.webContents.send('debug-bubble', { snapshot, stage: 'platforms' })
    await until(async () => !(await read()).bubbleHidden, 'fixture notifications visible')
    await sleep(150)
    // Electron's synthetic mouse input reports screenX/Y=0 on macOS. Exercise
    // drag coordinates through the renderer IPC, and use real Chromium mouse
    // input for clicking the head (which requires no screen-coordinate delta).
    const drag = async (x, y) => {
      const bounds = state().dock ? window.getBounds() : spriteBounds(window.getBounds(), sprite())
      const from = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      await window.webContents.executeJavaScript(`(async()=>{await petAPI.dragStart(${from.x},${from.y}); await petAPI.dragMove(${x},${y}); return petAPI.dragEnd()})()`)
    }
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      const size = sprite(), target = {
        x: edge === 'left' ? area.x + size.width / 2 + 8 : edge === 'right' ? area.x + area.width - size.width / 2 - 8 : area.x + area.width / 2,
        y: edge === 'top' ? area.y + size.height / 2 + 8 : edge === 'bottom' ? area.y + area.height - size.height / 2 - 8 : area.y + area.height / 2
      }
      await drag(target.x, target.y)
      await until(async () => (await read()).edge === edge, `dock ${edge}`)
      window.webContents.send('debug-bubble', { snapshot, stage: 'tasks', platform: 'codex' })
      window.webContents.send('watch-error', 'isolated fixture')
      // Also emulate a stale resize already queued by the old full-size bubble.
      await window.webContents.executeJavaScript('petAPI.resizeForBubble(334, 500)')
      await sleep(100)
      let value = await read()
      assert.equal(value.bubbleHidden, true); assert.equal(value.visiblePixels, true)
      assert.deepEqual(window.getBounds(), dockBounds(state().dock, sprite(), area))
      assert.equal(JSON.stringify(state().history), initialHistory, 'docking must not acknowledge task history')
      const filename = path.join(path.dirname(output), `edge-${edge}.png`)
      fs.writeFileSync(filename, (await window.webContents.capturePage()).toPNG())
      scale(0.05); await sleep(80)
      assert.equal((await read()).bubbleHidden, true); assert.equal((await read()).edge, edge)
      scale(-0.05); await sleep(80)
      results.edges.push({ edge, bounds: window.getBounds(), screenshot: filename })
      if (edge === 'bottom') continue // retained for the second launch
      if (edge === 'right') await drag(area.x + area.width / 2, area.y + area.height / 2)
      else {
        window.focus()
        const { width, height } = window.getBounds()
        window.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(width / 2), y: Math.round(height / 2), button: 'left', clickCount: 1 })
        window.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(width / 2), y: Math.round(height / 2), button: 'left', clickCount: 1 })
      }
      await until(async () => !(await read()).edge && !(await read()).bubbleHidden, `${edge} restore full pet and bubbles`)
    }
    results.newTasksStayHidden = true; results.historyPreserved = true; results.clickAndDragRestore = true
  }
  results.ok = true
  fs.writeFileSync(output, JSON.stringify(results, null, 2))
  return results
}
