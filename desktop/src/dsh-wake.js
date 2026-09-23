'use strict'

const DSH_BASE_URL = 'http://127.0.0.1:3080/'
const DSH_SESSION_HASH_PREFIX = 'allpet-session='

function dshSessionURL(sessionID) {
  const id = String(sessionID || '').trim()
  if (!id) return null
  const url = new URL(DSH_BASE_URL)
  url.hash = `${DSH_SESSION_HASH_PREFIX}${encodeURIComponent(id)}`
  return url.href
}

module.exports = { DSH_BASE_URL, DSH_SESSION_HASH_PREFIX, dshSessionURL }
