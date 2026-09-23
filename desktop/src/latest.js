'use strict'

;(function publishLatestGate(root) {
  function createLatestGate() {
    let revision = 0
    return {
      begin() {
        const mine = ++revision
        return () => mine === revision
      },
      invalidate() { revision += 1 }
    }
  }

  const api = { createLatestGate }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.latestCommit = api
})(typeof window !== 'undefined' ? window : null)
