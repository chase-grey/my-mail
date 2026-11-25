import { describe, expect, it } from 'vitest'
import { message } from './fixtures'
import { readable } from './text'
import { hitThreads, inboxThreads, sweepStep, threadKey } from './threads'
import type { Triage } from './types'

const triage = (messageId: string, overrides: Partial<Triage>): Triage => ({
  messageId, category: 'fyi', summary: '', needsReply: false, suggested: 'archive', confidence: 0.9, source: 'model', triagedAt: 'now', ...overrides,
})

describe('threads', () => {
  it('makes one inbox row per conversation, led by the newest message with the rest behind it', () => {
    const rows = inboxThreads([
      { message: message('m1', 'owen@example.com', 'cabin', { conversationId: 'c1', receivedAt: '2026-11-01T09:00:00Z' }), triage: triage('m1', {}) },
      { message: message('m2', 'tess@example.com', 'Re: cabin', { conversationId: 'c1', receivedAt: '2026-11-03T09:00:00Z' }), triage: triage('m2', {}) },
      { message: message('m3', 'news@example.com', 'digest', { conversationId: 'c2', receivedAt: '2026-11-02T09:00:00Z' }), triage: triage('m3', { category: 'newsletter' }) },
      { message: message('m4', 'owen@example.com', 'Re: cabin', { conversationId: 'c1', receivedAt: '2026-11-02T09:00:00Z' }), triage: triage('m4', {}) },
    ])
    expect(rows.map((row) => row.key)).toEqual(['c1', 'c2'])
    expect(rows[0].message.id).toBe('m2')
    expect(rows[0].all.map((item) => item.id)).toEqual(['m2', 'm4', 'm1'])
    expect(rows[1].all).toHaveLength(1)
  })

  it('keeps a conversation with the mail that needs me when any message in it does, not only the newest', () => {
    const rows = inboxThreads([
      { message: message('m1', 'news@example.com', 'digest', { conversationId: 'c2', receivedAt: '2026-11-04T09:00:00Z' }), triage: triage('m1', { category: 'newsletter' }) },
      { message: message('m2', 'owen@example.com', 'Re: cabin', { conversationId: 'c1', receivedAt: '2026-11-03T09:00:00Z' }), triage: triage('m2', { category: 'notification' }) },
      { message: message('m3', 'owen@example.com', 'cabin', { conversationId: 'c1', receivedAt: '2026-11-01T09:00:00Z' }), triage: triage('m3', { category: 'reply', needsReply: true }) },
    ], '2026-11-05T00:00:00Z')
    // The owed reply puts the conversation first, and the row still shows its newest message.
    expect(rows.map((row) => [row.key, row.message.id, row.needsMe])).toEqual([['c1', 'm2', true], ['c2', 'm1', false]])
  })

  it('treats mail with no conversation as a thread of its own', () => {
    const lone = message('m1', 'a@example.com')
    expect(threadKey(lone)).toBe('m1')
    expect(inboxThreads([{ message: lone }, { message: message('m2', 'a@example.com') }])).toHaveLength(2)
  })

  it('groups found mail by conversation, newest first, leaving out the conversation it was found from', () => {
    const hit = (id: string, conversationId: string, receivedAt: string) => ({ message: message(id, 'a@example.com', id, { conversationId, receivedAt }), inInbox: false, folder: 'Archive' })
    const found = hitThreads([hit('a', 'c1', '2026-01-01T00:00:00Z'), hit('b', 'c2', '2026-03-01T00:00:00Z'), hit('c', 'c1', '2026-05-01T00:00:00Z'), hit('d', 'own', '2026-06-01T00:00:00Z')], 'own')
    expect(found.map((thread) => [thread.key, thread.message.id])).toEqual([['c1', 'c'], ['c2', 'b']])
  })

  it('reads a message whole, dropping quoted history only when the quoted mail is shown beside it', () => {
    const body = 'Sounds good.\r\n\r\nOn Mon, Nov 2, 2026 at 9:00 AM Owen wrote:\r\n> Who is in?\r\n'
    expect(readable(body, true)).toBe('Sounds good.')
    expect(readable(body, false)).toBe('Sounds good.\n\nOn Mon, Nov 2, 2026 at 9:00 AM Owen wrote:\n> Who is in?')
    expect(readable('x'.repeat(5000), true)).toHaveLength(5000)
  })
})

describe('an archive all that keeps going', () => {
  const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T09:00:00Z`
  const row = (id: string, day: number, conversationId?: string) => ({ message: message(id, `${id}@example.com`, id, { receivedAt: at(day), conversationId }) })
  const list = (...rows: ReturnType<typeof row>[]) => inboxThreads(rows)
  const keys = (step: ReturnType<typeof sweepStep>) => step.do === 'archive' ? step.batch.map((item) => item.key) : step.do

  it('takes everything on the list but what it was told to leave', () => {
    expect(keys(sweepStep(list(row('a', 5), row('b', 4), row('c', 3)), new Set(['b']), at(5), true))).toEqual(['a', 'c'])
  })

  it('asks for older mail once the list is clear, and takes that too', () => {
    const spare = new Set(['b'])
    expect(sweepStep(list(row('b', 4)), spare, at(5), true)).toEqual({ do: 'load' })
    expect(keys(sweepStep(list(row('b', 4), row('d', 2), row('e', 1)), spare, at(5), true))).toEqual(['d', 'e'])
  })

  it('ends when the mailbox has no more', () => {
    expect(sweepStep(list(row('b', 4)), new Set(['b']), at(5), false)).toEqual({ do: 'end' })
    expect(sweepStep([], new Set(), at(5), false)).toEqual({ do: 'end' })
  })

  it('leaves mail that arrived after it began, and a conversation that got a new message', () => {
    const order = list(row('new', 9), row('old1', 2, 'thread'), row('old2', 8, 'thread'), row('c', 3))
    expect(keys(sweepStep(order, new Set(), at(5), true))).toEqual(['c'])
  })

  it('keeps leaving a spared conversation when older mail in it loads', () => {
    const order = list(row('b', 4, 'kept'), row('b0', 1, 'kept'), row('d', 2))
    expect(keys(sweepStep(order, new Set(['kept']), at(5), true))).toEqual(['d'])
  })
})
