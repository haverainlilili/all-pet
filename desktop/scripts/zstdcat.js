'use strict'

const fs = require('node:fs')
const { pipeline } = require('node:stream')
const { createZstdDecompress } = require('node:zlib')

const input = process.argv[2]
if (!input) {
  console.error('usage: zstdcat.js <file.zstd>')
  process.exit(64)
}

pipeline(fs.createReadStream(input), createZstdDecompress(), process.stdout, (error) => {
  if (!error || error.code === 'EPIPE') return
  console.error(`zstdcat: ${error.message || error}`)
  process.exitCode = 1
})
