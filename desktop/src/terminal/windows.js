'use strict'
const { spawn } = require('node:child_process')
const path = require('node:path')
const { createRPC } = require('./rpc')
function createWindowsTerminal() {
  let child, buffer = ''
  const rpc = createRPC(message => {
    if (!child) {
      const current = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      child = current; buffer = ''
      const disconnected = () => { if (child === current) { rpc.disconnect(); child = null } }
      current.on('error', disconnected); current.on('close', disconnected); current.stdin.on('error', disconnected)
      current.stdout.on('data', data => {
        buffer += data.toString('utf8'); if (buffer.length > 2 * 1024 * 1024) { child.kill(); return }
        let index
        while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); try { rpc.receive(JSON.parse(line)) } catch {} }
      })
    }
    child.stdin.write(JSON.stringify(message) + '\n')
    return true
  })
  return {
    async request(operation, payload) {
      try { return await rpc.request(operation, payload, operation === 'bind' ? 10000 : 1500) }
      catch (error) { child?.kill(); throw error }
    },
    stop() { rpc.disconnect(); child?.kill(); child = null }
  }
}
module.exports = { createWindowsTerminal }
