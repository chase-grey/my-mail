import type { Recipient } from '../domain/recipients'
import type { GraphClient } from './graphClient'

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward'
export type DraftAttachment = { id: string; name: string; size: number }
export type DraftBody = { contentType: string; content: string }
/** A message being written. It is an Outlook draft from the moment it has an id. */
export type Draft = { id: string; to: Recipient[]; cc: Recipient[]; subject: string; quoted: DraftBody; attachments: DraftAttachment[] }
export type ComposeFields = { to: Recipient[]; cc: Recipient[]; subject: string; text: string }
export type Upload = Blob & { name: string }

type GraphRecipient = { emailAddress?: { name?: string; address?: string } }
type GraphDraft = { id: string; subject?: string; toRecipients?: GraphRecipient[]; ccRecipients?: GraphRecipient[]; body?: DraftBody }
type GraphAttachment = { id: string; name?: string; size?: number; isInline?: boolean }

/** Graph takes a file in one request up to here; anything larger goes up in pieces. */
export const inlineLimit = 3 * 1024 * 1024
/** Pieces have to be a multiple of 320 KiB. */
export const chunkSize = 320 * 1024 * 10
/** What a personal mailbox accepts on one message. */
export const attachmentLimit = 25 * 1024 * 1024

const asHtml = { Prefer: 'IdType="ImmutableId", outlook.body-content-type="html"' }
const starts: Record<Exclude<ComposeMode, 'new'>, string> = { reply: 'createReply', replyAll: 'createReplyAll', forward: 'createForward' }

const fromGraph = (list?: GraphRecipient[]): Recipient[] => (list ?? []).flatMap((item) => {
  const address = item.emailAddress?.address?.toLowerCase()
  return address ? [{ name: item.emailAddress?.name?.trim() || undefined, address }] : []
})
const toGraph = (list: Recipient[]) => list.map((item) => ({ emailAddress: item.name ? { name: item.name, address: item.address } : { address: item.address } }))
const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** What was typed, above the mail it answers. A new message has nothing below it and goes as plain text. */
export function composeBody(text: string, quoted?: DraftBody): DraftBody {
  const typed = text.replace(/\r/g, '').trimEnd()
  if (!quoted?.content.trim()) return { contentType: 'text', content: typed }
  if (quoted.contentType.toLowerCase() !== 'html') return { contentType: 'text', content: `${typed}\n\n${quoted.content}` }
  const html = `<div>${escapeHtml(typed).replace(/\n/g, '<br>')}</div><br>`
  const body = quoted.content.match(/<body[^>]*>/i)
  if (!body || body.index === undefined) return { contentType: 'html', content: html + quoted.content }
  const at = body.index + body[0].length
  return { contentType: 'html', content: quoted.content.slice(0, at) + html + quoted.content.slice(at) }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

/** Writes mail through Outlook drafts: make one, fill it, attach to it, send it. */
export class Composer {
  constructor(
    private readonly graph: GraphClient,
    /** Pieces of a large file go to a signed address that refuses the sign-in header, so they skip the client. */
    private readonly put: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private path(draftId: string, rest = ''): string {
    return `/me/messages/${encodeURIComponent(draftId)}${rest}`
  }

  /** A blank draft, or one Outlook has addressed and quoted for a reply or a forward. */
  async start(mode: ComposeMode, messageId?: string): Promise<Draft> {
    if (mode !== 'new' && !messageId) throw new Error('nothing to answer')
    const made = await this.graph.request<GraphDraft>(mode === 'new' ? '/me/messages' : this.path(messageId!, `/${starts[mode]}`), { method: 'POST', body: '{}', headers: asHtml })
    return {
      id: made.id,
      to: fromGraph(made.toRecipients),
      cc: fromGraph(made.ccRecipients),
      subject: made.subject ?? '',
      quoted: made.body ?? { contentType: 'text', content: '' },
      // A forward carries the original's files with it.
      attachments: mode === 'forward' ? await this.attachments(made.id) : [],
    }
  }

  /** The files on a draft. Pictures placed inside the body are not listed. */
  async attachments(draftId: string): Promise<DraftAttachment[]> {
    const page = await this.graph.request<{ value: GraphAttachment[] }>(this.path(draftId, '/attachments?$select=id,name,size,isInline'))
    return page.value.filter((item) => !item.isInline).map((item) => ({ id: item.id, name: item.name ?? 'attachment', size: item.size ?? 0 }))
  }

  /** Puts a file on the draft and returns every file now on it. */
  async attach(draftId: string, file: Upload, onProgress?: (sent: number) => void): Promise<DraftAttachment[]> {
    if (file.size <= inlineLimit) {
      const contentBytes = toBase64(new Uint8Array(await file.arrayBuffer()))
      await this.graph.request(this.path(draftId, '/attachments'), { method: 'POST', body: JSON.stringify({ '@odata.type': '#microsoft.graph.fileAttachment', name: file.name, contentType: file.type || 'application/octet-stream', contentBytes }) })
    } else {
      const session = await this.graph.request<{ uploadUrl: string }>(this.path(draftId, '/attachments/createUploadSession'), { method: 'POST', body: JSON.stringify({ AttachmentItem: { attachmentType: 'file', name: file.name, size: file.size, contentType: file.type || 'application/octet-stream' } }) })
      for (let at = 0; at < file.size; at += chunkSize) {
        const end = Math.min(at + chunkSize, file.size)
        const response = await this.put(session.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${at}-${end - 1}/${file.size}` }, body: file.slice(at, end) })
        if (!response.ok) throw new Error(`${file.name} did not upload (${response.status})`)
        onProgress?.(end)
      }
    }
    return this.attachments(draftId)
  }

  async detach(draftId: string, attachmentId: string): Promise<void> {
    await this.graph.requestText(this.path(draftId, `/attachments/${encodeURIComponent(attachmentId)}`), { method: 'DELETE' })
  }

  /** Writes the fields onto the draft. The mail being answered stays under what was typed. */
  async save(draft: Draft, fields: ComposeFields): Promise<void> {
    await this.graph.request(this.path(draft.id), { method: 'PATCH', body: JSON.stringify({ subject: fields.subject, toRecipients: toGraph(fields.to), ccRecipients: toGraph(fields.cc), body: composeBody(fields.text, draft.quoted) }) })
  }

  async send(draftId: string): Promise<void> {
    await this.graph.requestText(this.path(draftId, '/send'), { method: 'POST' })
  }

  async discard(draftId: string): Promise<void> {
    await this.graph.requestText(this.path(draftId), { method: 'DELETE' })
  }
}

export type ComposeActions = Pick<Composer, 'start' | 'attach' | 'detach' | 'save' | 'send' | 'discard'>
