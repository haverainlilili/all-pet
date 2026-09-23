'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { DSH_BASE_URL, dshSessionURL } = require('../src/dsh-wake')

test('DSH task URL carries the exact session only in the browser fragment', () => {
  const url = new URL(dshSessionURL('session-a/b ?'))
  assert.equal(url.origin + '/', DSH_BASE_URL)
  assert.equal(url.search, '')
  assert.equal(url.hash, '#allpet-session=session-a%2Fb%20%3F')
})

test('DSH task URL rejects an empty session identity', () => {
  assert.equal(dshSessionURL(''), null)
  assert.equal(dshSessionURL('   '), null)
})
