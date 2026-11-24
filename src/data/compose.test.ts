import { describe, expect, it, vi } from 'vitest'
import { Composer, chunkSize, composeBody, inlineLimit, toBase64 } from './compose'
import { GraphClient } from './graphClient'

type Call = { url: string; method: string; body?: unknown; headers: Headers }

/** A mailbox that answers each request from a table and remembers what it was asked. */
function mailbox(answers: (call: Call) => unknown) {
  const calls: Call[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input).replace('https://graph.microsoft.com/v1.0', ''), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body, headers: new Headers(init?.headers) }
    calls.push(call)
    const answer = answers(call)
    return new Response(answer === undefined ? '' : JSON.stringify(answer), { status: answer === undefined ? 202 : 200 })
  })
  return { calls, graph: new GraphClient(async () => 'token', fetcher as unknown as typeof fetch) }
}

const file = (name: string, size: number) => Object.assign(new Blob([new Uint8Array(size)], { type: 'application/pdf' }), { name })

describe('composeBody', () => {
  it('sends a new message as the plain text that was typed', () => {
    expect(composeBody('Hi\r\nthere\n\n')).toEqual({ contentType: 'text', content: 'Hi\nthere' })
  })

  it('puts what was typed above the quoted mail, inside its body, with line breaks kept and markup made safe', () => {
    const body = composeBody('Yes <at> 5\nSee you', { contentType: 'html', content: '<html><body dir="ltr"><hr>From: Mom</body></html>' })
    expect(body).toEqual({ contentType: 'html', content: '<html><body dir="ltr"><div>Yes &lt;at&gt; 5<br>See you</div><br><hr>From: Mom</body></html>' })
  })

  it('still leads with what was typed when the quoted mail has no body tag or is plain text', () => {
    expect(composeBody('ok', { contentType: 'html', content: '<p>old</p>' }).content).toBe('<div>ok</div><br><p>old</p>')
    expect(composeBody('ok', { contentType: 'text', content: 'old' })).toEqual({ contentType: 'text', content: 'ok\n\nold' })
  })
})

