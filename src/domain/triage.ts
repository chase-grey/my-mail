import { categories, type Category, type Message, type Triage } from './types'

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

/** Messages a language model should read: what needs me, plus anything the cheaper classifier was unsure about. */
export function needsReading(message: Message, triage: Triage | undefined): boolean {
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
  /** Sender rules the sorter made this run from what it auto-archived. */
  newRules?: number
}

export function summarize(items: Triaged[], counts: Pick<RunSummary, 'byRules' | 'autoArchived' | 'returned' | 'withoutModel'>): RunSummary {
  return {
    inbox: items.length,
    needReply: items.filter((item) => item.triage?.needsReply).length,
    ...counts,
  }
}

export function summaryLine(summary: RunSummary): string {
  const parts = [`${summary.inbox} in inbox`]
  if (summary.needReply) parts.push(`${summary.needReply} need a reply`)
  if (summary.byRules) parts.push(`${summary.byRules} by rules`)
  if (summary.autoArchived) parts.push(`${summary.autoArchived} auto-archived`)
  if (summary.newRules) parts.push(`${summary.newRules} new ${summary.newRules === 1 ? 'rule' : 'rules'}`)
  if (summary.returned) parts.push(`${summary.returned} back from snooze`)
  return parts.join(' · ')
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

/** A verdict Outlook already carries as a category on the message, written by this app on another device. */
export function outlookTriage(message: Message, triagedAt: string): Triage | undefined {
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
