import { describe, expect, it, vi } from 'vitest'
import { GraphError, type GraphClient } from './graphClient'
import { MailProvider, fromGraph, verdictProperty } from './mailProvider'

const verdict = { category: 'reply' as const, summary: 'mom asks about sunday dinner', needsReply: true, suggested: 'reply' as const, confidence: 0.9 }
const stored = '{"c":"reply","s":"mom asks about sunday dinner","r":true,"a":"reply","p":0.9}'
const graphMessage = (id: string, extra = {}) => ({ id, receivedDateTime: '2026-11-02T15:00:00Z', isRead: false, webLink: 'w', ...extra })

describe('verdicts on messages', () => {
  it('reads the verdict with the mail', async () => {
    expect(fromGraph(graphMessage('a', { singleValueExtendedProperties: [{ id: verdictProperty, value: stored }] })).verdict).toEqual({ ...verdict, task: undefined })
    expect(fromGraph(graphMessage('b')).verdict).toBeUndefined()
    const request = vi.fn(async (_path: string) => ({ value: [graphMessage('a', { singleValueExtendedProperties: [{ id: verdictProperty, value: stored }] })] }))
    const page = await new MailProvider({ request } as unknown as GraphClient).inbox()
    expect(decodeURIComponent(request.mock.calls[0][0].replace(/\+/g, ' '))).toContain(`$expand=singleValueExtendedProperties($filter=id eq '${verdictProperty}')`)
    expect(page.messages[0].verdict?.summary).toBe('mom asks about sunday dinner')
  })

  it('writes the whole verdict beside the category, keeping other categories', async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({ value: [] }))
    await new MailProvider({ request } as unknown as GraphClient).setVerdict('a/b', ['family', 'fyi'], verdict)
    const [path, init] = request.mock.calls.find(([, sent]) => sent?.method === 'PATCH')!
    expect(path).toBe('/me/messages/a%2Fb')
    expect(JSON.parse(init!.body as string)).toEqual({ categories: ['family', 'reply'], singleValueExtendedProperties: [{ id: verdictProperty, value: stored }] })
  })

  it('still loads mail and shares the category when the mailbox refuses the property', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.includes('expand') || String(init?.body ?? '').includes('singleValueExtendedProperties')) throw new GraphError(400, '{}')
      return { value: [graphMessage('a')] }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mail = new MailProvider({ request } as unknown as GraphClient)
    expect((await mail.inbox()).messages.map((message) => message.id)).toEqual(['a'])
    request.mockClear()
    // It is not asked for again this session.
    await mail.inbox()
    expect(request.mock.calls.every(([path]) => !path.includes('expand'))).toBe(true)
    request.mockClear()
    await mail.setVerdict('a', [], verdict)
    const patches = request.mock.calls.filter(([, sent]) => sent?.method === 'PATCH')
    expect(patches.map(([, sent]) => JSON.parse(sent!.body as string))).toEqual([{ categories: ['reply'] }])
    request.mockClear()
    await mail.setVerdict('a', ['reply'], verdict)
    expect(request.mock.calls.filter(([, sent]) => sent?.method === 'PATCH')).toEqual([])
    warn.mockRestore()
  })
})
