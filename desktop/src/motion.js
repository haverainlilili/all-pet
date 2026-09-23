;(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.petMotion = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function plan(options) {
    const reduceMotion = !!(options && options.reduceMotion)
    const stageIsCollapsed = !!(options && options.stageIsCollapsed)
    const hasActiveTask = !!(options && options.hasActiveTask)
    const unfinishedPlatformCount = Number(options && options.unfinishedPlatformCount) || 0
    return {
      spinsStatus: !reduceMotion && hasActiveTask,
      rotatesPlatforms: !reduceMotion && stageIsCollapsed && unfinishedPlatformCount > 1
    }
  }
  function animationForStatuses(statuses) {
    const phases = (Array.isArray(statuses) ? statuses : []).map(item => String(item && item.phase || 'idle'))
    if (phases.includes('failed')) return 'failed'
    if (phases.some(phase => phase === 'running' || phase === 'thinking')) return 'running'
    if (phases.includes('waiting')) return 'waiting'
    if (phases.includes('done')) return 'review'
    return 'idle'
  }

  return { animationForStatuses, plan }
})
