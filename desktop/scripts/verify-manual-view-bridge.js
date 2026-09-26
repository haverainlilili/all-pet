#!/usr/bin/env node
'use strict'
// Exercise actual native protocol routing with empty locators; never inspect another app's UI.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const binary = process.env.ALLPET_BINARY
if (!binary) throw new Error('Set ALLPET_BINARY')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'allpet-view-bridge-'))
const platforms = ['codex', 'claude', 'dsh', 'grok', 'pi']
const child = spawn(binary, ['menu-bridge'], { env: { ...process.env, ALLPET_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = '', stderr = '', passed = false
const replies = new Set()
const timer = setTimeout(() => fail(new Error(`Missing replies: ${platforms.filter(p => !replies.has(p))}; ${stderr}`)), 8000)
function fail(error) { console.error(error); process.exitCode = 1; cleanup() }
function cleanup() { clearTimeout(timer); child.stdin.end(); if (child.exitCode === null) child.kill('SIGTERM') }
child.stderr.on('data', chunk => { stderr += chunk })
child.on('error', fail)
child.on('close', () => { fs.rmSync(home, { recursive: true, force: true }); if (!passed) process.exitCode = 1 })
child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n'); buffer = lines.pop()
  for (const line of lines) {
    if (!line) continue
    try {
      const message = JSON.parse(line)
      if (message.type === 'error') throw new Error(message.message)
      if (message.type === 'ready') {
        for (const platform of platforms) child.stdin.write(JSON.stringify({ type: 'view-check', requestID: platform,
          tasks: [{ id: `${platform}|fixture`, platform, title: 'fixture', action: 'done', phase: 'done',
            sessionID: '', launchOrigin: platform === 'codex' ? 'codex-cli' : `${platform}-cli` }] }) + '\n')
      }
      if (message.type !== 'view-result') continue
      assert.equal(message.requestID, message.platform)
      assert.deepEqual(message.viewedIDs, [], 'missing identity must never acknowledge a task')
      replies.add(message.platform)
      if (replies.size === platforms.length) {
        passed = true
        console.log('Native manual-view bridge verified: five independent platform replies; no false acknowledgement without session identity.')
        cleanup()
      }
    } catch (error) { fail(error) }
  }
})
