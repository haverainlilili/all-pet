const test = require('node:test')
const assert = require('node:assert/strict')
const { animationForStatuses, plan } = require('../src/motion')

test('reduced motion freezes status spinner and collapsed platform rotation', () => {
  assert.deepEqual(plan({ reduceMotion: true, stageIsCollapsed: true, hasActiveTask: true, unfinishedPlatformCount: 3 }), {
    spinsStatus: false,
    rotatesPlatforms: false
  })
})

test('normal motion rotates only the collapsed multi-platform stack', () => {
  assert.deepEqual(plan({ reduceMotion: false, stageIsCollapsed: true, hasActiveTask: true, unfinishedPlatformCount: 2 }), {
    spinsStatus: true,
    rotatesPlatforms: true
  })
  assert.deepEqual(plan({ reduceMotion: false, stageIsCollapsed: false, hasActiveTask: true, unfinishedPlatformCount: 2 }), {
    spinsStatus: true,
    rotatesPlatforms: false
  })
})

test('single-platform task names rotate only with multiple tasks, collapsed and normal motion', () => {
  const options = { reduceMotion: false, stageIsCollapsed: true, hasActiveTask: true, unfinishedPlatformCount: 1, unfinishedTaskCount: 2 }
  assert.equal(plan(options).rotatesPlatforms, true)
  assert.equal(plan({ ...options, unfinishedTaskCount: 1 }).rotatesPlatforms, false)
  assert.equal(plan({ ...options, stageIsCollapsed: false }).rotatesPlatforms, false)
  assert.equal(plan({ ...options, reduceMotion: true }).rotatesPlatforms, false)
})


test('visible statuses alone drive pet animation after task dismissal', () => {
  assert.equal(animationForStatuses([{ phase: 'idle' }]), 'idle')
  assert.equal(animationForStatuses([{ phase: 'done' }, { phase: 'waiting' }]), 'waiting')
  assert.equal(animationForStatuses([{ phase: 'running' }, { phase: 'failed' }]), 'failed')
})
