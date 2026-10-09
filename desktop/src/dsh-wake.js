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

// A platform click has no session target: focus the existing page without
// navigating or resetting its current session. Only a confirmed miss may open.
async function performDshPlatformWake({ runtimePlatform, reuseDSHTab, openExternal }) {
  const failure = message => ({ succeeded: false, requested: false, exact: false, openedApp: false, message })
  try {
    if (runtimePlatform === 'darwin') {
      const result = await reuseDSHTab('')
      if (result.status === 'reused') {
        return { succeeded: true, requested: true, exact: true, openedApp: false, message: '已聚焦现有 DSH 标签页，保留当前会话。' }
      }
      if (result.status !== 'missing') {
        return failure(`${result.message || '无法确认已有 DSH 标签页'}。为避免重复窗口，未打开新页面。`)
      }
    }
    await openExternal(DSH_BASE_URL)
    return { succeeded: true, requested: true, exact: false, openedApp: false, message: '已发送打开 DSH 页面请求，未验证页面是否已显示。' }
  } catch (error) {
    return failure(String(error && error.message || error))
  }
}

module.exports = { DSH_BASE_URL, DSH_SESSION_HASH_PREFIX, dshSessionURL, performDshPlatformWake }
