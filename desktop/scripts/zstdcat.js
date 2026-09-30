'use strict'

const fs = require('node:fs')
const { pipeline } = require('node:stream')
const { zstdDecompress } = require('node:zlib')
const { promisify } = require('node:util')

const decompress = promisify(zstdDecompress)
const MAX_FRAME_BYTES = 128 * 1024 * 1024

// DSH appends independent checksummed frames. A single Node streaming decoder
// can stop after the first frame or reject the next one. Decode each complete
// frame separately, using only public zlib APIs and bounded frame memory.
class ByteReader {
  constructor(source) { this.iterator = source[Symbol.asyncIterator](); this.chunk = Buffer.alloc(0); this.offset = 0 }
  async read(size, allowEOF = false) {
    const parts = []
    let remaining = size
    while (remaining > 0) {
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next()
        if (next.done) {
          if (allowEOF && remaining === size) return null
          throw new Error('Incomplete Zstandard frame')
        }
        this.chunk = next.value
        this.offset = 0
        continue
      }
      const count = Math.min(remaining, this.chunk.length - this.offset)
      parts.push(this.chunk.subarray(this.offset, this.offset + count))
      this.offset += count
      remaining -= count
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, size)
  }
}

async function* decodeFrames(source) {
  const reader = new ByteReader(source)
  for (;;) {
    const magicBytes = await reader.read(4, true)
    if (!magicBytes) return
    const magic = magicBytes.readUInt32LE(0)
    if (magic >= 0x184D2A50 && magic <= 0x184D2A5F) {
      const length = (await reader.read(4)).readUInt32LE(0)
      // Skippable metadata does not need to be buffered.
      for (let remaining = length; remaining > 0; remaining -= Math.min(remaining, 65536)) {
        await reader.read(Math.min(remaining, 65536))
      }
      continue
    }
    if (magic !== 0xFD2FB528) throw new Error('Invalid Zstandard frame magic')
    const descriptorBytes = await reader.read(1)
    const descriptor = descriptorBytes[0]
    if (descriptor & 0x08) throw new Error('Reserved Zstandard frame-header bit')
    const single = Boolean(descriptor & 0x20)
    const sizeFlag = descriptor >>> 6
    const dictionaryFlag = descriptor & 3
    const headerSize = (single ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag)
      + (sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag)
    const parts = [magicBytes, descriptorBytes]
    let frameBytes = 5
    const append = async size => {
      frameBytes += size
      if (frameBytes > MAX_FRAME_BYTES) throw new Error('Zstandard frame exceeds 128 MiB')
      if (size) parts.push(await reader.read(size))
    }
    await append(headerSize)
    for (;;) {
      const blockHeader = await reader.read(3)
      parts.push(blockHeader)
      frameBytes += 3
      const value = blockHeader.readUIntLE(0, 3)
      const type = (value >>> 1) & 3
      const size = value >>> 3
      if (type === 3 || size > 131072) throw new Error('Invalid Zstandard block header')
      await append(type === 1 ? 1 : size)
      if (value & 1) break
    }
    if (descriptor & 4) await append(4)
    yield await decompress(Buffer.concat(parts, frameBytes), { maxOutputLength: MAX_FRAME_BYTES })
  }
}

if (require.main === module) {
  const input = process.argv[2]
  if (!input) {
    console.error('usage: zstdcat.js <file.zstd>')
    process.exitCode = 64
  } else {
    pipeline(fs.createReadStream(input), decodeFrames, process.stdout, error => {
      if (!error || error.code === 'EPIPE') return
      console.error(`zstdcat: ${error.message || error}`)
      process.exitCode = 1
    })
  }
}

module.exports = { decodeFrames }
