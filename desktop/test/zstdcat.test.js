'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const electron = process.env.ALLPET_ELECTRON_BINARY || require('electron')
const decoder = path.join(__dirname, '..', 'scripts', 'zstdcat.js')
const electronNodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

test('bundled Electron Node decodes zstd without an external command', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'allpet-zstdcat-'))
  const compressed = path.join(directory, 'fixture.jsonl.zstd')
  const content = '{"type":"user/message","data":{"content":[{"type":"text","text":"内置 decoder 验收"}]}}\n'
  try {
    const compressor = spawnSync(electron, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(compressed)},require('node:zlib').zstdCompressSync(Buffer.from(${JSON.stringify(content)})))`], {
      env: electronNodeEnv, encoding: 'utf8'
    })
    assert.equal(compressor.status, 0, compressor.stderr || compressor.stdout)
    const result = spawnSync(electron, [decoder, compressed], { env: electronNodeEnv })
    assert.equal(result.status, 0, String(result.stderr || ''))
    assert.equal(result.stdout.toString('utf8'), content)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
