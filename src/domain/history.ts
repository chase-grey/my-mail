import type { Decision, Message, Triage } from './types'

/** Senders whose mail I keep clearing without opening. Their next message needs no model. */
export function noiseSenders(decisions: Decision[], minimum = 3): Set<string> {
  const tally = new Map<string, Set<string>>()
  for (const decision of decisions) {
    if (!decision.unread || !decision.from) continue
    if (decision.action !== 'archive' && decision.action !== 'delete') continue
    const ids = tally.get(decision.from) ?? new Set<string>()
    ids.add(decision.messageId)
    tally.set(decision.from, ids)
  }
  return new Set([...tally.entries()].filter(([, ids]) => ids.size >= minimum).map(([from]) => from))
}

/** A verdict from history alone: unread mail from a sender I always clear unread is noise until I say otherwise. */
export function historyTriage(message: Message, noise: Set<string>, triagedAt: string): Triage | undefined {
  if (message.isRead || message.flagged || message.importance === 'high') return undefined
  if (!noise.has(message.from.address.toLowerCase())) return undefined
  return { messageId: message.id, category: 'newsletter', summary: '', needsReply: false, suggested: 'archive', confidence: 0.9, source: 'history', triagedAt }
}

/** One line per sender for the model: how I have treated them so far. */
export function senderHistoryLine(decisions: Decision[], address: string): string {
  const mine = decisions.filter((decision) => decision.from === address.toLowerCase())
  if (!mine.length) return ''
  const count = (action: string) => mine.filter((decision) => decision.action === action).length
  const parts = [
    count('reply') && `replied ${count('reply')}`,
    count('task') && `made ${count('task')} tasks`,
    count('archive') && `archived ${count('archive')}${mine.filter((decision) => decision.action === 'archive' && decision.unread).length === count('archive') ? ' unread' : ''}`,
    count('delete') && `deleted ${count('delete')}`,
    count('keep') && `kept ${count('keep')}`,
  ].filter(Boolean)
  return parts.length ? `history with sender: ${parts.join(', ')}` : ''
}
