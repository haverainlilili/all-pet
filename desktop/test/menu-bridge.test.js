'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createLineDecoder, menuBridgeState } = require('../src/menu-bridge')

test('native menu bridge state preserves scale, complete icon paths, and platform rows', () => {
  const state = menuBridgeState({
    visible: true, hasPet: true, busy: false, scalePercent: '109%', tooltip: 'AllPet · Hoops',
    statusIconPath: '/resources/tray/icon.png', platformTitles: ['Claude Code：完成'],
    installedPets: [{ label: 'Hoops', target: '/pets/hoops', current: true, iconPath: '/cache/menu-v3.png' }],
    defaultPets: [{ label: '噜噜', source: 'lulu', iconPath: '/cache/lulu.png' }]
  })
  assert.equal(state.type, 'state')
  assert.equal(state.scalePercent, '109%')
  assert.equal(state.statusIconPath, '/resources/tray/icon.png')
  assert.deepEqual(state.platformTitles, ['Claude Code：完成'])
  assert.equal(state.installedPets[0].iconPath, '/cache/menu-v3.png')
  assert.equal(state.installedPets[0].current, true)
})

test('native menu bridge decoder handles split and batched NDJSON actions', () => {
  const values = []
  const decoder = createLineDecoder(value => values.push(value))
  decoder.push('{"type":"rea')
  decoder.push('dy"}\n{"type":"action","action":"scale-increase"}\n')
  assert.deepEqual(values, [
    { type: 'ready' },
    { type: 'action', action: 'scale-increase' }
  ])
  assert.equal(decoder.pending(), '')
})
