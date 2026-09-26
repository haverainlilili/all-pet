'use strict'

// Run the real Electron panel against a disposable HOME and user-data directory.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'allpet-tray-panel-'))
const output = path.resolve(process.env.ALLPET_TRAY_PANEL_OUTPUT || path.join(os.tmpdir(), 'allpet-tray-panel-result.json'))
const binary = process.env.ALLPET_APP_BINARY || require('electron')
fs.mkdirSync(path.join(home, '.config', 'all-pet'), { recursive: true })
fs.writeFileSync(path.join(home, '.config', 'all-pet', 'config.json'), JSON.stringify({ pet: { enabled: false } }))
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.rmSync(output, { force: true })
try {
  const args = process.env.ALLPET_APP_BINARY ? [] : [path.join(__dirname, '..')]
  args.push(`--user-data-dir=${path.join(home, 'electron')}`)
  if (process.env.ALLPET_NO_SANDBOX) args.push('--no-sandbox')
  const result = spawnSync(binary, args, {
    env: { ...process.env, ALLPET_HOME: home, ALLPET_TRAY_PANEL_SMOKE: output },
    encoding: 'utf8', timeout: 60000, windowsHide: false
  })
  if (result.status !== 0 || result.error) throw new Error([result.error?.message, result.stdout, result.stderr, `Electron exited ${result.status}`].filter(Boolean).join('\n'))
  const report = JSON.parse(fs.readFileSync(output, 'utf8'))
  for (const key of ['ok', 'continuousPlatformClicks', 'allPlatforms', 'continuousScale', 'petSelection', 'visibility', 'refresh', 'sameWindow', 'thumbnails', 'invalidActionRejected', 'escapeCloses', 'blurCloses']) {
    if (report[key] !== true) throw new Error(`Menu smoke failed: ${key}`)
  }
  console.log(JSON.stringify({ platform: process.platform, ...report, output }, null, 2))
} finally {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
