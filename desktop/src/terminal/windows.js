'use strict'
const { spawn } = require('node:child_process')
const path = require('node:path')
const { createRPC } = require('./rpc')
function createWindowsTerminal({ spawnProcess = spawn, startupTimeout = 10000, requestTimeout = 1500 } = {}) {
  function worker() {
    let current = null, stopped = false
    const rpc = createRPC(message => {
      if (!current?.readyDone) return false
      current.child.stdin.write(JSON.stringify(message) + '\n')
      return true
    })
    function ready() {
      if (stopped) return Promise.reject(Error('终端辅助进程已停止'))
      if (current) return current.ready
      const child = spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      const state = { child, buffer: '', readyDone: false, closed: false }
      state.ready = new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject })
      current = state
      state.disconnect = error => {
        if (state.closed) return
        state.closed = true; clearTimeout(state.timer)
        state.reject(error || Error('终端辅助进程已断开'))
        if (current === state) { current = null; rpc.disconnect() }
        child.kill()
      }
      state.timer = setTimeout(() => state.disconnect(Error('终端辅助进程启动超时')), startupTimeout)
      child.on('error', state.disconnect); child.on('close', () => state.disconnect())
      child.stdin.on('error', state.disconnect)
      child.stdout.on('data', data => {
        if (current !== state) return
        state.buffer += data.toString('utf8')
        if (state.buffer.length > 2 * 1024 * 1024) return state.disconnect(Error('终端响应过大'))
        let index
        while ((index = state.buffer.indexOf('\n')) >= 0) {
          const line = state.buffer.slice(0, index); state.buffer = state.buffer.slice(index + 1)
          try {
            const message = JSON.parse(line)
            if (message.type === 'terminal-ready') { state.readyDone = true; clearTimeout(state.timer); state.resolve() }
            else rpc.receive(message)
          } catch {}
        }
      })
      return state.ready
    }
    return {
      ready,
      async request(operation, payload) {
        await ready()
        const state = current
        try { return await rpc.request(operation, payload, operation === 'bind' ? 10000 : requestTimeout) }
        catch (error) { state?.disconnect(error); throw Error(`Windows 终端 ${operation}：${error.message}`) }
      },
      stop() { stopped = true; current?.disconnect(); rpc.disconnect() }
    }
  }
  // CIM/file-owner discovery can take seconds. It must not block foreground
  // checks, nor make their short timeout kill the worker doing discovery.
  const discovery = worker(), foreground = worker()
  return {
    request(operation, payload) {
      if (operation === 'bind') {
        foreground.ready().catch(() => {}) // prepare focus checks during discovery
        return discovery.request(operation, payload)
      }
      return foreground.request(operation, payload)
    },
    stop() { discovery.stop(); foreground.stop() }
  }
}
module.exports = { createWindowsTerminal }
