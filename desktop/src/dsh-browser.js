'use strict'

const REUSE_DSH_TAB_APPLESCRIPT = `
on isDSHURL(u)
  return u starts with "http://127.0.0.1:3080/" or u starts with "http://localhost:3080/"
end isDSHURL

on reuseChromium(browserID, targetURL)
  try
    using terms from application "Google Chrome"
      tell application id browserID
        if not running then return "MISS"
        repeat with w in windows
          set tabIndex to 0
          repeat with t in tabs of w
            set tabIndex to tabIndex + 1
            try
              set u to URL of t as text
              if my isDSHURL(u) then
                try
                  set URL of t to targetURL
                  set active tab index of w to tabIndex
                  set index of w to 1
                  activate
                  return "REUSED"
                on error
                  return "BLOCKED"
                end try
              end if
            end try
          end repeat
        end repeat
      end tell
    end using terms from
  end try
  return "MISS"
end reuseChromium

on reuseSafari(targetURL)
  try
    tell application id "com.apple.Safari"
      if not running then return "MISS"
      repeat with w in windows
        set tabIndex to 0
        repeat with t in tabs of w
          set tabIndex to tabIndex + 1
          try
            set u to URL of t as text
            if my isDSHURL(u) then
              try
                set URL of t to targetURL
                set current tab of w to tab tabIndex of w
                set index of w to 1
                activate
                return "REUSED"
              on error
                return "BLOCKED"
              end try
            end if
          end try
        end repeat
      end repeat
    end tell
  end try
  return "MISS"
end reuseSafari

on run argv
  set targetURL to item 1 of argv
  repeat with browserID in {"com.google.Chrome", "com.google.Chrome.canary", "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser"}
    set result to my reuseChromium(browserID as text, targetURL)
    if result is not "MISS" then return result
  end repeat
  return my reuseSafari(targetURL)
end run
`

function reuseExistingDshTab(spawnImpl, targetURL, runtimePlatform) {
  if (runtimePlatform !== 'darwin') return Promise.resolve({ status: 'unsupported' })
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl('/usr/bin/osascript', ['-e', REUSE_DSH_TAB_APPLESCRIPT, '--', targetURL], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolve({ status: 'error', message: String(error && error.message || error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({ status: 'error', message: '浏览器标签页查找超时' })
    }, 5000)
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.once('error', error => {
      clearTimeout(timer)
      finish({ status: 'error', message: String(error && error.message || error) })
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (settled) return
      const value = stdout.trim()
      if (code === 0 && value === 'REUSED') finish({ status: 'reused' })
      else if (code === 0 && value === 'MISS') finish({ status: 'missing' })
      else if (code === 0 && value === 'BLOCKED') finish({ status: 'blocked', message: '浏览器禁止 AllPet 控制已有 DSH 标签页' })
      else finish({ status: 'error', message: stderr.trim() || `osascript exited ${code}` })
    })
  })
}

module.exports = { REUSE_DSH_TAB_APPLESCRIPT, reuseExistingDshTab }
