import { chunk, type ScanMessage } from '../domain/cleanup'
import { describeOutlookRule, type OutlookRuleBody } from '../domain/outlookRules'
import { readable, trimForModel } from '../domain/text'
import type { MailContent } from '../domain/mailHtml'
import type { Header } from '../domain/unsubscribe'
import { readShared, writeShared } from '../domain/triage'
import { categories, type Message, type OutlookRule, type SharedVerdict } from '../domain/types'
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
  toRecipients?: GraphRecipient[]
  ccRecipients?: GraphRecipient[]
  categories?: string[]
  webLink: string
  singleValueExtendedProperties?: { id: string; value: string }[]
  isDraft?: boolean
  parentFolderId?: string
}
type GraphFolder = { id: string; displayName: string }
type GraphRule = { id: string; displayName: string; isEnabled: boolean; sequence: number; conditions?: Record<string, unknown>; actions?: Record<string, unknown> }
type BatchResponse = { responses: { id: string; status: number; headers?: Record<string, string>; body?: unknown }[] }

export const messageSelect = 'id,conversationId,subject,from,receivedDateTime,bodyPreview,body,isRead,flag,importance,hasAttachments,categories,webLink,toRecipients,ccRecipients'
export const scanSelect = 'id,subject,from,receivedDateTime,bodyPreview,isRead,flag'
/** Where the whole verdict is kept on a message: a named property of ours that Outlook stores and never shows. */
export const verdictProperty = 'String {6f1d3c2a-8b7e-4c59-9a41-2e5d0c7b9f13} Name my-mail.verdict'
export const verdictExpand = `singleValueExtendedProperties($filter=id eq '${verdictProperty}')`
export const bodyLimit = 1500
export const snoozedFolderName = 'snoozed'
export const receiptsFolderName = 'receipts'
export const inboxPageSize = 50
export const threadCap = 100
export const junkSweepCap = 200
export const scanPageSize = 500
export const batchLimit = 20
export const moveAttempts = 6
export const contentKept = 40

const retryable = (status: number) => status === 429 || status === 424 || status >= 500

