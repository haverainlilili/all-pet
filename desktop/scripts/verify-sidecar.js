'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const sidecarInput = process.argv[2] || process.env.ALLPET_SIDECAR_DIR
const home = process.argv[3] || process.env.ALLPET_TEST_HOME
if (!sidecarInput || !home) throw new Error('usage: node verify-sidecar.js <sidecar-or-directory> <fresh-home>')
const sidecar = fs.existsSync(sidecarInput) && fs.statSync(sidecarInput).isDirectory()
  ? path.join(sidecarInput, process.platform === 'win32' ? 'allpet.exe' : 'allpet')
  : sidecarInput

fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(home, { recursive: true })
const childEnv = { ...process.env, HOME: home, USERPROFILE: home, CFFIXED_USER_HOME: home }
if (process.env.ALLPET_CLEAN_PATH === '1') {
  childEnv.PATH = process.platform === 'win32'
    ? [process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].filter(Boolean).join(path.delimiter)
    : '/usr/bin:/bin'
}

function run(args) {
  const result = spawnSync(sidecar, args, { env: childEnv, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${sidecar} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

const catalog = JSON.parse(run(['pet', 'list', '--json']))
assert.ok(Array.isArray(catalog.pets) && catalog.pets.length > 0, 'fresh sidecar must discover bundled pets')
const source = catalog.pets[0].directoryPath
const petsRoot = path.join(home, '.config', 'all-pet', 'pets')
const exactCat = path.join(petsRoot, 'exact-cat.petbundle')
fs.cpSync(source, exactCat, { recursive: true })
const manifestPath = path.join(exactCat, 'pet.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
manifest.id = 'cat'
manifest.displayName = 'Exact Cat'
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + os.EOL)

// Built-in cat-hamster-duo is discovered before custom pets; exact ID must still win over fuzzy contains.
run(['pet', 'set', 'cat'])
const configPath = path.join(home, '.config', 'all-pet', 'config.json')
let config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
assert.equal(path.resolve(config.pet.bundlePath), path.resolve(exactCat), 'exact ID must beat earlier substring match')

// Case-sensitive filesystems must not fold distinct canonical paths together.
const caseUpper = path.join(petsRoot, 'CaseCat.petbundle')
const caseLower = path.join(petsRoot, 'casecat.petbundle')
fs.cpSync(exactCat, caseUpper, { recursive: true })
if (!fs.existsSync(caseLower)) {
  fs.cpSync(exactCat, caseLower, { recursive: true })
  run(['pet', 'set', caseLower])
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.equal(path.resolve(config.pet.bundlePath), path.resolve(caseLower), 'case-distinct exact path must select the intended bundle')
  run(['pet', 'delete', caseLower])
  assert.equal(fs.existsSync(caseLower), false, 'selected case-distinct bundle must be deleted')
  assert.equal(fs.existsSync(caseUpper), true, 'other case-distinct bundle must remain')
}
fs.rmSync(caseUpper, { recursive: true, force: true })

// Duplicate IDs must remain independently addressable by their canonical directory path.
const duplicate = path.join(petsRoot, 'duplicate-cat.petbundle')
fs.cpSync(exactCat, duplicate, { recursive: true })
run(['pet', 'set', duplicate])
config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
assert.equal(path.resolve(config.pet.bundlePath), path.resolve(duplicate), 'exact path must select the intended duplicate')
run(['pet', 'delete', duplicate])
assert.equal(fs.existsSync(duplicate), false, 'exact duplicate path must be deleted')
assert.equal(fs.existsSync(exactCat), true, 'other pet with same ID must remain')
console.log(`sidecar verified: ${catalog.pets.length} fresh pets, exact ID/path mutation safe`)
