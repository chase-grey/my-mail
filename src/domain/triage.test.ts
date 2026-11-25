import { describe, expect, it } from 'vitest'
import { message } from './fixtures'
import { ageTriage, autoArchivable, claudeReads, groupInbox, needsReading, outlookTriage, pruneTriage, rankTriaged, summarize } from './triage'
import type { Triage } from './types'

const triage = (messageId: string, overrides: Partial<Triage>): Triage => ({
  messageId, category: 'fyi', summary: '', needsReply: false, suggested: 'keep', confidence: 0.9, source: 'model', triagedAt: 'now', ...overrides,
})

describe('triage', () => {
  it('ranks replies first, then actions, then the rest, newest first inside a group', () => {
    const items = [
      { message: message('m1', 'a@example.com', 'promo', { receivedAt: '2026-11-02T09:00:00Z' }), triage: triage('m1', { category: 'promo' }) },
      { message: message('m2', 'b@example.com', 'old reply', { receivedAt: '2026-11-01T09:00:00Z' }), triage: triage('m2', { category: 'reply', needsReply: true }) },
      { message: message('m3', 'c@example.com', 'untriaged', { receivedAt: '2026-11-02T12:00:00Z' }) },
      { message: message('m4', 'd@example.com', 'new reply', { receivedAt: '2026-11-02T10:00:00Z' }), triage: triage('m4', { category: 'reply', needsReply: true }) },
    ]
    expect(rankTriaged(items).map((item) => item.message.id)).toEqual(['m4', 'm2', 'm3', 'm1'])
  })

  it('splits the inbox into what needs me and what is probably fine', () => {
    const groups = groupInbox([
      { message: message('m1', 'a@example.com'), triage: triage('m1', { category: 'promo', confidence: 0.9 }) },
      { message: message('m2', 'b@example.com'), triage: triage('m2', { category: 'promo', confidence: 0.4 }) },
      { message: message('m3', 'c@example.com', 'flagged', { flagged: true }), triage: triage('m3', { category: 'newsletter' }) },
      { message: message('m4', 'd@example.com') },
      { message: message('m5', 'e@example.com'), triage: triage('m5', { category: 'action' }) },
      { message: message('m6', 'f@example.com'), triage: triage('m6', { category: 'receipt', confidence: 0.95 }) },
    ], '2026-11-10T00:00:00Z')
    expect(groups.needsMe.map((item) => item.message.id).sort()).toEqual(['m2', 'm3', 'm4', 'm5'])
    expect(groups.probablyFine.map((item) => item.message.id).sort()).toEqual(['m1', 'm6'])
  })

  it('keeps unsorted mail out of needs me while its verdict is on the way, and counts it once no verdict is coming', () => {
    const now = '2026-11-05T00:00:00Z'
    const fresh = message('m1', 'owen@example.com', 'cabin', { receivedAt: '2026-11-04T09:00:00Z' })
    expect(groupInbox([{ message: fresh, pending: true }], now).needsMe).toHaveLength(0)
    expect(groupInbox([{ message: fresh }], now).needsMe).toHaveLength(1)
    // A flag or high importance does not wait for a verdict.
    expect(groupInbox([{ message: { ...fresh, flagged: true }, pending: true }], now).needsMe).toHaveLength(1)
    // Once the verdict lands it decides, whatever pending still says.
    expect(groupInbox([{ message: fresh, triage: triage('m1', { category: 'reply', needsReply: true }), pending: true }], now).needsMe).toHaveLength(1)
  })

  it('sends a language model only what needs me or is still unsummarized and unsure', () => {
    const plain = message('m1', 'a@example.com')
    const now = '2026-11-10T00:00:00Z'
    expect(needsReading(plain, undefined, now)).toBe(true)
    // Jev could not be reached: Claude does not sort in its place, but still reads what already has a verdict and needs me.
    expect(claudeReads(plain, undefined, true, now)).toBe(false)
    expect(claudeReads(plain, undefined, false, now)).toBe(true)
    expect(claudeReads(plain, triage('m1', { category: 'reply', source: 'jev' }), true, now)).toBe(true)
    expect(needsReading(plain, triage('m1', { category: 'reply', source: 'jev' }), now)).toBe(true)
    expect(needsReading(plain, triage('m1', { category: 'reply', source: 'jev', summary: 'already read' }), now)).toBe(false)
    expect(needsReading(plain, triage('m1', { category: 'promo', source: 'jev', confidence: 0.9 }), now)).toBe(false)
    expect(needsReading(plain, triage('m1', { category: 'promo', source: 'jev', confidence: 0.3 }), now)).toBe(true)
    expect(needsReading(plain, triage('m1', { category: 'newsletter', source: 'history' }), now)).toBe(false)
  })

  it('spends no model on mail older than thirty days, whatever it once asked for', () => {
    const now = '2026-11-24T00:00:00Z'
    const old = message('m1', 'a@example.com', 'can you call me?', { receivedAt: '2026-10-20T09:00:00Z' })
    const recent = message('m2', 'a@example.com', 'can you call me?', { receivedAt: '2026-10-26T09:00:00Z' })
    expect(ageTriage(recent, now)).toBeUndefined()
    const verdict = ageTriage(old, now)
    expect(verdict).toMatchObject({ category: 'fyi', needsReply: false, source: 'age', confidence: 1 })
    expect(needsReading(old, undefined, now)).toBe(false)
    expect(needsReading(old, triage('m1', { category: 'reply', needsReply: true, source: 'outlook' }), now)).toBe(false)
    expect(needsReading({ ...old, flagged: true }, verdict, now)).toBe(false)
    // It waits under probably fine and is never cleared on its own.
    expect(groupInbox([{ message: old, triage: verdict }]).probablyFine).toHaveLength(1)
    expect(autoArchivable(old, verdict!)).toBe(false)
  })

  it('never counts old mail as needing me, even flagged, important, or still marked as owing a reply', () => {
    const now = '2026-11-24T00:00:00Z'
    const old = { receivedAt: '2021-06-17T09:00:00Z' }
    const groups = groupInbox([
      { message: message('m1', 'a@example.com', 'rehearsal dinner', { ...old, flagged: true }) },
      { message: message('m2', 'b@example.com', 'action required', { ...old, importance: 'high' }), triage: triage('m2', { category: 'action', suggested: 'task', source: 'outlook' }) },
      { message: message('m3', 'c@example.com', 'can you call me?', old), triage: triage('m3', { category: 'reply', needsReply: true }) },
      { message: message('m4', 'd@example.com', 'flagged last week', { receivedAt: '2026-11-18T09:00:00Z', flagged: true }), triage: triage('m4', { category: 'newsletter' }) },
    ], now)
    expect(groups.needsMe.map((item) => item.message.id)).toEqual(['m4'])
    expect(groups.probablyFine).toHaveLength(3)
  })

  it('only auto-archives confident noise that is not flagged or important', () => {
    const promo = message('m1', 'deals@shop.example.com')
    expect(autoArchivable(promo, triage('m1', { category: 'promo', suggested: 'archive', confidence: 0.95 }))).toBe(true)
    expect(autoArchivable(promo, triage('m1', { category: 'promo', suggested: 'archive', confidence: 0.6 }))).toBe(false)
    expect(autoArchivable(promo, triage('m1', { category: 'fyi', suggested: 'archive', confidence: 0.99 }))).toBe(false)
    expect(autoArchivable(promo, triage('m1', { category: 'newsletter', suggested: 'keep', confidence: 0.99 }))).toBe(false)
    expect(autoArchivable({ ...promo, flagged: true }, triage('m1', { category: 'promo', suggested: 'archive', confidence: 0.99 }))).toBe(false)
    expect(autoArchivable({ ...promo, importance: 'high' }, triage('m1', { category: 'promo', suggested: 'archive', confidence: 0.99 }))).toBe(false)
  })

  it('reads a verdict another device already wrote as an outlook category', () => {
    expect(outlookTriage(message('m1', 'a@example.com', 'x', { categories: ['Blue category', 'newsletter'] }), 'now')).toMatchObject({ category: 'newsletter', suggested: 'archive', source: 'outlook', confidence: 1 })
    expect(outlookTriage(message('m1', 'a@example.com', 'x', { categories: ['reply'] }), 'now')).toMatchObject({ category: 'reply', needsReply: true, suggested: 'reply' })
    expect(outlookTriage(message('m1', 'a@example.com'), 'now')).toBeUndefined()
  })

  it('counts a run', () => {
    const items = [{ message: message('m1', 'a@example.com'), triage: triage('m1', { needsReply: true }) }, { message: message('m2', 'b@example.com') }]
    expect(summarize(items, { byRules: 2, autoArchived: 0, returned: 1, withoutModel: 0 })).toEqual({ inbox: 2, needReply: 1, byRules: 2, autoArchived: 0, returned: 1, withoutModel: 0 })
  })

  it('prunes cached triage for messages that left the inbox', () => {
    const cache = { m1: triage('m1', {}), m2: triage('m2', {}) }
    expect(Object.keys(pruneTriage(cache, [message('m2', 'b@example.com')]))).toEqual(['m2'])
  })
})
