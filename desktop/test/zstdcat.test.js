'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { Readable } = require('node:stream')
const { zstdCompressSync, constants } = require('node:zlib')
const { decodeFrames } = require('../scripts/zstdcat')

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

test('bundled decoder reads every independent checksummed DSH frame', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'allpet-zstd-frames-'))
  const compressed = path.join(directory, 'session.jsonl.zstd')
  const lines = [
    '{"type":"session","data":{"id":"session-fixture"}}\n',
    '{"type":"turn/start","data":{}}\n',
    '{"type":"tool/call","data":{"name":"command"}}\n',
    '{"type":"turn/end","data":{"reason":"completed"}}\n'
  ]
  try {
    fs.writeFileSync(compressed, Buffer.concat(lines.map(line => zstdCompressSync(line, { params: { [constants.ZSTD_c_checksumFlag]: 1 } }))))
    const result = spawnSync(electron, [decoder, compressed], { env: electronNodeEnv })
    assert.equal(result.status, 0, String(result.stderr))
    assert.equal(result.stdout.toString(), lines.join(''))
    // A partial append must fail; the monitor must not treat the old completion
    // prefix as the latest successfully decoded state.
    fs.appendFileSync(compressed, zstdCompressSync('new turn').subarray(0, 7))
    const partial = spawnSync(electron, [decoder, compressed], { env: electronNodeEnv })
    assert.notEqual(partial.status, 0)
    assert.match(partial.stderr.toString(), /Incomplete/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('frame parsing tolerates stream chunk boundaries, empty frames, and skippable metadata', async () => {
  const metadata = Buffer.alloc(11)
  metadata.writeUInt32LE(0x184D2A50, 0)
  metadata.writeUInt32LE(3, 4)
  const content = '会话\n'.repeat(40000)
  const encoded = Buffer.concat([zstdCompressSync(''), metadata, zstdCompressSync(content), zstdCompressSync('last\n')])
  const chunks = Array.from(encoded, byte => Buffer.from([byte]))
  const decoded = []
  for await (const frame of decodeFrames(Readable.from(chunks))) decoded.push(frame)
  assert.equal(Buffer.concat(decoded).toString(), content + 'last\n')
})

test('invalid frames and broken checksums fail instead of accepting a stale prefix', async () => {
  const checksummed = zstdCompressSync('checksum', { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
  checksummed[checksummed.length - 1] ^= 0xff
  const invalidBlock = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0, 7, 0, 0])
  for (const input of [Buffer.from('bad!'), checksummed, invalidBlock]) {
    await assert.rejects(async () => { for await (const frame of decodeFrames(Readable.from([input]))) void frame })
  }
})
