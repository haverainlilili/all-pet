'use strict'

;(function publishInteraction(root) {
  function dragMove(dx, dy, alreadyDragging) {
    const crossed = alreadyDragging || Math.hypot(Number(dx) || 0, Number(dy) || 0) >= 4
    return { didDrag: crossed, animation: crossed ? (Number(dx) >= 0 ? 'running-right' : 'running-left') : null }
  }

  function dragRelease(didDrag, pointerInside) {
    return {
      animation: pointerInside ? 'jumping' : null,
      openPlatforms: !didDrag
    }
  }

  const api = { dragMove, dragRelease }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.petInteraction = api
})(typeof window !== 'undefined' ? window : null)
