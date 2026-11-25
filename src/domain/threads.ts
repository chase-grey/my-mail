import type { SearchHit } from './search'
import { needsMe, rankTriaged, type Triaged } from './triage'
import type { Message } from './types'

/** What ties messages into one conversation. Mail with no conversation is a thread of one. */
export const threadKey = (message: Message) => message.conversationId || message.id

/**
 * One inbox row: a conversation's newest message, with every inbox message of that conversation behind it.
 * Whatever is done to the row is done to all of them.
 */
export type InboxThread = Triaged & {
  key: string
  /** Every inbox message in the conversation, newest first. The first one is the row's own message. */
  all: Message[]
  /** True when any message in it still needs eyes, not only the newest. */
  needsMe: boolean
}

/**
 * The inbox as conversations. Each sits where its most pressing message would have sat,
 * so a reply that is owed is not buried under a newer note in the same thread.
 */
export function inboxThreads(items: Triaged[], now = new Date().toISOString()): InboxThread[] {
  const byKey = new Map<string, Triaged[]>()
  for (const item of rankTriaged(items)) {
    const key = threadKey(item.message)
    const members = byKey.get(key)
    if (members) members.push(item)
    else byKey.set(key, [item])
  }
  return [...byKey].map(([key, members]) => {
    const newestFirst = [...members].sort((a, b) => b.message.receivedAt.localeCompare(a.message.receivedAt))
    return { ...newestFirst[0], key, all: newestFirst.map((item) => item.message), needsMe: members.some((item) => needsMe(item, now)) }
  })
}

/** Found mail as conversations, newest first, each led by its newest message. */
export type HitThread = SearchHit & { key: string }

export function hitThreads(hits: SearchHit[], except?: string): HitThread[] {
  const byKey = new Map<string, HitThread>()
  for (const hit of hits) {
    const key = threadKey(hit.message)
    if (key === except) continue
    const known = byKey.get(key)
    if (!known || hit.message.receivedAt > known.message.receivedAt) byKey.set(key, { ...hit, key })
  }
  return [...byKey.values()].sort((a, b) => b.message.receivedAt.localeCompare(a.message.receivedAt))
}

/** What a sweep that keeps going does next: archive what is on the list, load older mail, or end. */
export type SweepStep = { do: 'archive'; batch: InboxThread[] } | { do: 'load' } | { do: 'end' }

/**
 * A sweep that keeps going takes every conversation on the list it was not told to leave, then asks for older mail and takes that too,
 * until the mailbox has no more. Mail newer than what was on screen when it began arrived after the press and is never taken.
 */
export function sweepStep(order: InboxThread[], spare: ReadonlySet<string>, upTo: string, more: boolean): SweepStep {
  const batch = order.filter((item) => !spare.has(item.key) && item.message.receivedAt <= upTo)
  if (batch.length) return { do: 'archive', batch }
  return more ? { do: 'load' } : { do: 'end' }
}