/** Seconds a throttled batch item asks to wait, when it says. */
function retryAfter(headers?: Record<string, string>): number {
  const value = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'retry-after')?.[1]
  return Number(value) || 0
}

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
    recipients: (message.toRecipients?.length ?? 0) + (message.ccRecipients?.length ?? 0),
    categories: message.categories ?? [],
    verdict: readShared(message.singleValueExtendedProperties?.[0]?.value),
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
  private readonly folderIds = new Map<string, string>()
  private archiveId?: string
  private deletedId?: Promise<string | undefined>
  private masterCategoriesReady = false
  /** Off once Graph refuses the verdict property, so mail keeps loading and only the category is shared. */
  private verdictsOnMessages = true
  private readonly contents = new Map<string, Promise<MailContent>>()

  constructor(
    private readonly graph: GraphClient,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /**
   * The newest `count` inbox messages, or the next `count` received at or before `before`.
   * Older pages are asked for by date, not by position, so mail archived in between does not shift the window.
   * The message at the boundary comes back again; the caller drops what it already has.
   */
  inbox(count = inboxPageSize, before?: string): Promise<{ messages: Message[]; more: boolean }> {
    return this.page('inbox', count, before)
  }

  /** Inbox mail received at or after `since`, newest first. The message at the boundary comes back again; the caller drops what it already has. */
  inboxSince(since: string, count = inboxPageSize): Promise<{ messages: Message[]; more: boolean }> {
    return this.page('inbox', count, undefined, since)
  }

  /**
   * The cheapest look there is for new mail: how many messages sit in junk, and the ids alone of inbox mail
   * received at or after `since`. One round trip, no bodies. The caller reads in full only when an id is new to it.
   */
  async glance(since?: string): Promise<{ junk: number; ids: string[] }> {
    const query = new URLSearchParams({ '$top': String(inboxPageSize), '$orderby': 'receivedDateTime desc', '$select': 'id' })
    if (since) query.set('$filter', `receivedDateTime ge ${since}`)
    // Headers on the batch itself do not reach the requests inside it, and ids only match the ones held with this one.
    const requests = [
      { id: 'junk', method: 'GET', url: '/me/mailFolders/junkemail?$select=totalItemCount', headers: mailDefaultHeaders },
      { id: 'inbox', method: 'GET', url: `/me/mailFolders/inbox/messages?${query}`, headers: mailDefaultHeaders },
    ]
    const result = await this.graph.request<BatchResponse>('/$batch', { method: 'POST', body: JSON.stringify({ requests }) })
    const body = <T>(id: string): T => {
      const response = result.responses.find((item) => item.id === id)
      if (!response || response.status >= 300) throw new GraphError(response?.status ?? 500, `the look for new mail failed (${response?.status ?? 'no answer'})`)
      return response.body as T
    }
    return { junk: body<{ totalItemCount: number }>('junk').totalItemCount, ids: body<{ value: { id: string }[] }>('inbox').value.map((message) => message.id) }
  }

  /** The receipts folder, newest first, paged by date the same way as the inbox. */
  async receipts(count = inboxPageSize, before?: string): Promise<{ messages: Message[]; more: boolean }> {
    return this.page(await this.receiptsFolder(), count, before)
  }

  private async page(folder: string, count: number, before?: string, since?: string): Promise<{ messages: Message[]; more: boolean }> {
    const query = new URLSearchParams({ '$top': String(Math.min(count, inboxPageSize)), '$orderby': 'receivedDateTime desc', '$select': messageSelect })
    if (before) query.set('$filter', `receivedDateTime le ${before}`)
    else if (since) query.set('$filter', `receivedDateTime ge ${since}`)
    const path = `/me/mailFolders/${encodeURIComponent(folder)}/messages`
    if (this.verdictsOnMessages) {
      const withVerdicts = new URLSearchParams(query)
      withVerdicts.set('$expand', verdictExpand)
      try {
        return await this.pages(`${path}?${withVerdicts}`, count)
      } catch (error) {
        // A mailbox that will not hand the property back still gets its mail; the category alone is shared from here on.
        if (!(error instanceof GraphError && (error.status === 400 || error.status === 501))) throw error
        this.verdictsOnMessages = false
        console.warn('my-mail: verdicts are not shared on messages', error)
      }
    }
    return this.pages(`${path}?${query}`, count)
  }

  private async pages(first: string, count: number): Promise<{ messages: Message[]; more: boolean }> {
    const all: Message[] = []
    let next: string | undefined = first
    while (next && all.length < count) {
      const page: { value: GraphMessage[]; '@odata.nextLink'?: string } = await this.graph.request(next)
      all.push(...page.value.map(fromGraph))
      next = page['@odata.nextLink']
    }
    return { messages: all.slice(0, count), more: Boolean(next) || all.length > count }
  }

  /**
   * Moves what Outlook's junk filter took into the inbox and returns what moved. A personal account cannot
   * turn that filter off, and Outlook's rules never see junked mail, so this is the only way it reaches the inbox.
   * More than the cap waits for the next run.
   */
  async rescueJunk(cap = junkSweepCap): Promise<Message[]> {
    const { messages } = await this.page('junkemail', cap)
    if (!messages.length) return []
    const stuck = new Set(await this.moveMany(messages.map((message) => message.id), 'inbox'))
    return messages.filter((message) => !stuck.has(message.id))
  }

  /**
   * Every message of a conversation in any folder, sent ones included, newest first. Drafts and deleted mail are left out.
   * Bodies are whole. Each drops the history it quotes, since that mail is in the list too; the oldest keeps its own,
   * which may be the only copy of what came before.
   */
  async conversation(conversationId: string, cap = threadCap): Promise<Message[]> {
    // Graph refuses a sort beside this filter, so the order is put right here.
    const query = new URLSearchParams({ '$filter': `conversationId eq '${conversationId.replace(/'/g, "''")}'`, '$select': `${messageSelect},isDraft,parentFolderId`, '$top': String(Math.min(cap, inboxPageSize)) })
    const found: GraphMessage[] = []
    let next: string | undefined = `/me/messages?${query}`
    while (next && found.length < cap) {
      const page: { value: GraphMessage[]; '@odata.nextLink'?: string } = await this.graph.request(next)
      found.push(...page.value)
      next = page['@odata.nextLink']
    }
    this.deletedId ??= this.graph.request<GraphFolder>('/me/mailFolders/deleteditems?$select=id').then((folder) => folder.id, () => undefined)
    const deleted = await this.deletedId
    const kept = found.filter((message) => !message.isDraft && (!deleted || message.parentFolderId !== deleted))
      .sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime))
    return kept.map((message, index) => {
      return { ...fromGraph(message), body: readable(message.body?.content ?? message.bodyPreview ?? '', index < kept.length - 1) }
    })
  }

  /** How many messages the inbox holds, loaded or not. */
  async inboxCount(): Promise<number> {
    const folder = await this.graph.request<{ totalItemCount: number }>('/me/mailFolders/inbox?$select=totalItemCount')
    return folder.totalItemCount
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

  /**
   * Many moves in one round trip each twenty. Graph throttles part of a batch when the mailbox is busy,
   * so those are sent again after the wait it asks for. Returns the ids that still did not move.
   */
  async moveMany(ids: string[], destinationId: string, onProgress?: (done: number) => void): Promise<string[]> {
    let done = 0
    const left: string[] = []
    for (const group of chunk(ids, batchLimit)) {
      let pending = group
      for (let attempt = 0; pending.length && attempt < moveAttempts; attempt++) {
        // Headers on the batch itself do not reach the requests inside it, and these ids are only valid with this one.
        const requests = pending.map((id, index) => ({ id: String(index), method: 'POST', url: `/me/messages/${encodeURIComponent(id)}/move`, headers: { 'Content-Type': 'application/json', ...mailDefaultHeaders }, body: { destinationId } }))
        const again: string[] = []
        let wait = 2 ** attempt
        try {
          const result = await this.graph.request<BatchResponse>('/$batch', { method: 'POST', body: JSON.stringify({ requests }) })
          const byId = new Map(result.responses.map((response) => [response.id, response]))
          pending.forEach((id, index) => {
            const response = byId.get(String(index))
            // 404: already gone, which is what was asked for.
            if (response && (response.status < 300 || response.status === 404)) { done++; return }
            if (response && !retryable(response.status)) { left.push(id); return }
            again.push(id)
            wait = Math.max(wait, retryAfter(response?.headers))
          })
        } catch (error) {
          if (!(error instanceof GraphError && retryable(error.status))) throw error
          again.push(...pending)
        }
        onProgress?.(done)
        pending = again
        if (pending.length && attempt < moveAttempts - 1) await this.sleep(Math.min(wait, 30) * 1000)
      }
      left.push(...pending)
    }
    return left
  }

  archiveMany(ids: string[], onProgress?: (done: number) => void): Promise<string[]> {
    return this.moveMany(ids, 'archive', onProgress)
  }

  deleteMany(ids: string[], onProgress?: (done: number) => void): Promise<string[]> {
    return this.moveMany(ids, 'deleteditems', onProgress)
  }

  async markRead(id: string, isRead = true): Promise<void> {
    await this.graph.request(`/me/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ isRead }) })
  }

  async flag(id: string, flagged = true): Promise<void> {
    await this.graph.request(`/me/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' } }) })
  }

  /**
   * Write the verdict onto the message: the category, which Outlook shows and its rules can use, and the whole verdict
   * beside it for this app on other devices. Other categories on the message are kept; an older verdict is replaced.
   */
  async setVerdict(id: string, existing: string[], verdict: SharedVerdict): Promise<void> {
    await this.ensureMasterCategories()
    const kept = existing.filter((item) => !(categories as readonly string[]).includes(item))
    const path = `/me/messages/${encodeURIComponent(id)}`
    const body = { categories: [...kept, verdict.category] }
    if (this.verdictsOnMessages) {
      try {
        await this.graph.request(path, { method: 'PATCH', body: JSON.stringify({ ...body, singleValueExtendedProperties: [{ id: verdictProperty, value: writeShared(verdict) }] }) })
        return
      } catch (error) {
        if (!(error instanceof GraphError && (error.status === 400 || error.status === 501))) throw error
        this.verdictsOnMessages = false
        console.warn('my-mail: verdicts are not shared on messages', error)
      }
    }
    if (existing.includes(verdict.category)) return
    await this.graph.request(path, { method: 'PATCH', body: JSON.stringify(body) })
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

  /**
   * The message as it was written, for reading. Lists carry text cut down for a model; this asks for the markup itself.
   * The last few are remembered so going back to one does not ask again.
   */
  content(id: string): Promise<MailContent> {
    const known = this.contents.get(id)
    if (known) return known
    const asked = this.graph.request<{ body?: { contentType?: string; content?: string } }>(`/me/messages/${encodeURIComponent(id)}?$select=body`, { headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="html"' } })
      .then(({ body }): MailContent => body?.contentType?.toLowerCase() === 'html' ? { html: body.content ?? '', text: '' } : { text: (body?.content ?? '').replace(/\r/g, '').trim() })
    asked.catch(() => this.contents.delete(id))
    this.contents.set(id, asked)
    for (const oldest of this.contents.keys()) {
      if (this.contents.size <= contentKept) break
      this.contents.delete(oldest)
    }
    return asked
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

  /** A top-level folder of ours by name, made the first time it is needed. */
  private async folderNamed(name: string): Promise<string> {
    const known = this.folderIds.get(name)
    if (known) return known
    const query = new URLSearchParams({ '$filter': `displayName eq '${name}'`, '$select': 'id,displayName' })
    const find = async () => (await this.graph.request<{ value: GraphFolder[] }>(`/me/mailFolders?${query}`)).value[0]
    let folder = await find()
    if (!folder) {
      try {
        folder = await this.graph.request<GraphFolder>('/me/mailFolders', { method: 'POST', body: JSON.stringify({ displayName: name, isHidden: false }) })
      } catch (error) {
        // 409: the folder was made between the look and the create, or one exists under another casing.
        if (!(error instanceof GraphError && error.status === 409)) throw error
        const all = await this.graph.request<{ value: GraphFolder[] }>('/me/mailFolders?$top=100&$select=id,displayName')
        const match = all.value.find((item) => item.displayName.toLowerCase() === name)
        if (!match) throw error
        folder = match
      }
    }
    this.folderIds.set(name, folder.id)
    return folder.id
  }

  snoozedFolder(): Promise<string> {
    return this.folderNamed(snoozedFolderName)
  }

  receiptsFolder(): Promise<string> {
    return this.folderNamed(receiptsFolderName)
  }

  async fileReceipt(id: string): Promise<void> {
    await this.move(id, await this.receiptsFolder())
  }

  /** Returns the ids that did not move. */
  async fileReceipts(ids: string[], onProgress?: (done: number) => void): Promise<string[]> {
    return ids.length ? this.moveMany(ids, await this.receiptsFolder(), onProgress) : []
  }

  /** Ids of archived mail that carries the receipt category: receipts sorted before the folder existed. */
  async archivedReceipts(cap = 5000): Promise<string[]> {
    const query = new URLSearchParams({ '$filter': "categories/any(c:c eq 'receipt')", '$select': 'id', '$top': String(scanPageSize) })
    const ids: string[] = []
    let next: string | undefined = `/me/mailFolders/archive/messages?${query}`
    while (next && ids.length < cap) {
      const page: { value: { id: string }[]; '@odata.nextLink'?: string } = await this.graph.request(next)
      ids.push(...page.value.map((message) => message.id))
      next = page['@odata.nextLink']
    }
    return ids
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
