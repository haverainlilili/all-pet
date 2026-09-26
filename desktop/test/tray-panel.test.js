'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { trayPanelBounds, keepsTrayPanelOpen, validTrayPanelAction } = require('../src/tray-panel-model')
test('tray panel fits negative monitors, bottom taskbars and small work areas', () => {
  for (const area of [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1280, y: -200, width: 1280, height: 720 }, { x: 0, y: 0, width: 280, height: 400 }]) {
    for (const anchor of [{ x: area.x, y: area.y, width: 20, height: 20 }, { x: area.x + area.width - 20, y: area.y + area.height, width: 20, height: 40 }]) {
      const box = trayPanelBounds(anchor, area)
      assert.ok(box.x >= area.x && box.y >= area.y)
      assert.ok(box.x + box.width <= area.x + area.width && box.y + box.height <= area.y + area.height)
    }
  }
})
test('continuous settings stay open while dialogs and external actions close the panel', () => {
  for (const action of ['bubble-platform-toggle', 'bubble-platform-all', 'scale-decrease', 'scale-increase', 'pet-select', 'refresh-pets']) assert.equal(keepsTrayPanelOpen(action), true)
  for (const action of ['pet-delete', 'pet-install', 'open-manager', 'open-config', 'integration-install', 'quit']) assert.equal(keepsTrayPanelOpen(action), false)
})
test('tray panel permits only known providers and catalog targets, with operation guards', () => {
  const state = { busy: false, hasPet: true, installedPets: [{ target: '/pets/tiko' }], defaultPets: [{ source: 'boba' }] }
  assert.equal(validTrayPanelAction('pet-select', '/pets/tiko', state), true)
  assert.equal(validTrayPanelAction('pet-delete', '/private/file', state), false)
  assert.equal(validTrayPanelAction('pet-install', 'https://unrequested.example/repo', state), false)
  assert.equal(validTrayPanelAction('bubble-platform-toggle', 'codex', state), true)
  assert.equal(validTrayPanelAction('bubble-platform-toggle', 'other', state), false)
  assert.equal(validTrayPanelAction('bubble-platform-all', 'delete', state), false)
  assert.equal(validTrayPanelAction('execute', 'whoami', state), false)
  assert.equal(validTrayPanelAction('pet-select', '/pets/tiko', { ...state, busy: true }), false)
  assert.equal(validTrayPanelAction('scale-increase', null, { ...state, hasPet: false }), false)
})
