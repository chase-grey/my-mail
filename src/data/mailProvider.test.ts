import { describe, expect, it, vi } from 'vitest'
import { GraphClient, GraphError } from './graphClient'
import { MailProvider, contentKept, fromGraph, mailDefaultHeaders, tidyBody } from './mailProvider'

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

  it('reads a message as it was written, asking for its markup once', async () => {
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify({ body: url.includes('/plain') ? { contentType: 'text', content: 'Sunday?\r\nMom\r\n' } : { contentType: 'html', content: '<p>Sunday?</p>' } }), { status: 200 }))
    const mail = new MailProvider(new GraphClient(async () => 'token', fetcher as unknown as typeof fetch, 'https://graph.example', mailDefaultHeaders))
    expect(await mail.content('a/b')).toEqual({ html: '<p>Sunday?</p>', text: '' })
    expect(await mail.content('a/b')).toEqual({ html: '<p>Sunday?</p>', text: '' })
    expect(await mail.content('plain')).toEqual({ text: 'Sunday?\nMom' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://graph.example/me/messages/a%2Fb?$select=body')
    expect(new Headers(init.headers).get('Prefer')).toBe('IdType="ImmutableId", outlook.body-content-type="html"')
  })

  it('asks again for a message it failed to read, and forgets the oldest past the cap', async () => {
    let fail = true
    const fetcher = vi.fn(async () => fail ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ body: { contentType: 'html', content: '<p>x</p>' } }), { status: 200 }))
    const mail = new MailProvider(new GraphClient(async () => 'token', fetcher as unknown as typeof fetch, 'https://graph.example'))
    await expect(mail.content('a')).rejects.toBeInstanceOf(GraphError)
    fail = false
    expect((await mail.content('a')).html).toBe('<p>x</p>')
    for (let at = 0; at < contentKept; at++) await mail.content(`m${at}`)
    const before = fetcher.mock.calls.length
    await mail.content('a')
    expect(fetcher.mock.calls.length).toBe(before + 1)
  })

  it('follows pages until it has the count asked for, and asks for older mail by date', async () => {
    const graphMessage = (id: string) => ({ id, receivedDateTime: '2026-11-02T15:00:00Z', isRead: true, webLink: 'w' })
    const request = vi.fn(async (path: string) => path === 'next'
      ? { value: [graphMessage('c'), graphMessage('d')] }
      : { value: [graphMessage('a'), graphMessage('b')], '@odata.nextLink': 'next' })
    const provider = new MailProvider({ request } as unknown as GraphClient)

    const first = await provider.inbox(3)
    expect(first.messages.map((message) => message.id)).toEqual(['a', 'b', 'c'])
    expect(first.more).toBe(true)

    const all = await provider.inbox(4)
    expect(all.more).toBe(false)

    await provider.inbox(50, '2026-11-01T09:00:00Z')
    expect(new URLSearchParams(request.mock.calls.at(-2)![0].split('?')[1]).get('$filter')).toBe('receivedDateTime le 2026-11-01T09:00:00Z')
  })

  it('asks for new mail by date, from the latest it has seen', async () => {
    const request = vi.fn(async (_path: string) => ({ value: [] }))
    await new MailProvider({ request } as unknown as GraphClient).inboxSince('2026-11-02T15:00:00Z')
    const [path, query] = request.mock.calls[0][0].split('?')
    expect(path).toBe('/me/mailFolders/inbox/messages')
    expect(new URLSearchParams(query).get('$filter')).toBe('receivedDateTime ge 2026-11-02T15:00:00Z')
  })

  it('glances for new mail in one request that carries no bodies', async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({ responses: [
      { id: 'inbox', status: 200, body: { value: [{ id: 'n1' }, { id: 'n2' }] } },
      { id: 'junk', status: 200, body: { totalItemCount: 3 } },
    ] }))
    const provider = new MailProvider({ request } as unknown as GraphClient)
    expect(await provider.glance('2026-11-02T15:00:00Z')).toEqual({ junk: 3, ids: ['n1', 'n2'] })
    expect(request).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(String(request.mock.calls[0][1]!.body)) as { requests: { id: string; url: string; headers: Record<string, string> }[] }
    const inbox = new URLSearchParams(sent.requests.find((item) => item.id === 'inbox')!.url.split('?')[1])
    expect(inbox.get('$select')).toBe('id')
    expect(inbox.get('$filter')).toBe('receivedDateTime ge 2026-11-02T15:00:00Z')
    expect(sent.requests.every((item) => item.headers.Prefer === mailDefaultHeaders.Prefer)).toBe(true)

    const refused = async () => ({ responses: [{ id: 'inbox', status: 429 }, { id: 'junk', status: 200, body: { totalItemCount: 0 } }] })
    await expect(new MailProvider({ request: refused } as unknown as GraphClient).glance()).rejects.toBeInstanceOf(GraphError)
  })

  it('moves everything in junk to the inbox and returns what moved', async () => {
    const graphMessage = (id: string) => ({ id, receivedDateTime: '2026-11-02T15:00:00Z', isRead: false, webLink: 'w' })
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/me/mailFolders/junkemail/messages?')) return { value: [graphMessage('j1'), graphMessage('j2'), graphMessage('j3')] }
      if (path === '/$batch') {
        const { requests } = JSON.parse(init!.body as string) as { requests: { id: string; url: string; body: { destinationId: string } }[] }
        expect(requests.every((item) => item.body.destinationId === 'inbox')).toBe(true)
        // j2 is refused outright, so it stays in junk and is not reported as rescued.
        return { responses: requests.map((item) => ({ id: item.id, status: item.url.includes('j2') ? 403 : 201 })) }
      }
      return undefined
    })
    const provider = new MailProvider({ request } as unknown as GraphClient, async () => {})
    expect((await provider.rescueJunk()).map((message) => message.id)).toEqual(['j1', 'j3'])

    const empty = vi.fn(async () => ({ value: [] }))
    expect(await new MailProvider({ request: empty } as unknown as GraphClient).rescueJunk()).toEqual([])
    expect(empty).toHaveBeenCalledTimes(1)
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

  it('files receipts in a receipts folder, using one that exists under another casing', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/me/mailFolders?%24filter') || path.startsWith('/me/mailFolders?$filter')) return { value: [] }
      if (path === '/me/mailFolders' && init?.method === 'POST') throw new GraphError(409, 'exists')
      if (path.startsWith('/me/mailFolders?$top')) return { value: [{ id: 'other', displayName: 'Travel' }, { id: 'receipts-id', displayName: 'Receipts' }] }
      if (path.startsWith('/me/mailFolders/archive/messages?')) return { value: [{ id: 'old1' }, { id: 'old2' }] }
      if (path.startsWith('/me/mailFolders/receipts-id/messages?')) return { value: [] }
      return undefined
    })
    const provider = new MailProvider({ request } as unknown as GraphClient)
    await provider.fileReceipt('m1')
    await provider.fileReceipt('m2')
    const moves = request.mock.calls.filter(([path]) => path.endsWith('/move')).map(([, init]) => JSON.parse(init!.body as string).destinationId)
    expect(moves).toEqual(['receipts-id', 'receipts-id'])
    expect(request.mock.calls.filter(([path]) => path === '/me/mailFolders')).toHaveLength(1)

    expect(await provider.archivedReceipts()).toEqual(['old1', 'old2'])
    const filter = request.mock.calls.find(([path]) => path.startsWith('/me/mailFolders/archive/messages?'))![0]
    expect(new URLSearchParams(filter.split('?')[1]).get('$filter')).toBe("categories/any(c:c eq 'receipt')")
    expect((await provider.receipts()).messages).toEqual([])
    await provider.fileReceipts([])
    expect(request.mock.calls.some(([path]) => path === '/$batch')).toBe(false)
  })

  it('sends throttled moves in a batch again, and reports the ones that never move', async () => {
    type Sent = { requests: { id: string; url: string }[] }
    const seen = new Map<string, number>()
    const request = vi.fn(async (_path: string, init?: RequestInit) => ({
      responses: (JSON.parse(init!.body as string) as Sent).requests.map(({ id, url }) => {
        const message = url.split('/')[3]
        const tries = (seen.get(message) ?? 0) + 1
        seen.set(message, tries)
        if (message === 'gone') return { id, status: 404 }
        if (message === 'denied') return { id, status: 403 }
        if (message === 'busy') return { id, status: 429, headers: { 'Retry-After': '7' } }
        return message === 'slow' && tries < 3 ? { id, status: 429 } : { id, status: 201 }
      }),
    }))
    const sleep = vi.fn(async () => undefined)
    const progress: number[] = []
    const left = await new MailProvider({ request } as unknown as GraphClient, sleep).archiveMany(['ok', 'slow', 'gone', 'denied', 'busy'], (done) => progress.push(done))
    expect(left).toEqual(['denied', 'busy'])
    expect(seen.get('ok')).toBe(1)
    expect(seen.get('slow')).toBe(3)
    expect(seen.get('denied')).toBe(1)
    expect(seen.get('busy')).toBe(6)
    expect(progress.at(-1)).toBe(3)
    expect(sleep).toHaveBeenCalledWith(7000)
  })

  it('asks for immutable ids on every move inside a batch', async () => {
    const request = vi.fn(async (_path: string, init?: RequestInit) => ({
      responses: (JSON.parse(init!.body as string) as { requests: { id: string }[] }).requests.map(({ id }) => ({ id, status: 201 })),
    }))
    await new MailProvider({ request } as unknown as GraphClient).archiveMany(['a', 'b'])
    const sent = JSON.parse(request.mock.calls[0][1]!.body as string) as { requests: { headers: Record<string, string> }[] }
    for (const item of sent.requests) expect(item.headers.Prefer).toContain('IdType="ImmutableId"')
  })

  it('treats a vanished snoozed message as already handled', async () => {
    const request = vi.fn(async () => { throw new GraphError(404, 'gone') })
    await expect(new MailProvider({ request } as unknown as GraphClient).unsnooze('m1')).resolves.toBe(false)
  })
})
