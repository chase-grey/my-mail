import { chunk, type ScanMessage } from '../domain/cleanup'
import { describeOutlookRule, type OutlookRuleBody } from '../domain/outlookRules'
import { trimForModel } from '../domain/text'
import type { Header } from '../domain/unsubscribe'
import { categories, type Message, type OutlookRule } from '../domain/types'
import { GraphError, type GraphClient } from './graphClient'

type GraphRecipient = { emailAddress: { name?: string; address?: string } }
type GraphMessage = {
  id: string
  conversationId?: string
  subject?: string
  from?: GraphRecipient
  receivedDateTime: string
  bodyPreview?: string
  body?: { contentType: string; content: string }
  isRead: boolean
  flag?: { flagStatus?: 'notFlagged' | 'flagged' | 'complete' }
  importance?: 'low' | 'normal' | 'high'
  hasAttachments?: boolean
  categories?: string[]
  webLink: string
}
type GraphFolder = { id: string; displayName: string }
type GraphRule = { id: string; displayName: string; isEnabled: boolean; sequence: number; conditions?: Record<string, unknown>; actions?: Record<string, unknown> }
type BatchResponse = { responses: { id: string; status: number; body?: unknown }[] }

export const messageSelect = 'id,conversationId,subject,from,receivedDateTime,bodyPreview,body,isRead,flag,importance,hasAttachments,categories,webLink'
export const scanSelect = 'id,subject,from,receivedDateTime,bodyPreview,isRead,flag'
export const bodyLimit = 1500
export const snoozedFolderName = 'snoozed'
export const scanPageSize = 500
export const batchLimit = 20

