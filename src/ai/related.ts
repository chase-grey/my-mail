import type { SearchHit, SearchPage } from '../domain/search'
import { threadKey } from '../domain/threads'
import type { Message } from '../domain/types'
import { textOf, type AnthropicClient, type MessagesRequest } from './anthropicClient'
import { cleanQuery, hitsText, kqlNotes } from './search'

export const relatedQueryLimit = 3
export const relatedPerQuery = 10
export const relatedReadLimit = 20

const messageText = (message: Message) => [
  `from: ${message.from.name} <${message.from.address}>`,
  `received: ${message.receivedAt}`,
  `subject: ${message.subject}`,
  '',
  message.body || message.preview || '(empty)',
].join('\n')

export function relatedQueriesPrompt(today: string): string {
  return [
    `You are given one email from a person's own mailbox. Write up to ${relatedQueryLimit} Microsoft Graph mail search queries in KQL that would find their other mail about the same matter: the same order, booking, bill, account, project, event, or the same people on the same subject. One query per line and nothing else: no numbering, no quotes around a query, no explanation.`,
    `Today is ${today}.`,
    ...kqlNotes,
    'Make each query a different way in: the names or reference numbers in the message, the other people or companies it mentions, the subject in other words. Do not just search for the sender; mail from the same sender is found another way.',
  ].join('\n')
}

export function buildRelatedQueriesRequest(model: string, message: Message, today: string): MessagesRequest {
  return { model, max_tokens: 1024, system: relatedQueriesPrompt(today), output_config: { effort: 'low' }, messages: [{ role: 'user', content: messageText(message) }] }
}

/** One search per line, cleaned of whatever the model wrapped them in. */
export function parseQueries(text: string): string[] {
  const lines = text.replace(/```[a-z]*/gi, '').split('\n').map((line) => cleanQuery(line.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, ''))).filter(Boolean)
  return [...new Set(lines)].slice(0, relatedQueryLimit)
}

export function relatedPickPrompt(): string {
  return [
    'You are given one email from a person\'s own mailbox, then numbered messages a search of the same mailbox found. Say which of the numbered messages are about the same matter as the email: the same order, booking, bill, account, project, event, or conversation.',
    'Sharing a sender or a common word is not enough.',
    'Reply with the numbers only, most closely related first, separated by commas. When none are related, reply with the word none.',
  ].join('\n')
}

export function buildRelatedPickRequest(model: string, message: Message, hits: SearchHit[]): MessagesRequest {
  return { model, max_tokens: 1024, system: relatedPickPrompt(), output_config: { effort: 'low' }, messages: [{ role: 'user', content: `${messageText(message)}\n\n## found\n\n${hitsText(hits)}` }] }
}

/** The message numbers in a reply, in the order given, without repeats or numbers that match nothing. */
export function parsePicks(text: string, count: number): number[] {
  const picks = [...text.matchAll(/\d+/g)].map((match) => Number(match[0])).filter((n) => n >= 1 && n <= count)
  return [...new Set(picks)]
}

/**
 * Other mail about the same matter as a message. A model writes a few searches from the message, the mailbox runs them,
 * and the model reads what came back and keeps what is related. The message's own conversation is left out.
 */
export async function findRelated(
  client: AnthropicClient,
  model: string,
  message: Message,
  search: (query: string, count: number) => Promise<SearchPage>,
  today: string,
  onStep?: (step: string) => void,
): Promise<SearchHit[]> {
  onStep?.('writing the search')
  const queries = parseQueries(textOf((await client.createMessage(buildRelatedQueriesRequest(model, message, today))).content))
  if (!queries.length) throw new Error('could not write a search for that')

  onStep?.('searching')
  // A query the mailbox cannot parse costs that query, not the rest.
  const pages = await Promise.allSettled(queries.map((query) => search(query, relatedPerQuery)))
  const failure = pages.find((page) => page.status === 'rejected')
  if (failure && pages.every((page) => page.status === 'rejected')) throw failure.reason
  const own = threadKey(message)
  const seen = new Set<string>()
  const found = pages.flatMap((page) => page.status === 'fulfilled' ? page.value.hits : []).filter((hit) => {
    if (threadKey(hit.message) === own || seen.has(hit.message.id)) return false
    seen.add(hit.message.id)
    return true
  }).slice(0, relatedReadLimit)
  if (!found.length) return []

  onStep?.(`reading ${found.length} ${found.length === 1 ? 'message' : 'messages'}`)
  const picks = parsePicks(textOf((await client.createMessage(buildRelatedPickRequest(model, message, found))).content), found.length)
  return picks.map((n) => found[n - 1])
}
