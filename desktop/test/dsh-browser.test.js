'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { REUSE_DSH_TAB_APPLESCRIPT, reuseExistingDshTab } = require('../src/dsh-browser')

function fakeSpawn(output, code = 0) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    child.command = command
    child.args = args
    child.options = options
    queueMicrotask(() => {
      child.stdout.end(output)
      child.stderr.end('')
      child.emit('exit', code)
    })
    return child
  }
}

test('macOS DSH wake reuses an existing browser tab without source interpolation', async () => {
  const url = 'http://127.0.0.1:3080/#allpet-session=session%20value'
  let invocation
  const spawn = (...args) => {
    invocation = fakeSpawn('REUSED\n')(...args)
    return invocation
  }
  assert.deepEqual(await reuseExistingDshTab(spawn, url, 'darwin'), { status: 'reused' })
  assert.equal(invocation.command, '/usr/bin/osascript')
  assert.equal(invocation.args[0], '-e')
  assert.equal(invocation.args[1], REUSE_DSH_TAB_APPLESCRIPT)
  assert.deepEqual(invocation.args.slice(2), ['--', url])
  assert.equal(REUSE_DSH_TAB_APPLESCRIPT.includes(url), false)
})

test('DSH browser lookup distinguishes missing and blocked existing tabs', async () => {
  const url = 'http://127.0.0.1:3080/#allpet-session=session-id'
  assert.deepEqual(await reuseExistingDshTab(fakeSpawn('MISS\n'), url, 'darwin'), { status: 'missing' })
  const blocked = await reuseExistingDshTab(fakeSpawn('BLOCKED\n'), url, 'darwin')
  assert.equal(blocked.status, 'blocked')
  assert.match(blocked.message, /禁止/)
  assert.deepEqual(await reuseExistingDshTab(fakeSpawn('REUSED\n'), url, 'win32'), { status: 'unsupported' })
})
