'use strict'
const fs = require('node:fs'), crypto = require('node:crypto')
const { run } = require('./process')
// Ghostty 1.3+ exposes stable terminal UUIDs but not TTYs. A transient random
// title challenge binds the verified PTY to one UUID; ordinary titles are never identities.
function createGhostty(native, command = run) {
  const bindings = new Map()
  async function operate(anchor, focus) {
    if (!anchor.binding) return false
    const owner = await native.request('owner', { binding: anchor.binding })
    if (owner.bundleID !== 'com.mitchellh.ghostty') return false
    const key = `${anchor.pid}:${anchor.binding.anchorStartedAtMicroseconds}`
    const script = async source => command('/usr/bin/osascript', ['-e', source])
    let id = bindings.get(key)
    if (!id) {
      const marker = `AllPet-${crypto.randomUUID()}`
      const fd = fs.openSync(anchor.tty, fs.constants.O_WRONLY | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK)
      try {
        fs.writeSync(fd, `\x1b[22;0t\x1b]2;${marker}\x07`)
        id = await script(`if application id "com.mitchellh.ghostty" is not running then return "MISS"
tell application id "com.mitchellh.ghostty"
repeat 5 times
set found to every terminal whose name is ${JSON.stringify(marker)}
if (count of found) is 1 then return id of item 1 of found
delay 0.03
end repeat
end tell
return "MISS"`)
      } finally { try { fs.writeSync(fd, '\x1b[23;0t') } finally { fs.closeSync(fd) } }
      if (!/^[a-f0-9-]{36}$/i.test(id || '')) return false
      if (bindings.size > 128) bindings.clear()
      bindings.set(key, id)
    }
    if (focus) await script(`tell application id "com.mitchellh.ghostty"
set matches to every terminal whose id is ${JSON.stringify(id)}
if (count of matches) is 1 then focus item 1 of matches
end tell`)
    if ((await native.request('foreground')).bundleID !== 'com.mitchellh.ghostty') return false
    return await script('tell application id "com.mitchellh.ghostty" to return id of focused terminal of selected tab of front window') === id
  }
  return { operate }
}
module.exports = { createGhostty }
