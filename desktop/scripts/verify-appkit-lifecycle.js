'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

if (process.platform !== 'darwin') throw new Error('AppKit lifecycle verification requires macOS')
const build = spawnSync('swift', ['build'], { encoding: 'utf8' })
if (build.status !== 0) throw new Error(build.stderr || build.stdout || 'swift build failed')
const query = spawnSync('swift', ['build', '--show-bin-path'], { encoding: 'utf8' })
if (query.status !== 0) throw new Error(query.stderr || query.stdout || 'swift --show-bin-path failed')
const binary = path.join(query.stdout.trim().split(/\r?\n/).at(-1), 'allpet')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'allpet-appkit-home-'))
const freshOutput = path.join(home, 'fresh.json')
const disabledOutput = path.join(home, 'disabled.json')
const recoveredOutput = path.join(home, 'recovered.json')

function launch(output, extraEnv = {}) {
  const result = spawnSync(binary, [], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...extraEnv, ALLPET_HOME: home, ALLPET_APPKIT_LIFECYCLE_SMOKE: output }
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `AppKit exited ${result.status}`)
  return JSON.parse(fs.readFileSync(output, 'utf8'))
}

try {
  const fresh = launch(freshOutput)
  if (!fresh.ownsWindow || !fresh.initiallyVisible || !fresh.hidden || !fresh.shown || !fresh.operationUnlocked || !fresh.windowWithinWorkArea || !fresh.observesMotionChanges || !fresh.idlePrunesActiveHistory || !fresh.disabledPlatformsLabeled || !fresh.petID || !fresh.bundlePath) {
    throw new Error(`invalid fresh lifecycle result: ${JSON.stringify(fresh)}`)
  }
  const configPath = path.join(home, '.config', 'all-pet', 'config.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (config.pet.bundlePath !== fresh.bundlePath) throw new Error('fresh selected pet was not persisted')
  config.pet.bundlePath = path.join(home, 'missing-pet')
  config.pet.enabled = false
  config.platforms = { ...(config.platforms || {}), claude: { enabled: false, paths: [] } }
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const disabled = launch(disabledOutput)
  if (!disabled.ownsWindow || disabled.initiallyVisible || !disabled.hidden || !disabled.shown || !disabled.operationUnlocked || !disabled.windowWithinWorkArea || !disabled.observesMotionChanges || !disabled.idlePrunesActiveHistory || !disabled.disabledPlatformsLabeled || !disabled.petID) {
    throw new Error(`invalid disabled lifecycle result: ${JSON.stringify(disabled)}`)
  }
  if (disabled.bundlePath === config.pet.bundlePath) throw new Error('stale bundle path was not healed')

  const backup = path.join(home, 'backup-pet')
  fs.cpSync(disabled.bundlePath, backup, { recursive: true })
  fs.rmSync(path.join(home, '.config', 'all-pet', 'pets'), { recursive: true, force: true })
  const emptyConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  emptyConfig.pet.bundlePath = path.join(home, 'missing-pet-again')
  emptyConfig.pet.enabled = true
  fs.writeFileSync(configPath, `${JSON.stringify(emptyConfig, null, 2)}\n`)
  const recovered = launch(recoveredOutput, { ALLPET_APPKIT_SMOKE_INSTALL_SOURCE: backup })
  if (recovered.ownsWindow || recovered.initiallyVisible || recovered.hidden || !recovered.shown || !recovered.operationUnlocked || !recovered.windowWithinWorkArea || !recovered.observesMotionChanges || !recovered.idlePrunesActiveHistory || !recovered.disabledPlatformsLabeled || !recovered.petID) {
    throw new Error(`invalid no-window recovery result: ${JSON.stringify(recovered)}`)
  }
  if (recovered.bundlePath === emptyConfig.pet.bundlePath) throw new Error('no-window recovery kept stale path')
  console.log(`AppKit lifecycle verified: ${JSON.stringify({ fresh, disabled, recovered })}`)
} finally {
  fs.rmSync(home, { recursive: true, force: true })
}
