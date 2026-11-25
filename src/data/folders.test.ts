import { describe, expect, it, vi } from 'vitest'
import { Composer, composeBody, splitDraft } from './compose'
import { GraphClient } from './graphClient'
import { MailProvider, folderNames, mailDefaultHeaders } from './mailProvider'

type Call = { url: string; method: string; body?: unknown; headers: Headers }

/** A mailbox that answers each request from a table and remembers what it was asked. */
function mailbox(answers: (call: Call) => unknown) {
  const calls: Call[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: decodeURIComponent(String(input).replace('https://graph.microsoft.com/v1.0', '').replaceAll('+', ' ')), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body, headers: new Headers(init?.headers) }
    calls.push(call)
    return new Response(JSON.stringify(answers(call) ?? {}), { status: 200 })
  })
  return { calls, graph: new GraphClient(async () => 'token', fetcher as unknown as typeof fetch, undefined, mailDefaultHeaders) }
}

const sent = { id: 's1', subject: 'Sunday', from: { emailAddress: { name: 'Me', address: 'me@example.com' } }, toRecipients: [{ emailAddress: { name: ' Mom ', address: 'Mom@Example.com' } }, { emailAddress: { address: 'dad@example.com' } }], receivedDateTime: '2026-11-02T15:00:00Z', isRead: true, webLink: 'w' }

describe('folders', () => {
  it('has no junk folder and no second inbox or receipts', () => {
    expect([...folderNames]).toEqual(['sent', 'drafts', 'archive', 'snoozed', 'deleted'])
  })

  it('reads each folder newest first, with who the mail was written to', async () => {
    const { calls, graph } = mailbox((call) => call.url.startsWith('/me/mailFolders?') ? { value: [{ id: 'snz', displayName: 'snoozed' }] } : { value: [sent] })
    const mail = new MailProvider(graph)
    const page = await mail.folder('sent')
    expect(page.messages[0].to).toEqual([{ name: 'Mom', address: 'mom@example.com' }, { name: 'dad@example.com', address: 'dad@example.com' }])
    await mail.folder('drafts')
    await mail.folder('archive')
    await mail.folder('deleted', 50, '2026-11-01T00:00:00Z')
    await mail.folder('snoozed')
    const asked = calls.map((call) => call.url).filter((url) => url.includes('/messages?'))
    expect(asked.map((url) => url.match(/mailFolders\/(\w+)\/messages/)?.[1])).toEqual(['sentitems', 'drafts', 'archive', 'deleteditems', 'snz'])
    expect(asked.every((url) => url.includes('$orderby=receivedDateTime desc'))).toBe(true)
    expect(asked[3]).toContain('$filter=receivedDateTime le 2026-11-01T00:00:00Z')
  })

  it('puts a deleted message back where it was', async () => {
    const { calls, graph } = mailbox(() => ({}))
    await new MailProvider(graph).moveTo('a', 'sent')
    expect(calls[0]).toMatchObject({ url: '/me/messages/a/move', method: 'POST', body: { destinationId: 'sentitems' } })
  })
})

describe('a draft picked up again', () => {
  it('gives back what was typed and the mail under it, so saving again writes the same body', () => {
    const quoted = { contentType: 'html', content: '<html><head><style>p{}</style></head><body dir="ltr"><hr>From: Mom<br>Sunday?</body></html>' }
    const typed = 'Yes <at> 5 & 6\nSee you'
    const saved = composeBody(typed, quoted).content
    expect(splitDraft(saved, 'ignored')).toEqual({ text: typed, quoted })
    // Outlook rewrites what it stores: line ends and closed tags around the same block.
    expect(splitDraft(saved.replace('<div>', '\r\n<div>').replace(/<br>/g, '<br />\r\n'), 'ignored').text).toBe(typed)
  })

  it('takes a draft with nothing under it, or one written in Outlook, as all typed text', () => {
    const empty = { contentType: 'text', content: '' }
    expect(splitDraft('<html><head></head><body><div>Hi<br>there</div><br></body></html>', 'Hi\r\nthere\r\n')).toEqual({ text: 'Hi\nthere', quoted: empty })
    expect(splitDraft('<html><body><p class="x">Hi <b>there</b></p><hr>From: Mom</body></html>', 'Hi there\r\n________________\r\nFrom: Mom')).toEqual({ text: 'Hi there\n________________\nFrom: Mom', quoted: empty })
  })

  it('reads the kept draft, its people and its files, and makes no new one', async () => {
    const { calls, graph } = mailbox((call) => call.url.includes('/attachments')
      ? { value: [{ id: 'f1', name: 'a.pdf', size: 10 }, { id: 'f2', name: 'logo.png', size: 5, isInline: true }] }
      : { id: 'd1', subject: 'RE: Sunday', toRecipients: [{ emailAddress: { name: 'Mom', address: 'Mom@example.com' } }], body: call.headers.get('Prefer')?.includes('html') ? { contentType: 'html', content: '<body><div>Yes</div><br><hr>From: Mom</body>' } : { contentType: 'text', content: 'Yes\r\n___\r\nFrom: Mom' } })
    const draft = await new Composer(graph).start('draft', 'd1')
    expect(draft).toEqual({ id: 'd1', to: [{ name: 'Mom', address: 'mom@example.com' }], cc: [], subject: 'RE: Sunday', attachments: [{ id: 'f1', name: 'a.pdf', size: 10 }], text: 'Yes', quoted: { contentType: 'html', content: '<body><hr>From: Mom</body>' } })
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })
})
