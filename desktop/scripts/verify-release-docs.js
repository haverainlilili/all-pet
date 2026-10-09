'use strict'
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const version = JSON.parse(read('desktop/package.json')).version
const lock = JSON.parse(read('desktop/package-lock.json'))
assert.equal(lock.version, version, 'Package lock version differs')
assert.equal(lock.packages[''].version, version, 'Package lock root version differs')
if (process.env.GITHUB_REF?.startsWith('refs/tags/')) {
  assert.equal(process.env.GITHUB_REF, `refs/tags/v${version}`, 'Tag/package version mismatch')
}
for (const file of ['README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'desktop/README.md',
  'docs/PRD.md', 'docs/功能设计说明.md', 'docs/平台行为验收.md']) {
  assert.ok(read(file).slice(0, 1500).includes(`v${version}`), `${file} does not identify the current release near its start`)
}
assert.ok(read('docs/一行命令安装.md').includes(`v${version}`), 'Installation documentation has an old release')
const notes = read(`docs/releases/v${version}.md`)
assert.ok(notes.startsWith(`# AllPet v${version}\n`), 'Release notes title/version mismatch')
for (const asset of [`AllPet-${version}-arm64.dmg`, `AllPet-${version}-arm64-mac.zip`,
  `AllPet-Setup-${version}.exe`, `AllPet-${version}.AppImage`, `allpet-desktop_${version}_amd64.deb`]) {
  assert.ok(notes.includes(asset), `Release notes omit ${asset}`)
}
assert.ok(read('AGENTS.md').includes('同步更新相关文档'), 'Persistent documentation policy is missing')
console.log(`Release documentation and version verified: v${version}`)