describe('Composer', () => {
  it('starts a reply to all as a draft Outlook has addressed and quoted', async () => {
    const { calls, graph } = mailbox(() => ({ id: 'd1', subject: 'RE: Dinner', toRecipients: [{ emailAddress: { name: 'Mom', address: 'Mom@Example.com' } }], ccRecipients: [{ emailAddress: { address: 'dad@example.com' } }], body: { contentType: 'html', content: '<body>old</body>' } }))
    const draft = await new Composer(graph).start('replyAll', 'm 1')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: '/me/messages/m%201/createReplyAll', method: 'POST' })
    expect(calls[0].headers.get('Prefer')).toContain('outlook.body-content-type="html"')
    expect(draft).toEqual({ id: 'd1', to: [{ name: 'Mom', address: 'mom@example.com' }], cc: [{ name: undefined, address: 'dad@example.com' }], subject: 'RE: Dinner', quoted: { contentType: 'html', content: '<body>old</body>' }, attachments: [] })
  })

  it('lists the files a forward carries, leaving out pictures inside the body', async () => {
    const { calls, graph } = mailbox((call) => call.url.includes('/attachments') ? { value: [{ id: 'a1', name: 'tax.pdf', size: 2048 }, { id: 'a2', name: 'logo.png', size: 10, isInline: true }] } : { id: 'd1', subject: 'FW: Tax' })
    const draft = await new Composer(graph).start('forward', 'm1')
    expect(calls.map((call) => call.url)).toEqual(['/me/messages/m1/createForward', '/me/messages/d1/attachments?$select=id,name,size,isInline'])
    expect(draft.attachments).toEqual([{ id: 'a1', name: 'tax.pdf', size: 2048 }])
    expect(draft.to).toEqual([])
  })

  it('refuses to start a reply with nothing to answer', async () => {
    await expect(new Composer(mailbox(() => ({})).graph).start('reply')).rejects.toThrow('nothing to answer')
  })

  it('attaches a small file in one request', async () => {
    const { calls, graph } = mailbox((call) => call.method === 'GET' ? { value: [{ id: 'a1', name: 'note.pdf', size: 3 }] } : { id: 'a1' })
    const put = vi.fn()
    const list = await new Composer(graph, put as unknown as typeof fetch).attach('d1', Object.assign(new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }), { name: 'note.pdf' }))
    expect(calls[0]).toMatchObject({ url: '/me/messages/d1/attachments', method: 'POST', body: { '@odata.type': '#microsoft.graph.fileAttachment', name: 'note.pdf', contentType: 'application/pdf', contentBytes: 'AQID' } })
    expect(put).not.toHaveBeenCalled()
    expect(list).toEqual([{ id: 'a1', name: 'note.pdf', size: 3 }])
  })

  it('sends a large file in pieces to the upload address, without the sign-in header', async () => {
    const { calls, graph } = mailbox((call) => call.method === 'GET' ? { value: [] } : { uploadUrl: 'https://upload.example.com/session' })
    const pieces: { range: string; size: number; auth: string | null }[] = []
    const put = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      pieces.push({ range: headers.get('Content-Range')!, size: (init!.body as Blob).size, auth: headers.get('Authorization') })
      return new Response('{}', { status: 200 })
    })
    const size = inlineLimit + chunkSize + 5
    const progress: number[] = []
    await new Composer(graph, put as unknown as typeof fetch).attach('d1', file('big.pdf', size), (sent) => progress.push(sent))
    expect(calls[0]).toMatchObject({ url: '/me/messages/d1/attachments/createUploadSession', body: { AttachmentItem: { attachmentType: 'file', name: 'big.pdf', size } } })
    expect(pieces.map((piece) => piece.range)).toEqual([`bytes 0-${chunkSize - 1}/${size}`, `bytes ${chunkSize}-${size - 1}/${size}`])
    expect(pieces.map((piece) => piece.size)).toEqual([chunkSize, size - chunkSize])
    expect(pieces.every((piece) => piece.auth === null)).toBe(true)
    expect(progress).toEqual([chunkSize, size])
  })

  it('says which file did not upload', async () => {
    const { graph } = mailbox(() => ({ uploadUrl: 'https://upload.example.com/session' }))
    const put = vi.fn(async () => new Response('', { status: 507 }))
    await expect(new Composer(graph, put as unknown as typeof fetch).attach('d1', file('big.pdf', inlineLimit + 1))).rejects.toThrow('big.pdf did not upload (507)')
  })

  it('writes the fields onto the draft, then sends it; an empty answer is not an error', async () => {
    const { calls, graph } = mailbox((call) => call.method === 'PATCH' ? { id: 'd1' } : undefined)
    const composer = new Composer(graph)
    const draft = { id: 'd1', to: [], cc: [], subject: '', quoted: { contentType: 'text', content: '' }, attachments: [] }
    await composer.save(draft, { to: [{ name: 'Mom', address: 'mom@example.com' }], cc: [{ address: 'dad@example.com' }], subject: 'Dinner', text: 'Five works.' })
    await composer.send('d1')
    await composer.detach('d1', 'a 1')
    await composer.discard('d1')
    expect(calls[0]).toMatchObject({ url: '/me/messages/d1', method: 'PATCH', body: { subject: 'Dinner', toRecipients: [{ emailAddress: { name: 'Mom', address: 'mom@example.com' } }], ccRecipients: [{ emailAddress: { address: 'dad@example.com' } }], body: { contentType: 'text', content: 'Five works.' } } })
    expect(calls.slice(1).map((call) => `${call.method} ${call.url}`)).toEqual(['POST /me/messages/d1/send', 'DELETE /me/messages/d1/attachments/a%201', 'DELETE /me/messages/d1'])
  })
})

it('encodes bytes past one chunk of the encoder', () => {
  const bytes = new Uint8Array(0x8000 + 2).fill(255)
  expect(atob(toBase64(bytes)).length).toBe(bytes.length)
})
