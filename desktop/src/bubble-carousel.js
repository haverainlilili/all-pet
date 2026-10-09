;(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.petBubbleCarousel = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function create() {
    let platforms = [], frontPlatform = null
    const orders = new Map(), selected = new Map()
    return {
      get platformIndex() { return Math.max(0, platforms.indexOf(frontPlatform)) },
      get taskCount() { return Array.from(orders.values()).reduce((sum, ids) => sum + ids.length, 0) },
      selectedTaskID(platform) { return selected.get(platform) },
      reconcile(groups) {
        const nextPlatforms = []
        for (const group of groups) {
          const ids = Array.from(new Set(group.taskIDs.filter(id => typeof id === 'string' && id.length)))
          if (!group.platform || !ids.length || nextPlatforms.includes(group.platform)) continue
          nextPlatforms.push(group.platform)
          const previous = orders.get(group.platform) || []
          const next = previous.filter(id => ids.includes(id)).concat(ids.filter(id => !previous.includes(id)))
          orders.set(group.platform, next)
          if (!next.includes(selected.get(group.platform))) selected.set(group.platform, next[0])
        }
        platforms = nextPlatforms
        for (const platform of orders.keys()) {
          if (!platforms.includes(platform)) { orders.delete(platform); selected.delete(platform) }
        }
        if (!platforms.includes(frontPlatform)) frontPlatform = platforms[0] || null
      },
      advance() {
        const order = orders.get(frontPlatform)
        if (!order || !order.length) return
        const index = Math.max(0, order.indexOf(selected.get(frontPlatform)))
        selected.set(frontPlatform, order[(index + 1) % order.length])
        frontPlatform = platforms[(this.platformIndex + 1) % platforms.length]
      },
      reset() {
        frontPlatform = platforms[0] || null
        for (const platform of platforms) selected.set(platform, orders.get(platform)[0])
      }
    }
  }
  return { create }
})
