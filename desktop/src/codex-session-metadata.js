'use strict'

const fs = require('node:fs')

const MAX_METADATA_BYTES = 1024 * 1024
const METADATA_CHUNK_BYTES = 64 * 1024

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function excludedSourceString(value) {
  if (typeof value !== 'string') return false
  const lower = value.toLowerCase()
  return lower.includes('dsh') || lower.includes('subagent') || lower === 'guardian_review'
}

function excludedSource(value) {
  const seen = new Set()
  while (isObject(value)) {
    if (Object.hasOwn(value, 'subagent')) return true
    if (seen.has(value)) return false
    seen.add(value)
    value = value.type
  }
  return excludedSourceString(value)
}

// Only explicit session metadata establishes an internal/DSH origin. Missing names,
// UUIDs and parent_thread_id also occur in normal user sessions and are not evidence.
function isExcludedCodexMetadata(record) {
  if (!isObject(record) || record.type !== 'session_meta' || !isObject(record.payload)) return false
  const payload = record.payload
  const originator = typeof payload.originator === 'string' ? payload.originator.toLowerCase() : ''
  return originator.includes('dsh')
    || excludedSource(payload.thread_source)
    || excludedSource(payload.source)
}

// Read only a bounded first line from a regular, non-symlink file. Unknown,
// malformed or inaccessible metadata must not remove a user's history card.
function readCodexSessionMetadata(sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath) return null
  let handle
  try {
    const before = fs.lstatSync(sourcePath)
    if (!before.isFile() || before.isSymbolicLink()) return null
    handle = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
    const opened = fs.fstatSync(handle)
    const current = fs.lstatSync(sourcePath)
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
        || before.dev !== opened.dev || before.ino !== opened.ino
        || current.dev !== opened.dev || current.ino !== opened.ino) return null

    const chunks = []
    let total = 0
    let complete = false
    while (total < MAX_METADATA_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(METADATA_CHUNK_BYTES, MAX_METADATA_BYTES - total))
      const bytes = fs.readSync(handle, chunk, 0, chunk.length, total)
      if (bytes === 0) { complete = true; break }
      const read = chunk.subarray(0, bytes)
      const newline = read.indexOf(0x0A)
      chunks.push(newline >= 0 ? read.subarray(0, newline) : read)
      total += bytes
      if (newline >= 0) { complete = true; break }
    }
    if (!complete) return null
    const record = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return isObject(record) ? record : null
  } catch {
    return null
  } finally {
    if (handle !== undefined) { try { fs.closeSync(handle) } catch {} }
  }
}

function isExcludedCodexHistory(task) {
  return isExcludedCodexMetadata(readCodexSessionMetadata(task && task.sourcePath))
}

module.exports = { MAX_METADATA_BYTES, isExcludedCodexMetadata, isExcludedCodexHistory, readCodexSessionMetadata }
