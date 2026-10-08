const test = require('node:test')
const assert = require('node:assert/strict')
const { create } = require('../src/bubble-carousel')

const group = (platform, ...taskIDs) => ({ platform, taskIDs })
function front(carousel, groups) {
  const platform = groups[carousel.platformIndex].platform
  return carousel.selectedTaskID(platform)
}

test('a single platform cycles through every running task', () => {
  const groups = [group('codex', 'A', 'B', 'C')], carousel = create(), seen = []
  carousel.reconcile(groups)
  for (let i = 0; i < 4; i++) { seen.push(front(carousel, groups)); carousel.advance() }
  assert.deepEqual(seen, ['A', 'B', 'C', 'A'])
})

test('frequent activity sorting does not restart or reorder the cycle', () => {
  const carousel = create()
  carousel.reconcile([group('codex', 'A', 'B', 'C')])
  carousel.advance()
  for (let i = 0; i < 10; i++) carousel.reconcile([group('codex', 'C', 'A', 'B')])
  assert.equal(carousel.selectedTaskID('codex'), 'B')
  carousel.advance()
  assert.equal(carousel.selectedTaskID('codex'), 'C')
  carousel.advance()
  assert.equal(carousel.selectedTaskID('codex'), 'A')
})

test('two platforms with two tasks each never skip a task', () => {
  const groups = [group('codex', 'A', 'B'), group('claude', 'C', 'D')]
  const carousel = create(), seen = []
  carousel.reconcile(groups)
  for (let i = 0; i < 6; i++) { seen.push(front(carousel, groups)); carousel.advance() }
  assert.deepEqual(seen, ['A', 'C', 'B', 'D', 'A', 'C'])
})

test('completed, dismissed and hidden tasks leave the cycle; new tasks join without a jump', () => {
  const carousel = create()
  carousel.reconcile([group('codex', 'A', 'B')])
  carousel.advance()
  carousel.reconcile([group('codex', 'C', 'B', 'A')])
  assert.equal(carousel.selectedTaskID('codex'), 'B')
  carousel.advance()
  assert.equal(carousel.selectedTaskID('codex'), 'C')
  carousel.reconcile([group('codex', 'B', 'A')])
  assert.equal(carousel.selectedTaskID('codex'), 'A')
  assert.equal(carousel.taskCount, 2)
  carousel.reconcile([])
  assert.equal(carousel.taskCount, 0)
  assert.equal(carousel.selectedTaskID('codex'), undefined)
})

test('removing another platform preserves the current platform and task; reset restores the first', () => {
  const carousel = create()
  carousel.reconcile([group('codex', 'A', 'B'), group('claude', 'C', 'D')])
  carousel.advance()
  carousel.reconcile([group('claude', 'D', 'C')])
  assert.equal(carousel.platformIndex, 0)
  assert.equal(carousel.selectedTaskID('claude'), 'C')
  carousel.advance()
  assert.equal(carousel.selectedTaskID('claude'), 'D')
  carousel.reset()
  assert.equal(carousel.selectedTaskID('claude'), 'C')
})

test('one task and empty or duplicated groups remain safe to advance', () => {
  const carousel = create()
  carousel.advance()
  carousel.reconcile([group('', 'X'), group('claude'), group('codex', '', 'A', 'A'), group('codex', 'B')])
  for (let i = 0; i < 5; i++) carousel.advance()
  assert.equal(carousel.taskCount, 1)
  assert.equal(carousel.selectedTaskID('codex'), 'A')
})
