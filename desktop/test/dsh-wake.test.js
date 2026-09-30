'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { DSH_BASE_URL, dshSessionURL, performDshPlatformWake } = require('../src/dsh-wake')

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

test('idle DSH platform click focuses the existing page without navigating', async () => {
  const calls = []
  const result = await performDshPlatformWake({
    runtimePlatform: 'darwin',
    reuseDSHTab: async url => { calls.push(['reuse', url]); return { status: 'reused' } },
    openExternal: async url => calls.push(['open', url])
  })
  assert.deepEqual(calls, [['reuse', '']])
  assert.equal(result.succeeded, true)
  assert.equal(result.exact, true)
  assert.match(result.message, /保留当前会话/)
})

test('DSH platform click opens a page only after a confirmed missing tab', async () => {
  const calls = []
  const result = await performDshPlatformWake({
    runtimePlatform: 'darwin',
    reuseDSHTab: async url => { calls.push(['reuse', url]); return { status: 'missing' } },
    openExternal: async url => calls.push(['open', url])
  })
  assert.deepEqual(calls, [['reuse', ''], ['open', DSH_BASE_URL]])
  assert.equal(result.succeeded, true)
  assert.equal(result.exact, false)
})

test('browser denial, lookup failure, and unknown results cannot duplicate DSH pages', async () => {
  for (const status of ['blocked', 'error', 'unsupported', 'unexpected']) {
    let opened = false
    const result = await performDshPlatformWake({
      runtimePlatform: 'darwin',
      reuseDSHTab: async () => ({ status }),
      openExternal: async () => { opened = true }
    })
    assert.equal(opened, false, status)
    assert.equal(result.succeeded, false)
    assert.match(result.message, /未打开新页面/)
  }
})

test('DSH platform click handles thrown failures and preserves other OS launch behavior', async () => {
  const failure = await performDshPlatformWake({ runtimePlatform: 'darwin', reuseDSHTab: async () => { throw new Error('lookup failed') }, openExternal: () => assert.fail() })
  assert.equal(failure.succeeded, false)
  assert.match(failure.message, /lookup failed/)
  for (const runtimePlatform of ['win32', 'linux']) {
    let opened
    const result = await performDshPlatformWake({ runtimePlatform, reuseDSHTab: () => assert.fail(), openExternal: async url => { opened = url } })
    assert.equal(opened, DSH_BASE_URL)
    assert.equal(result.succeeded, true)
    assert.equal(result.exact, false)
  }
})
