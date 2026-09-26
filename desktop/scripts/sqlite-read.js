'use strict'
// Runs in the packaged Electron Node runtime; never creates or updates a platform DB.
const fs = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const [file, query] = process.argv.slice(2)
if (!file || !query || !/^\s*SELECT\b/i.test(query)) throw new Error('Expected read-only SELECT')
const stat = fs.lstatSync(file)
if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular database file')
const db = new DatabaseSync(file, { readOnly: true, timeout: 1000 })
try {
  db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;')
  const result = JSON.stringify(db.prepare(query).all())
  if (Buffer.byteLength(result) > 1048576) throw new Error('Result exceeds display metadata limit')
  process.stdout.write(result)
} finally { db.close() }