/** Ask Graph for ids that survive moves, and for plain-text bodies. */
export const mailDefaultHeaders = { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' }

/** What a model gets to read: quoted history, footers, and links stripped, then capped. */
export function tidyBody(text: string, limit = bodyLimit): string {
  return trimForModel(text, limit)
}

const sender = (message: Pick<GraphMessage, 'from'>) => ({
  name: message.from?.emailAddress.name?.trim() || message.from?.emailAddress.address || 'unknown sender',
  address: message.from?.emailAddress.address?.toLowerCase() ?? '',
})

export function fromGraph(message: GraphMessage): Message {
  return {
    id: message.id,
    conversationId: message.conversationId,
    subject: message.subject?.trim() || '(no subject)',
    from: sender(message),
    receivedAt: message.receivedDateTime,
    preview: message.bodyPreview?.trim() ?? '',
    body: tidyBody(message.body?.content ?? message.bodyPreview ?? ''),
    isRead: message.isRead,
    flagged: message.flag?.flagStatus === 'flagged',
    importance: message.importance ?? 'normal',
    hasAttachments: Boolean(message.hasAttachments),
    categories: message.categories ?? [],
    webLink: message.webLink,
  }
}

export function scanFromGraph(message: GraphMessage): ScanMessage {
  return {
    id: message.id,
    from: sender(message),
    subject: message.subject?.trim() || '(no subject)',
    preview: message.bodyPreview?.trim() ?? '',
    receivedAt: message.receivedDateTime,
    isRead: message.isRead,
    flagged: message.flag?.flagStatus === 'flagged',
  }
}

export function ruleFromGraph(rule: GraphRule): OutlookRule {
  return { id: rule.id, displayName: rule.displayName, isEnabled: rule.isEnabled, sequence: rule.sequence, description: describeOutlookRule(rule) }
}

export class MailProvider {
  private snoozedFolderId?: string
  private archiveId?: string
  private masterCategoriesReady = false

  constructor(private readonly graph: GraphClient) {}

  async inbox(top = 50): Promise<Message[]> {
    const query = new URLSearchParams({ '$top': String(top), '$orderby': 'receivedDateTime desc', '$select': messageSelect })
    const page = await this.graph.request<{ value: GraphMessage[] }>(`/me/mailFolders/inbox/messages?${query}`)
    return page.value.map(fromGraph)
  }

  /** Every inbox message's headers only, page by page, for the cleanup view. Stops at the cap. */
  async scanInbox(onPage?: (count: number) => void, cap = 20_000): Promise<ScanMessage[]> {
    const query = new URLSearchParams({ '$top': String(scanPageSize), '$orderby': 'receivedDateTime desc', '$select': scanSelect })
    const all: ScanMessage[] = []
    let next: string | undefined = `/me/mailFolders/inbox/messages?${query}`
    while (next && all.length < cap) {
      const page: { value: GraphMessage[]; '@odata.nextLink'?: string } = await this.graph.request(next)
      all.push(...page.value.map(scanFromGraph))
      onPage?.(all.length)
      next = page['@odata.nextLink']
    }
    return all
  }

  async move(id: string, destinationId: string): Promise<void> {
    await this.graph.request(`/me/messages/${encodeURIComponent(id)}/move`, { method: 'POST', body: JSON.stringify({ destinationId }) })
  }

  archive(id: string): Promise<void> {
    return this.move(id, 'archive')
  }

  delete(id: string): Promise<void> {
    return this.move(id, 'deleteditems')
  }

  /** Many moves in one round trip each twenty. Returns how many Graph accepted. */
  async moveMany(ids: string[], destinationId: string, onProgress?: (done: number) => void): Promise<number> {
    let done = 0
    for (const group of chunk(ids, batchLimit)) {
      const requests = group.map((id, index) => ({ id: String(index), method: 'POST', url: `/me/messages/${encodeURIComponent(id)}/move`, headers: { 'Content-Type': 'application/json' }, body: { destinationId } }))
      const result = await this.graph.request<BatchResponse>('/$batch', { method: 'POST', body: JSON.stringify({ requests }) })
      done += result.responses.filter((response) => response.status < 300 || response.status === 404).length
      onProgress?.(done)
    }
    return done
  }

  archiveMany(ids: string[], onProgress?: (done: number) => void): Promise<number> {
    return this.moveMany(ids, 'archive', onProgress)
  }

  deleteMany(ids: string[], onProgress?: (done: number) => void): Promise<number> {
    return this.moveMany(ids, 'deleteditems', onProgress)
  }

  async markRead(id: string, isRead = true): Promise<void> {
    await this.graph.request(`/me/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ isRead }) })
  }

  async flag(id: string, flagged = true): Promise<void> {
    await this.graph.request(`/me/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' } }) })
  }

  /** Write the verdict onto the message. Other categories on it are kept; an older verdict is replaced. */
  async setVerdict(id: string, existing: string[], category: string): Promise<void> {
    await this.ensureMasterCategories()
    const kept = existing.filter((item) => !(categories as readonly string[]).includes(item))
    await this.graph.request(`/me/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ categories: [...kept, category] }) })
  }

  /** Outlook shows categories it knows about with a color; unknown ones still stick, so a failure here is not fatal. */
  private async ensureMasterCategories(): Promise<void> {
    if (this.masterCategoriesReady) return
    this.masterCategoriesReady = true
    try {
      const existing = await this.graph.request<{ value: { displayName: string }[] }>('/me/outlook/masterCategories?$select=displayName')
      const have = new Set(existing.value.map((item) => item.displayName))
      for (const category of categories) {
        if (have.has(category)) continue
        await this.graph.request('/me/outlook/masterCategories', { method: 'POST', body: JSON.stringify({ displayName: category, color: 'none' }) })
      }
    } catch {
      // Needs MailboxSettings.ReadWrite; without it the categories still apply, just uncolored.
    }
  }

  async headers(id: string): Promise<Header[]> {
    const message = await this.graph.request<{ internetMessageHeaders?: Header[] }>(`/me/messages/${encodeURIComponent(id)}?$select=internetMessageHeaders`)
    return message.internetMessageHeaders ?? []
  }

  /** Sends a plain-text reply to the sender right away. */
  async reply(id: string, comment: string): Promise<void> {
    await this.graph.request(`/me/messages/${encodeURIComponent(id)}/reply`, { method: 'POST', body: JSON.stringify({ comment }) })
  }

  /** Saves a reply in Drafts and returns where to finish it in Outlook. */
  async draftReply(id: string, comment: string): Promise<{ id: string; webLink: string }> {
    const draft = await this.graph.request<{ id: string; webLink: string }>(`/me/messages/${encodeURIComponent(id)}/createReply`, { method: 'POST', body: JSON.stringify({ comment }) })
    return { id: draft.id, webLink: draft.webLink }
  }

  /** A new plain-text message, used for mailto unsubscribe requests. Not saved to Sent. */
  async send(to: string, subject: string, body: string): Promise<void> {
    await this.graph.request('/me/sendMail', { method: 'POST', body: JSON.stringify({ message: { subject, body: { contentType: 'text', content: body }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: false }) })
  }

  async archiveFolderId(): Promise<string> {
    if (this.archiveId) return this.archiveId
    const folder = await this.graph.request<GraphFolder>('/me/mailFolders/archive?$select=id')
    this.archiveId = folder.id
    return folder.id
  }

  async snoozedFolder(): Promise<string> {
    if (this.snoozedFolderId) return this.snoozedFolderId
    const query = new URLSearchParams({ '$filter': `displayName eq '${snoozedFolderName}'`, '$select': 'id,displayName' })
    const found = await this.graph.request<{ value: GraphFolder[] }>(`/me/mailFolders?${query}`)
    const folder = found.value[0] ?? await this.graph.request<GraphFolder>('/me/mailFolders', { method: 'POST', body: JSON.stringify({ displayName: snoozedFolderName, isHidden: false }) })
    this.snoozedFolderId = folder.id
    return folder.id
  }

  async snooze(id: string): Promise<void> {
    await this.move(id, await this.snoozedFolder())
  }

  /** Brings a snoozed message back to the inbox as unread so it reads as new. Gone messages are ignored. */
  async unsnooze(id: string): Promise<boolean> {
    try {
      await this.move(id, 'inbox')
      await this.markRead(id, false)
      return true
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return false
      throw error
    }
  }

  /** Server-side rules on the inbox: ours and the ones made in Outlook. */
  async rules(): Promise<OutlookRule[]> {
    const page = await this.graph.request<{ value: GraphRule[] }>('/me/mailFolders/inbox/messageRules')
    return page.value.map(ruleFromGraph)
  }

  async createRule(body: OutlookRuleBody): Promise<string> {
    const created = await this.graph.request<{ id: string }>('/me/mailFolders/inbox/messageRules', { method: 'POST', body: JSON.stringify(body) })
    return created.id
  }

  async updateRule(id: string, body: Partial<OutlookRuleBody>): Promise<void> {
    await this.graph.request(`/me/mailFolders/inbox/messageRules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) })
  }

  async deleteRule(id: string): Promise<void> {
    try {
      await this.graph.request(`/me/mailFolders/inbox/messageRules/${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch (error) {
      if (!(error instanceof GraphError && error.status === 404)) throw error
    }
  }
}
