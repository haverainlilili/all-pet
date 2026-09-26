'use strict'
// Explicit isolated test mode: exercise the real panel and IPC without operating another application.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { BrowserWindow } = require('electron')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
module.exports = async function verify({ show, window, state, readConfig, output }) {
  const until = async (predicate, label) => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await wait(100) }
    const diagnostic = { label, home: process.env.ALLPET_HOME, state: state(), config: readConfig(), renderer: await js('({state, actionPending, text: document.body.innerText})') }
    fs.writeFileSync(output.replace(/\.json$/, '-failure.json'), JSON.stringify(diagnostic, null, 2))
    await capture('failure')
    throw new Error(`Timed out: ${label}`)
  }
  await show()
  const panel = window(), panelID = panel.id
  const js = source => panel.webContents.executeJavaScript(source)
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const visible = () => { assert.equal(window().id, panelID); assert.ok(panel.isVisible(), 'menu must remain open') }
  const capture = async name => fs.writeFileSync(output.replace(/\.json$/, `-${name}.png`), (await panel.webContents.capturePage()).toPNG())
  await until(() => state().hasPet && state().installedPets.length >= 2, 'bundled pets loaded')
  await until(() => js('document.querySelectorAll("[data-page]").length === 3'), 'root menu')
  await click('[data-page="platforms"]')
  for (const platform of ['codex', 'pi']) {
    await click(`[data-action="bubble-platform-toggle"][data-value="${platform}"]`)
    await until(() => (readConfig().hiddenBubblePlatforms || []).includes(platform), `hide ${platform}`)
    await until(() => js(`document.querySelector('[data-value="${platform}"]').getAttribute('aria-checked') === 'false'`), 'checkbox update')
    await wait(150); visible()
  }
  await click('[data-action="bubble-platform-all"][data-value="hide"]')
  await until(() => readConfig().hiddenBubblePlatforms?.length === 9, 'hide all'); visible(); await wait(150)
  await click('[data-action="bubble-platform-all"][data-value="show"]')
  await until(() => readConfig().hiddenBubblePlatforms?.length === 0, 'show all'); visible()
  fs.mkdirSync(path.dirname(output), { recursive: true })
  await wait(200); await capture('platforms')
  await click('#back')
  for (let i = 0; i < 2; i++) {
    const start = state().visible
    await click('[data-action="toggle-visibility"]')
    await until(() => state().visible !== start, `pet visibility change ${i}, initially ${start}`)
    await wait(150); visible()
  }
  for (let i = 0; i < 2; i++) {
    const start = state().scalePercent
    await click('[data-action="scale-increase"]')
    await until(() => state().scalePercent !== start, 'scale change'); await wait(150); visible()
  }
  await click('[data-page="pets"]')
  const next = state().installedPets.find(pet => !pet.current)
  assert.ok(next)
  await click(`[data-action="pet-select"][data-value=${JSON.stringify(next.target)}]`)
  await until(() => state().installedPets.some(pet => pet.target === next.target && pet.current) && !state().busy, 'pet selection')
  visible()
  await until(() => js('Array.from(document.querySelectorAll(".sprite img")).every(img => img.complete && img.naturalWidth > 0)'), 'pet thumbnails')
  await wait(200); await capture('pets')
  await click('[data-action="refresh-pets"]')
  await until(() => !state().busy, 'pet refresh'); await wait(150); visible()
  await click('#back'); await wait(200); await capture('root')
  const invalid = await js('window.allpetMenu.action("pet-delete", "/unrequested-path")')
  assert.equal(invalid.ok, false); visible()
  panel.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  panel.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await until(() => !panel.isVisible(), 'Escape closes')
  await show(); await until(() => panel.isVisible(), 'reopen'); visible()
  // Move focus to a disposable window belonging to this test process.
  const outside = new BrowserWindow({ width: 150, height: 100, show: false, webPreferences: { sandbox: true } })
  try {
    await outside.loadURL('data:text/html,<title>AllPet menu focus test</title>')
    outside.show(); outside.focus()
    await until(() => !panel.isVisible(), 'outside focus closes')
  } finally { outside.destroy() }
  const result = { ok: true, continuousPlatformClicks: true, allPlatforms: true, continuousScale: true, petSelection: true, visibility: true, refresh: true,
    sameWindow: true, thumbnails: true, invalidActionRejected: true, escapeCloses: true, blurCloses: true,
    hiddenBubblePlatforms: readConfig().hiddenBubblePlatforms, selectedPet: next.label }
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  return result
}
