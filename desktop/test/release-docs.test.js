const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { verify } = require('../scripts/verify-release-docs')
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'allpet-docs-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.resolve(__dirname, '../..')
  const version = JSON.parse(fs.readFileSync(path.join(source, 'desktop/package.json'))).version
  const files = ['desktop/package.json', 'desktop/package-lock.json', 'README.md', 'README.zh-CN.md',
    'CHANGELOG.md', 'desktop/README.md', 'docs/PRD.md', 'docs/功能设计说明.md', 'docs/平台行为验收.md',
    'docs/一行命令安装.md', `docs/releases/v${version}.md`, 'AGENTS.md']
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.copyFileSync(path.join(source, file), path.join(root, file))
  }
  return { root, version, files }
}
test('release documentation checks accept both LF and Windows CRLF', t => {
  const { root, version, files } = fixture(t)
  assert.equal(verify(root, `refs/tags/v${version}`), version)
  for (const file of files) {
    const target = path.join(root, file)
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/\r?\n/g, '\r\n'))
  }
  assert.equal(verify(root, `refs/tags/v${version}`), version)
})
test('a new README headline cannot hide stale stable-download links', t => {
  const { root, version } = fixture(t), file = path.join(root, 'README.zh-CN.md')
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(`releases/download/v${version}/`, 'releases/download/v0.0.1/'))
  assert.throws(() => verify(root), /old download tag/)
})
test('mismatched release tag or lockfile prevents packaging', t => {
  const { root } = fixture(t)
  assert.throws(() => verify(root, 'refs/tags/v0.0.1'), /Tag\/package/)
  const file = path.join(root, 'desktop/package-lock.json'), lock = JSON.parse(fs.readFileSync(file))
  lock.version = '0.0.1'; fs.writeFileSync(file, JSON.stringify(lock))
  assert.throws(() => verify(root), /Package lock version/)
})
