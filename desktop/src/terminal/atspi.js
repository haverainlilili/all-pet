'use strict'
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createRPC } = require('./rpc')
function createATSPI() {
  let child, blockedUntil = 0, buffer = ''
  const rpc = createRPC(request => {
    if (Date.now() < blockedUntil) return false
    if (!child) {
      const current = spawn('/usr/bin/python3', [path.join(__dirname, 'atspi.py').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')], { stdio: ['pipe', 'pipe', 'ignore'] })
      child = current; buffer = ''
      const closed = () => { if (child === current) { child = null; rpc.disconnect(); blockedUntil = Date.now() + 30000 } }
      current.on('error', closed); current.on('close', closed); current.stdin.on('error', closed)
      current.stdout.on('data', chunk => {
        buffer += chunk.toString('utf8')
        if (buffer.length > 65536) return current.kill()
        let index
        while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); try { rpc.receive(JSON.parse(line)) } catch {} }
      })
    }
    child.stdin.write(JSON.stringify(request) + '\n'); return true
  })
  return {
    async operate(anchor, focus) {
      try { const result = await rpc.request(focus ? 'focus' : 'view', anchor, 1500); return focus ? result.succeeded : result.viewed }
      catch { child?.kill('SIGKILL'); return false }
    },
    stop() { rpc.disconnect(); child?.kill(); child = null }
  }
}
module.exports = { createATSPI }
