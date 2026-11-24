import { describe, expect, it } from 'vitest'
import { arrivals, depthOf, newestOf, withArrivals } from './arrivals'
import { message } from './fixtures'

const at = (id: string, receivedAt: string) => ({ ...message(id, 'someone@example.com', id), receivedAt })

describe('arrivals', () => {
  it('starts the next look at the latest mail seen, shown or not', () => {
    expect(newestOf([at('a', '2026-11-02T09:00:00Z'), at('b', '2026-11-02T11:00:00Z')])).toBe('2026-11-02T11:00:00Z')
    expect(newestOf([at('a', '2026-11-02T09:00:00Z')], '2026-11-02T12:00:00Z')).toBe('2026-11-02T12:00:00Z')
    expect(newestOf([], '2026-11-02T12:00:00Z')).toBe('2026-11-02T12:00:00Z')
    expect(newestOf([])).toBeUndefined()
  })

  it('keeps only mail the screen does not have, once each', () => {
    const held = [at('old', '2026-11-02T09:00:00Z')]
    const found = [at('new', '2026-11-02T10:00:00Z'), at('old', '2026-11-02T09:00:00Z'), at('new', '2026-11-02T10:00:00Z'), at('archived', '2026-11-02T09:30:00Z')]
    expect(arrivals(found, held, new Set(['archived'])).map((item) => item.id)).toEqual(['new'])
  })

  it('shows arrivals at once and swaps in the sorted batch without doubling or bringing back what left', () => {
    const held = [at('old', '2026-11-02T09:00:00Z')]
    const batch = new Set(['n1', 'n2', 'n3'])
    const first = withArrivals(held, batch, [at('n1', 'x'), at('n2', 'x'), at('n3', 'x')], new Set())
    expect(first.map((item) => item.id)).toEqual(['n1', 'n2', 'n3', 'old'])
    // The sorter archived n2, and n3 was archived by hand while it ran.
    const settled = withArrivals(first, batch, [at('n1', 'x'), at('n3', 'x')], new Set(['n3']))
    expect(settled.map((item) => item.id)).toEqual(['n1', 'old'])
  })

  it('reads a full check back to the oldest mail on the list and no further, so clearing mail pulls nothing older in', () => {
    const shown = [at('a', '2026-11-02T09:00:00Z'), at('b', '2026-11-02T11:00:00Z')]
    expect(depthOf('2026-11-02T09:00:00Z', shown)).toBe('2026-11-02T09:00:00Z')
    // The oldest was cleared: the depth stays where the last read ended instead of moving with the count.
    expect(depthOf('2026-11-02T09:00:00Z', [shown[1]])).toBe('2026-11-02T09:00:00Z')
    // Everything was cleared.
    expect(depthOf('2026-11-02T09:00:00Z', [])).toBe('2026-11-02T09:00:00Z')
    // The saved list on open, before anything has been read, and a list that load more took deeper.
    expect(depthOf(undefined, shown)).toBe('2026-11-02T09:00:00Z')
    expect(depthOf('2026-11-02T10:00:00Z', shown)).toBe('2026-11-02T09:00:00Z')
    expect(depthOf(undefined, [])).toBeUndefined()
  })
})
