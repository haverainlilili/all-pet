'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const destination = path.resolve(process.argv[2] || process.env.ALLPET_SIDECAR_DIR || path.join(__dirname, '..', 'sidecar'))
const query = spawnSync('swift', ['build', '-c', 'release', '--static-swift-stdlib', '--show-bin-path'], { encoding: 'utf8' })
if (query.status !== 0) throw new Error(query.stderr || query.stdout || 'swift --show-bin-path failed')
const binPath = query.stdout.trim().split(/\r?\n/).at(-1)
const executableName = process.platform === 'win32' ? 'allpet.exe' : 'allpet'
const executable = path.join(binPath, executableName)
const resource = ['AllPet_AllPetCore.bundle', 'AllPet_AllPetCore.resources']
  .map(name => path.join(binPath, name))
  .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory())
if (!fs.existsSync(executable)) throw new Error(`missing sidecar executable: ${executable}`)
if (!resource) throw new Error(`missing AllPetCore resources in ${binPath}`)
fs.rmSync(destination, { recursive: true, force: true })
fs.mkdirSync(destination, { recursive: true })
const copiedExecutable = path.join(destination, executableName)
fs.copyFileSync(executable, copiedExecutable)
if (process.platform !== 'win32') fs.chmodSync(copiedExecutable, 0o755)
fs.cpSync(resource, path.join(destination, path.basename(resource)), { recursive: true })

let runtimeDLLs = 0
if (process.platform === 'win32') {
  const where = spawnSync('where.exe', ['swift.exe'], { encoding: 'utf8' })
  const swiftExecutable = where.status === 0 ? where.stdout.trim().split(/\r?\n/)[0] : null
  const roots = [
    swiftExecutable && path.dirname(swiftExecutable),
    process.env.SDKROOT && path.join(process.env.SDKROOT, 'usr', 'bin'),
    process.env.SDKROOT && path.join(process.env.SDKROOT, 'usr', 'lib', 'swift', 'windows')
  ].filter(Boolean)
  const copied = new Set()
  function copyDLLs(directory) {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name)
      if (entry.isDirectory()) copyDLLs(source)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll') && !copied.has(entry.name.toLowerCase())) {
        fs.copyFileSync(source, path.join(destination, entry.name))
        copied.add(entry.name.toLowerCase())
      }
    }
  }
  for (const root of roots) copyDLLs(root)
  runtimeDLLs = copied.size
  if (runtimeDLLs === 0) throw new Error(`no Windows Swift runtime DLLs found in: ${roots.join(', ')}`)
}

console.log(JSON.stringify({ binPath, executable: copiedExecutable, resource: path.basename(resource), runtimeDLLs }))
