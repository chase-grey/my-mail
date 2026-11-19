import { describe, expect, it } from 'vitest'
import { message } from './fixtures'
import { autoArchivable, groupInbox, needsReading, outlookTriage, pruneTriage, rankTriaged, summarize, summaryLine } from './triage'
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
    ])
    expect(groups.needsMe.map((item) => item.message.id).sort()).toEqual(['m2', 'm3', 'm4', 'm5'])
    expect(groups.probablyFine.map((item) => item.message.id).sort()).toEqual(['m1', 'm6'])
  })

  it('sends a language model only what needs me or is still unsummarized and unsure', () => {
    const plain = message('m1', 'a@example.com')
    expect(needsReading(plain, undefined)).toBe(true)
    expect(needsReading(plain, triage('m1', { category: 'reply', source: 'jev' }))).toBe(true)
    expect(needsReading(plain, triage('m1', { category: 'reply', source: 'jev', summary: 'already read' }))).toBe(false)
    expect(needsReading(plain, triage('m1', { category: 'promo', source: 'jev', confidence: 0.9 }))).toBe(false)
    expect(needsReading(plain, triage('m1', { category: 'promo', source: 'jev', confidence: 0.3 }))).toBe(true)
    expect(needsReading(plain, triage('m1', { category: 'newsletter', source: 'history' }))).toBe(false)
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

  it('summarizes a run in one line and drops the zero parts', () => {
    const items = [{ message: message('m1', 'a@example.com'), triage: triage('m1', { needsReply: true }) }, { message: message('m2', 'b@example.com') }]
    expect(summaryLine(summarize(items, { byRules: 2, autoArchived: 0, returned: 1, withoutModel: 0 }))).toBe('2 in inbox · 1 need a reply · 2 by rules · 1 back from snooze')
    expect(summaryLine({ inbox: 4, needReply: 0, byRules: 0, autoArchived: 3, returned: 0, withoutModel: 3, newRules: 2 })).toBe('4 in inbox · 3 auto-archived · 2 new rules')
    expect(summaryLine({ inbox: 4, needReply: 0, byRules: 0, autoArchived: 3, filed: 2, returned: 0, withoutModel: 3 })).toBe('4 in inbox · 1 auto-archived · 2 to receipts')
    expect(summaryLine({ inbox: 4, needReply: 0, byRules: 0, autoArchived: 2, filed: 2, returned: 0, withoutModel: 2 })).toBe('4 in inbox · 2 to receipts')
    expect(summaryLine(summarize([], { byRules: 0, autoArchived: 0, returned: 0, withoutModel: 0 }))).toBe('0 in inbox')
  })

  it('prunes cached triage for messages that left the inbox', () => {
    const cache = { m1: triage('m1', {}), m2: triage('m2', {}) }
    expect(Object.keys(pruneTriage(cache, [message('m2', 'b@example.com')]))).toEqual(['m2'])
  })
})
