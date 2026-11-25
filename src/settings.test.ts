import { describe, expect, it } from 'vitest'
import { aiSorts, aiStartsItself, defaultSettings, manageableInbox, parseSettings } from './settings'

describe('sorting with ai', () => {
  const keyed = { ...defaultSettings, jevApiKey: 'j' }

  it('does not start because a key was added', () => {
    expect(aiSorts(keyed)).toBe(false)
    // An anthropic key never sorts, with sorting on or off: Claude only answers a tap.
    expect(aiSorts({ ...defaultSettings, anthropicApiKey: 'k', aiSorting: true })).toBe(false)
    expect(aiSorts({ ...keyed, aiSorting: true })).toBe(true)
    expect(aiSorts({ ...defaultSettings, aiSorting: true })).toBe(false)
  })

  it('starts itself once the inbox is small enough, and never over a yes or a no', () => {
    expect(aiStartsItself(keyed, manageableInbox + 1)).toBe(false)
    expect(aiStartsItself(keyed, 4000)).toBe(false)
    expect(aiStartsItself(keyed, undefined)).toBe(false)
    expect(aiStartsItself(keyed, manageableInbox)).toBe(true)
    expect(aiStartsItself({ ...defaultSettings, anthropicApiKey: 'k' }, 12)).toBe(false)
    expect(aiStartsItself(defaultSettings, 12)).toBe(false)
    expect(aiStartsItself({ ...keyed, aiSorting: false }, 12)).toBe(false)
    expect(aiStartsItself({ ...keyed, aiSorting: true }, 12)).toBe(false)
  })

  it('keeps the choice, and leaves it unmade for settings saved before there was one', () => {
    expect(parseSettings({ anthropicApiKey: 'k' }).aiSorting).toBeUndefined()
    expect(parseSettings({ aiSorting: false }).aiSorting).toBe(false)
    expect(parseSettings({ aiSorting: true }).aiSorting).toBe(true)
  })
})
