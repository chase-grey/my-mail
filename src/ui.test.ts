import { expect, it } from 'vitest'
import { ghostIndex } from './ui'

it('keeps a row that left in the place it left from', () => {
  expect(ghostIndex(['a', 'b', 'c'], 1, ['a', 'c'])).toBe(1)
  expect(ghostIndex(['a', 'b', 'c'], 0, ['b', 'c'])).toBe(0)
  expect(ghostIndex(['a', 'b', 'c'], 2, ['a', 'b'])).toBe(2)
  // Its neighbour left too: fall back to the nearest row that stayed.
  expect(ghostIndex(['a', 'b', 'c'], 2, ['a'])).toBe(1)
})
