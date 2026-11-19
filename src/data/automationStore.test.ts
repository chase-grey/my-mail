import { describe, expect, it, vi } from 'vitest'
import { AppFolder } from './appFolder'
import { AutomationStore, newer, parseAutomation } from './automationStore'
import { GraphError, type GraphClient } from './graphClient'

const empty = { rules: [], decisions: [], snoozes: [] }

describe('automation uploads', () => {
  it('never overlaps two uploads and sends only the latest waiting copy', async () => {
    let open = 0
    let most = 0
    const sent: string[] = []
    const writeJson = vi.fn(async (_path: string, value: { updatedAt: string }) => {
      most = Math.max(most, ++open)
      await new Promise((resolve) => setTimeout(resolve, 5))
      sent.push(value.updatedAt)
      open--
    })
    const store = new AutomationStore({ writeJson } as unknown as AppFolder)
    await Promise.all([store.save(empty, 'a'), store.save(empty, 'b'), store.save(empty, 'c')])
    expect(most).toBe(1)
    expect(sent).toEqual(['a', 'c'])
    await store.save(empty, 'd')
    expect(sent).toEqual(['a', 'c', 'd'])
  })

  it('tries a write again when OneDrive answers 409', async () => {
    const request = vi.fn().mockRejectedValueOnce(new GraphError(409, 'conflict')).mockResolvedValue(undefined)
    await new AppFolder({ request } as unknown as GraphClient).writeJson('mail/automation.json', {}, 0)
    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('automation store', () => {
  it('repairs a half-formed file into empty lists', () => {
    expect(parseAutomation({ rules: 'nope', updatedAt: 5 })).toEqual({ rules: [], decisions: [], snoozes: [], noRules: [], updatedAt: '' })
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
