'use strict'

// Every request is bounded and belongs to one bridge generation. A restarted
// helper can never satisfy an old request or leave the caller waiting forever.
function createRPC(send, { timeoutMs = 3000 } = {}) {
  let serial = 0
  const pending = new Map()
  return {
    request(operation, payload = {}, timeout = timeoutMs) {
      const requestID = `terminal-${++serial}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestID); reject(new Error('终端接口响应超时')) }, timeout)
        pending.set(requestID, { resolve, reject, timer })
        try {
          if (send({ type: 'terminal-request', requestID, operation, ...payload }) === false) throw new Error('终端接口未连接')
        } catch (error) { clearTimeout(timer); pending.delete(requestID); reject(error) }
      })
    },
    receive(message) {
      if (message.type !== 'terminal-result') return false
      const entry = pending.get(message.requestID)
      if (!entry) return false
      pending.delete(message.requestID); clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message)
      return true
    },
    disconnect() {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('终端接口已断开')) }
      pending.clear()
    }
  }
}
module.exports = { createRPC }
