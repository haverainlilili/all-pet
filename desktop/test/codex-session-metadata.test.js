'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  MAX_METADATA_BYTES, isExcludedCodexMetadata, isExcludedCodexHistory, readCodexSessionMetadata
} = require('../src/codex-session-metadata')
const { APPLE_REF_MS, normalizeTaskHistory } = require('../src/task-history')

function metadata(payload) { return { type: 'session_meta', payload } }

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'allpet-codex-metadata-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return (name, contents) => {
    const file = path.join(directory, name)
    fs.writeFileSync(file, contents)
    return file
  }
}

test('Codex metadata excludes actual guardian and structured thread-spawn subagents', () => {
  assert.equal(isExcludedCodexMetadata(metadata({
    id: '019a1234-a123-7123-8123-123456789abc',
    originator: 'Codex Desktop', thread_source: 'guardian_review',
    source: { subagent: { other: 'guardian' } },
    parent_thread_id: '019a0000-a123-7123-8123-123456789abc'
  })), true)
  assert.equal(isExcludedCodexMetadata(metadata({
    source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } }
  })), true)
  assert.equal(isExcludedCodexMetadata(metadata({ thread_source: 'guardian_review' })), true)
  assert.equal(isExcludedCodexMetadata(metadata({ source: 'guardian_review' })), true)
  assert.equal(isExcludedCodexMetadata(metadata({ source: { type: 'guardian_review' } })), true)
  assert.equal(isExcludedCodexMetadata(metadata({ source: { type: { type: 'guardian_review' } } })), true)
  assert.equal(isExcludedCodexMetadata(metadata({ thread_source: { subagent: { thread_spawn: {} } } })), true)
})

test('legacy subagent strings and explicit DSH origins are excluded case-insensitively', () => {
  for (const payload of [
    { thread_source: 'subagent' }, { source: 'SubAgent' }, { source: 'subagent:review' },
    { source: { type: 'subagent' } },
    { originator: 'DSH Codex' }, { thread_source: 'dsh-launcher' },
    { source: 'DSH' }, { source: { type: 'dsh' } }
  ]) assert.equal(isExcludedCodexMetadata(metadata(payload)), true, JSON.stringify(payload))
})

test('unnamed UUID main sessions, ordinary forks, and unknown metadata remain visible', () => {
  for (const payload of [
    {}, { id: '019a1234-a123-7123-8123-123456789abc' },
    { source: 'user', parent_thread_id: 'parent' }, { source: 'cli' },
    { source: 'vscode', originator: 'Codex Desktop' },
    { source: { type: 'user' }, thread_source: 'user' },
    { source: { thread_spawn: {} } }, // Not an observed internal metadata shape.
    { source: { description: 'guardian_review subagent dsh' } },
    { title: '排查 subagent 与 guardian_review' }, { source: ['subagent'] },
    { source: 'guardian' }, { source: 'guardian_review_notes' }
  ]) assert.equal(isExcludedCodexMetadata(metadata(payload)), false, JSON.stringify(payload))
  for (const record of [null, [], {}, { type: 'session_meta', payload: [] },
    { type: 'response_item', payload: { source: 'subagent' } }]) {
    assert.equal(isExcludedCodexMetadata(record), false)
  }
})

test('bounded reader parses metadata beyond the former 16 KiB and 64 KiB limits', t => {
  const write = fixture(t)
  for (const padding of [20_000, 90_000, MAX_METADATA_BYTES - 256]) {
    const record = metadata({ instructions: 'x'.repeat(padding), source: { subagent: { other: 'guardian' } } })
    const file = write(`long-${padding}.jsonl`, `${JSON.stringify(record)}\n{"type":"user"}\n`)
    assert.deepEqual(readCodexSessionMetadata(file), record)
    assert.equal(isExcludedCodexHistory({ sourcePath: file }), true)
  }
})

test('reader stops at the first line and accepts a complete final line without newline', t => {
  const write = fixture(t)
  const main = metadata({ source: 'cli' })
  const internal = metadata({ source: 'subagent' })
  const file = write('first-only.jsonl', `${JSON.stringify(main)}\n${JSON.stringify(internal)}\n`)
  assert.deepEqual(readCodexSessionMetadata(file), main)
  assert.equal(isExcludedCodexHistory({ sourcePath: file }), false)
  const noNewline = write('no-newline.jsonl', JSON.stringify(internal))
  assert.deepEqual(readCodexSessionMetadata(noNewline), internal)
})

test('missing, corrupt, oversized, symlink and non-regular sources are conservatively retained', t => {
  const write = fixture(t)
  const regular = write('guardian.jsonl', `${JSON.stringify(metadata({ source: 'guardian_review' }))}\n`)
  const files = [
    `${regular}.missing`,
    write('bad.jsonl', '{bad metadata}\n'),
    write('empty.jsonl', ''),
    write('truncated.jsonl', '{"type":"session_meta","payload":'),
    write('array.jsonl', '[{"source":"subagent"}]\n'),
    write('oversized.jsonl', `${JSON.stringify(metadata({ instructions: 'x'.repeat(MAX_METADATA_BYTES), source: 'guardian_review' }))}\n`),
    path.dirname(regular)
  ]
  if (process.platform !== 'win32') {
    const link = `${regular}.link`
    fs.symlinkSync(regular, link)
    files.push(link)
  }
  for (const sourcePath of files) {
    assert.equal(readCodexSessionMetadata(sourcePath), null, sourcePath)
    assert.equal(isExcludedCodexHistory({ sourcePath }), false, sourcePath)
  }
  assert.equal(isExcludedCodexHistory({}), false)
  assert.equal(isExcludedCodexHistory(null), false)
})

test('history migration removes internal done/failed cards and preserves genuine unnamed main tasks', t => {
  const write = fixture(t)
  const guardian = write('guardian.jsonl', `${JSON.stringify(metadata({
    instructions: 'x'.repeat(20_000), thread_source: 'guardian_review', source: { subagent: { other: 'guardian' } },
    parent_thread_id: 'main-session'
  }))}\n`)
  const subagent = write('child.jsonl', `${JSON.stringify(metadata({ source: { subagent: { thread_spawn: {} } } }))}\n`)
  const dsh = write('dsh.jsonl', `${JSON.stringify(metadata({ source: 'dsh' }))}\n`)
  const main = write('main.jsonl', `${JSON.stringify(metadata({ source: 'vscode', parent_thread_id: 'normal-fork' }))}\n`)
  const broken = write('broken.jsonl', 'broken\n')
  const nowSeconds = 500000
  const records = [
    ['guardian', 'done', guardian], ['child', 'failed', subagent], ['dsh', 'done', dsh],
    ['019a1234-a123-7123-8123-123456789abc', 'done', main],
    ['unreadable', 'failed', `${main}.missing`], ['broken', 'done', broken]
  ].map(([sessionID, phase, sourcePath]) => ({ sessionID, phase, sourcePath, updatedAt: nowSeconds }))
  const state = normalizeTaskHistory({ platforms: { codex: records }, dismissedTaskIDs: [] },
    APPLE_REF_MS + nowSeconds * 1000, { isExcludedCodexHistory })
  assert.deepEqual(state.platforms.codex.map(task => task.sessionID), [
    '019a1234-a123-7123-8123-123456789abc', 'unreadable', 'broken'
  ])
  const persisted = JSON.parse(JSON.stringify({ platforms: state.platforms, dismissedTaskIDs: state.dismissed }))
  const reloaded = normalizeTaskHistory(persisted, APPLE_REF_MS + nowSeconds * 1000, { isExcludedCodexHistory })
  assert.deepEqual(reloaded, state)
})
