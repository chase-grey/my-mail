import type { Category } from './types'

/** The little the cleanup scan reads per message: no bodies, so thousands fit in a few pages. */
export type ScanMessage = {
  id: string
  from: { name: string; address: string }
  subject: string
  preview: string
  receivedAt: string
  isRead: boolean
  flagged: boolean
}

export type SenderGroup = {
  address: string
  name: string
  count: number
  unread: number
  flagged: number
  latest: string
  oldest: string
  ids: string[]
  /** The newest message, as a sample for a classifier and for the unsubscribe headers. */
  sample: ScanMessage
  /** A classifier's read of the sample, when one has run. */
  kind?: Category
  kindConfidence?: number
  /** Already put away this visit. The row stays where it was so the list does not move under the pointer. */
  cleared?: 'archive' | 'delete'
  /** A rule was made along with it, so the next one from this sender never lands. */
  ruled?: boolean
}

export function groupBySender(messages: ScanMessage[]): SenderGroup[] {
  const groups = new Map<string, SenderGroup>()
  for (const message of messages) {
    const address = message.from.address.toLowerCase()
    const group = groups.get(address)
    if (!group) {
      groups.set(address, { address, name: message.from.name, count: 1, unread: message.isRead ? 0 : 1, flagged: message.flagged ? 1 : 0, latest: message.receivedAt, oldest: message.receivedAt, ids: [message.id], sample: message })
      continue
    }
    group.count++
    if (!message.isRead) group.unread++
    if (message.flagged) group.flagged++
    group.ids.push(message.id)
    if (message.receivedAt > group.latest) { group.latest = message.receivedAt; group.sample = message }
    if (message.receivedAt < group.oldest) group.oldest = message.receivedAt
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.latest.localeCompare(a.latest))
}

/** What Jev said about a sender's mail, kept on this device so another scan does not ask again. */
export type SenderKinds = Record<string, { kind: Category; confidence: number }>

/** Senders a scan still has to ask Jev about: two or more messages, the biggest first, and no answer remembered. */
export function sendersToAsk(groups: SenderGroup[], known: SenderKinds, limit = 80): SenderGroup[] {
  return groups.filter((group) => group.count >= 2).slice(0, limit).filter((group) => !known[group.address])
}

/** The remembered answers for senders still in the inbox. The rest are dropped, so the list empties as the inbox does. */
export function keepSenderKinds(groups: SenderGroup[], known: SenderKinds): SenderKinds {
  return Object.fromEntries(groups.filter((group) => known[group.address]).map((group) => [group.address, known[group.address]]))
}

export const noiseKinds: Category[] = ['newsletter', 'promo', 'notification', 'spam']

/**
 * Senders worth clearing in bulk: a classifier called the sample noise, or I never open them.
 * Flagged mail is never part of a bulk guess.
 */
export function likelyNoise(group: SenderGroup, minimum = 3): boolean {
  if (group.flagged) return false
  if (group.kind && noiseKinds.includes(group.kind) && (group.kindConfidence ?? 0) >= 0.7) return true
  return group.count >= minimum && group.unread / group.count >= 0.7
}

/** What the old mail sweep would take, and what it leaves. */
export type OldMail = { ids: string[]; unread: number; flagged: number }

/**
 * Mail older than the cutoff, read or not: its moment has passed, so all of it can be put away at once.
 * Flagged mail stays, because a flag is something I set by hand.
 */
export function oldMail(messages: ScanMessage[], olderThanDays: number, now = new Date()): OldMail {
  const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000).toISOString()
  const old = messages.filter((message) => message.receivedAt < cutoff)
  const taken = old.filter((message) => !message.flagged)
  return { ids: taken.map((message) => message.id), unread: taken.filter((message) => !message.isRead).length, flagged: old.length - taken.length }
}

export function describeGroup(group: SenderGroup): string {
  const parts = [`${group.count} ${group.count === 1 ? 'message' : 'messages'}`]
  if (group.unread) parts.push(`${group.unread} unread`)
  if (group.flagged) parts.push(`${group.flagged} flagged`)
  return parts.join(' · ')
}

/** What a cleared row says in place of its counts: what happened to the mail, and the rule when one was made. */
export function describeCleared(group: SenderGroup): string {
  const parts = [`${group.cleared === 'delete' ? 'deleted' : 'archived'} ${group.count}`]
  if (group.ruled) parts.push('rule added')
  return parts.join(' · ')
}

export function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}
