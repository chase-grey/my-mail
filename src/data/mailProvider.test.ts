import { describe, expect, it, vi } from 'vitest'
import { GraphClient, GraphError } from './graphClient'
import { MailProvider, fromGraph, mailDefaultHeaders, tidyBody } from './mailProvider'

describe('mail provider', () => {
  it('maps a graph message, lowercasing the address and trimming the body', () => {
    const message = fromGraph({ id: 'AAMk', subject: '  Dinner? ', from: { emailAddress: { name: ' Mom ', address: 'Mom@Example.com' } }, receivedDateTime: '2026-11-02T15:00:00Z', bodyPreview: 'Sunday?', body: { contentType: 'text', content: 'Sunday?\r\n\n\n\nLove,  \nMom' }, isRead: false, flag: { flagStatus: 'flagged' }, webLink: 'https://outlook.live.com/x' })
    expect(message).toMatchObject({ id: 'AAMk', subject: 'Dinner?', from: { name: 'Mom', address: 'mom@example.com' }, flagged: true, importance: 'normal', body: 'Sunday?\n\nLove,\nMom' })
    expect(fromGraph({ id: 'b', receivedDateTime: 'x', isRead: true, webLink: 'w' }).subject).toBe('(no subject)')
    expect(tidyBody('a'.repeat(2000), 10)).toBe(`${'a'.repeat(10)}…`)
  })

  it('asks graph for immutable ids and text bodies on every call', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ value: [] }), { status: 200 }))
    const graph = new GraphClient(async () => 'token', fetcher as unknown as typeof fetch, 'https://graph.example', mailDefaultHeaders)
    await new MailProvider(graph).inbox()
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/me/mailFolders/inbox/messages?')
    expect(new Headers(init.headers).get('Prefer')).toBe(mailDefaultHeaders.Prefer)
  })

  it('moves messages with the well-known folder names and finds or creates the snoozed folder once', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/me/mailFolders?')) return { value: [] }
      if (path === '/me/mailFolders' && init?.method === 'POST') return { id: 'snoozed-id', displayName: 'snoozed' }
      return undefined
    })
    const provider = new MailProvider({ request } as unknown as GraphClient)
    await provider.archive('m1')
    await provider.delete('m2')
    await provider.snooze('m3')
    await provider.snooze('m4')
    const moves = request.mock.calls.filter(([path]) => path.endsWith('/move')).map(([, init]) => JSON.parse(init!.body as string).destinationId)
    expect(moves).toEqual(['archive', 'deleteditems', 'snoozed-id', 'snoozed-id'])
    expect(request.mock.calls.filter(([path]) => path === '/me/mailFolders')).toHaveLength(1)
  })

  it('treats a vanished snoozed message as already handled', async () => {
    const request = vi.fn(async () => { throw new GraphError(404, 'gone') })
    await expect(new MailProvider({ request } as unknown as GraphClient).unsnooze('m1')).resolves.toBe(false)
  })
})
