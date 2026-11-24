import { actions, categories, type Action, type Category, type Message, type SharedVerdict, type Triage } from './types'

const order: Record<Category, number> = Object.fromEntries(categories.map((category, index) => [category, index])) as Record<Category, number>

export type Triaged = { message: Message; triage?: Triage }

/** Things that need me first, then things to know, then things to skim; newest first within a group. */
export function rankTriaged(items: Triaged[]): Triaged[] {
  return [...items].sort((a, b) => {
    const rank = (item: Triaged) => item.triage ? order[item.triage.category] : order.fyi
    const byRank = rank(a) - rank(b)
    if (byRank) return byRank
    return b.message.receivedAt.localeCompare(a.message.receivedAt)
  })
}

export const quietCategories: Category[] = ['newsletter', 'promo', 'notification', 'receipt', 'spam']
export const needsMeCategories: Category[] = ['reply', 'action', 'waiting']

/** Below this the verdict is shown to me instead of acted on, whoever made it. */
export const unsureBelow = 0.6

/** Mail that still needs eyes: replies, actions, flagged, important, unread verdicts, and anything the classifier was unsure about. */
export function needsMe(item: Triaged): boolean {
  const { message, triage } = item
  if (message.flagged || message.importance === 'high') return true
  if (!triage) return true
  if (needsMeCategories.includes(triage.category) || triage.needsReply) return true
  return triage.confidence < unsureBelow
}

/** Split the inbox into what needs me and what is probably fine, each ranked. */
export function groupInbox(items: Triaged[]): { needsMe: Triaged[]; probablyFine: Triaged[] } {
  const ranked = rankTriaged(items)
  return { needsMe: ranked.filter(needsMe), probablyFine: ranked.filter((item) => !needsMe(item)) }
}

/** Only sure verdicts clear mail on their own. Replies, actions, and anything flagged stay. */
export function autoArchivable(message: Message, triage: Triage, minimumConfidence = 0.85): boolean {
  if (message.flagged || message.importance === 'high') return false
  if (triage.needsReply || triage.suggested !== 'archive') return false
  if (!quietCategories.includes(triage.category)) return false
  return triage.confidence >= minimumConfidence
}

/** Mail older than this is never sent to Jev or Claude. Whatever it once asked for, the moment has passed. */
export const oldAfterDays = 30

export function isOld(message: Message, now: string, days = oldAfterDays): boolean {
  return message.receivedAt < new Date(new Date(now).getTime() - days * 86_400_000).toISOString()
}

/** A verdict from age alone: old mail sits under probably fine without a model. It is never auto-archived and never written to Outlook. */
export function ageTriage(message: Message, now: string): Triage | undefined {
  if (!isOld(message, now)) return undefined
  return { messageId: message.id, category: 'fyi', summary: '', needsReply: false, suggested: 'archive', confidence: 1, source: 'age', triagedAt: now }
}

/** Messages a language model should read: what needs me, plus anything the cheaper classifier was unsure about. Old mail is never read. */
export function needsReading(message: Message, triage: Triage | undefined, now = new Date().toISOString()): boolean {
  if (isOld(message, now)) return false
  if (!triage) return true
  if (triage.summary) return false
  if (triage.source === 'history') return false
  return needsMe({ message, triage })
}

export type RunSummary = {
  inbox: number
  needReply: number
  byRules: number
  autoArchived: number
  returned: number
  /** How many verdicts came without a language model this run: Outlook categories, sender history, Jev. */
  withoutModel: number
  /** How many of the auto-archived went to the receipts folder instead of the archive. */
  filed?: number
  /** Sender rules the sorter made this run from what it auto-archived. */
  newRules?: number
  /** Mail brought into the inbox from Outlook's junk folder this run. */
  fromJunk?: number
}

export function summarize(items: Triaged[], counts: Pick<RunSummary, 'byRules' | 'autoArchived' | 'returned' | 'withoutModel'>): RunSummary {
  return {
    inbox: items.length,
    needReply: items.filter((item) => item.triage?.needsReply).length,
    ...counts,
  }
}

export const categoryLabel: Record<Category, string> = {
  reply: 'needs a reply',
  action: 'needs something',
  waiting: 'waiting on them',
  fyi: 'fyi',
  receipt: 'receipt',
  notification: 'notification',
  newsletter: 'newsletter',
  promo: 'promo',
  spam: 'spam',
}

const isCategory = (value: string): value is Category => (categories as readonly string[]).includes(value)

const isAction = (value: unknown): value is Action => typeof value === 'string' && (actions as readonly string[]).includes(value)

/** What goes onto the message for the other devices. */
export function sharedOf(triage: Triage): SharedVerdict {
  return { category: triage.category, summary: triage.summary, needsReply: triage.needsReply, suggested: triage.suggested, task: triage.task, confidence: triage.confidence }
}

/** The text written onto the message. Short keys: it rides along with every read of the mail. */
export function writeShared(verdict: SharedVerdict): string {
  return JSON.stringify({ c: verdict.category, s: verdict.summary || undefined, r: verdict.needsReply || undefined, a: verdict.suggested, t: verdict.task || undefined, p: Math.round(verdict.confidence * 100) / 100 })
}

/** A verdict read back off a message. Anything that is not one of ours is ignored. */
export function readShared(text: unknown): SharedVerdict | undefined {
  if (typeof text !== 'string' || !text) return undefined
  try {
    const raw = JSON.parse(text) as { c?: unknown; s?: unknown; r?: unknown; a?: unknown; t?: unknown; p?: unknown }
    if (typeof raw.c !== 'string' || !isCategory(raw.c)) return undefined
    const needsReply = raw.r === true || raw.c === 'reply'
    return {
      category: raw.c,
      summary: typeof raw.s === 'string' ? raw.s : '',
      needsReply,
      suggested: isAction(raw.a) ? raw.a : needsReply ? 'reply' : 'keep',
      task: typeof raw.t === 'string' && raw.t ? raw.t : undefined,
      confidence: typeof raw.p === 'number' && Number.isFinite(raw.p) ? Math.min(1, Math.max(0, raw.p)) : 1,
    }
  } catch {
    return undefined
  }
}

/** Whether a verdict still has to be written onto its message: it says something the message does not already carry. */
export function worthSharing(message: Message, triage: Triage): boolean {
  if (triage.source === 'age') return false
  if (message.verdict) return writeShared(message.verdict) !== writeShared(sharedOf(triage))
  // Read off the category alone, with nothing added since: the message already says all of it.
  return !(triage.source === 'outlook' && !triage.summary)
}

/** A verdict the message already carries, written by this app on another device: the whole of it, or at least its category. */
export function outlookTriage(message: Message, triagedAt: string): Triage | undefined {
  if (message.verdict) return { messageId: message.id, ...message.verdict, source: 'outlook', triagedAt }
  const category = message.categories.find(isCategory)
  if (!category) return undefined
  const needsReply = category === 'reply'
  return { messageId: message.id, category, summary: '', needsReply, suggested: needsReply ? 'reply' : category === 'action' ? 'task' : category === 'waiting' ? 'keep' : category === 'spam' ? 'delete' : 'archive', confidence: 1, source: 'outlook', triagedAt }
}

/** Keep triage only for messages still in the inbox so the cache cannot grow forever. */
export function pruneTriage(cache: Record<string, Triage>, messages: Message[]): Record<string, Triage> {
  const live = new Set(messages.map((message) => message.id))
  return Object.fromEntries(Object.entries(cache).filter(([id]) => live.has(id)))
}
