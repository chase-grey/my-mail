import { describe, expect, it } from 'vitest'
import { newer, parseAutomation } from './automationStore'

describe('automation store', () => {
  it('repairs a half-formed file into empty lists', () => {
    expect(parseAutomation({ rules: 'nope', updatedAt: 5 })).toEqual({ rules: [], decisions: [], snoozes: [], updatedAt: '' })
    expect(parseAutomation(null)).toBeUndefined()
  })

  it('keeps whichever copy was saved last', () => {
    const older = { rules: [], decisions: [], snoozes: [], updatedAt: '2026-11-01T00:00:00Z' }
    const latest = { ...older, updatedAt: '2026-11-02T00:00:00Z' }
    expect(newer(older, latest)).toBe(latest)
    expect(newer(latest, older)).toBe(latest)
    expect(newer(undefined, older)).toBe(older)
    expect(newer(undefined, undefined).updatedAt).toBe('')
  })
})
