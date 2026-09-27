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

  // FoundationNetworking 等 DLL 还会依赖 PATH 中的 curl/ICU 等运行库。
  // 用 Swift toolchain 自带的 llvm-readobj 解析完整导入闭包，只复制真正需要的非系统 DLL。
  const swiftBin = swiftExecutable && path.dirname(swiftExecutable)
  const readobj = [swiftBin && path.join(swiftBin, 'llvm-readobj.exe'), 'llvm-readobj.exe'].find(candidate => {
    if (!candidate) return false
    if (path.isAbsolute(candidate)) return fs.existsSync(candidate)
    return spawnSync('where.exe', [candidate], { encoding: 'utf8' }).status === 0
  })
  const system32 = process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32')
  const searchDirectories = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  function fileNamed(directory, name) {
    if (!directory || !fs.existsSync(directory)) return null
    const wanted = name.toLowerCase()
    const found = fs.readdirSync(directory, { withFileTypes: true }).find(entry => entry.isFile() && entry.name.toLowerCase() === wanted)
    return found ? path.join(directory, found.name) : null
  }
  function imports(file) {
    if (!readobj) return []
    const result = spawnSync(readobj, ['--coff-imports', file], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`llvm-readobj failed for ${file}: ${result.stderr || result.stdout}`)
    return Array.from(result.stdout.matchAll(/Name:\s*([^\r\n]+?\.dll)\s*$/gmi), match => match[1].trim())
  }
  const queue = [copiedExecutable]
  const inspected = new Set()
  const missing = new Set()
  while (queue.length) {
    const binary = queue.pop()
    const binaryKey = path.resolve(binary).toLowerCase()
    if (inspected.has(binaryKey)) continue
    inspected.add(binaryKey)
    for (const dependency of imports(binary)) {
      const key = dependency.toLowerCase()
      // API Set 名称由 Windows loader 虚拟解析，不对应必须随包复制的实体 DLL。
      if (key.startsWith('api-ms-win-') || key.startsWith('ext-ms-win-')) continue
      const adjacent = fileNamed(destination, dependency)
      if (adjacent) { queue.push(adjacent); continue }
      if (fileNamed(system32, dependency)) continue
      const source = searchDirectories.map(directory => fileNamed(directory, dependency)).find(Boolean)
      if (!source) { missing.add(dependency); continue }
      const target = path.join(destination, path.basename(source))
      fs.copyFileSync(source, target)
      copied.add(key)
      queue.push(target)
    }
  }
  if (missing.size) throw new Error(`missing Windows runtime DLL closure: ${Array.from(missing).join(', ')}`)
  runtimeDLLs = copied.size
  if (runtimeDLLs === 0) throw new Error(`no Windows Swift runtime DLLs found in: ${roots.join(', ')}`)
}

console.log(JSON.stringify({ binPath, executable: copiedExecutable, resource: path.basename(resource), runtimeDLLs }))

require('./package-terminal-extension')
