const test = require('node:test')
const assert = require('node:assert/strict')
const { plan } = require('../src/motion')

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
