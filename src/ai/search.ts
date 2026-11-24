import type { SearchHit } from '../domain/search'
import { textOf, type AnthropicClient, type MessagesRequest } from './anthropicClient'

export type SearchPrompt = { aboutMe: string; today: string }

/** How a mailbox search is written. Shared by everything that has a model write one. */
export const kqlNotes = [
  'Bare words match anywhere in a message. Properties: from:, to:, cc:, participants:, subject:, body:, attachment: (a file name), hasattachments:true, importance:high, received.',
  'Dates are YYYY-MM-DD: received>=2026-03-01, received<2026-06-01, or a range as received:2026-03-01..2026-05-31. Use a date only when the request gives a time, and make the range generous.',
  'Join alternatives with OR in capitals inside parentheses; terms side by side must all match. Put a phrase in double quotes.',
  'Search matches whole words, so use few and distinctive ones, leave out filler, and when the sender could have used a different word, OR the likely ones: (invoice OR bill OR receipt). Prefer finding too much over finding nothing.',
]

export function translateSystemPrompt(today: string): string {
  return [
    'You turn what one person wants to find in their own mailbox into a single Microsoft Graph mail search query, written in KQL. Reply with the query and nothing else: no quotes around it, no explanation.',
    `Today is ${today}.`,
    ...kqlNotes,
  ].join('\n')
}

export function buildTranslateRequest(model: string, question: string, today: string): MessagesRequest {
  return { model, max_tokens: 1024, system: translateSystemPrompt(today), output_config: { effort: 'low' }, messages: [{ role: 'user', content: question }] }
}

/** The query out of whatever the model wrapped it in: a code fence, a label, a pair of quotes. */
export function cleanQuery(text: string): string {
  const line = text.replace(/```[a-z]*/gi, '').split('\n').map((item) => item.trim()).find(Boolean) ?? ''
  const bare = line.replace(/^(kql|query|search)\s*:\s*/i, '').replace(/^`+|`+$/g, '').trim()
  return /^"[^"]*"$/.test(bare) || /^'.*'$/.test(bare) ? bare.slice(1, -1).trim() : bare
}

/** A sentence in, a mailbox search out. */
export async function translateQuery(client: AnthropicClient, model: string, question: string, today: string): Promise<string> {
  const response = await client.createMessage(buildTranslateRequest(model, question, today))
  const query = cleanQuery(textOf(response.content))
  if (!query) throw new Error('could not write a search for that')
  return query
}

export function hitsText(hits: SearchHit[]): string {
  return hits.map(({ message, folder }, index) => [
    `### message ${index + 1}`,
    `from: ${message.from.name} <${message.from.address}>`,
    `received: ${message.receivedAt}`,
    folder ? `folder: ${folder}` : '',
    `subject: ${message.subject}`,
    message.hasAttachments ? 'attachments: yes' : '',
    '',
    message.body || message.preview || '(empty)',
  ].filter((line, at) => line !== '' || at === 6).join('\n')).join('\n\n')
}

export function answerSystemPrompt(context: SearchPrompt): string {
  return [
    'You answer one person\'s question from their own email. The messages a search found are given, numbered. Use only what they say.',
    `Today is ${context.today}.`,
    context.aboutMe.trim() ? `About the person, in their words: ${context.aboutMe.trim()}` : '',
    'Answer first, in a short paragraph of plain text with no markdown. After each fact put the number of the message it came from in square brackets, one number per bracket, like [2].',
    'Long messages are cut short. When the messages do not answer the question, say so in a sentence and say what they do show.',
  ].filter(Boolean).join('\n')
}

export function buildAnswerRequest(model: string, question: string, hits: SearchHit[], context: SearchPrompt): MessagesRequest {
  return { model, max_tokens: 2048, system: answerSystemPrompt(context), messages: [{ role: 'user', content: `${question}\n\n${hitsText(hits)}` }] }
}

/** Reads what the search found and answers the question, citing messages by number. */
export async function answerFromMail(client: AnthropicClient, model: string, question: string, hits: SearchHit[], context: SearchPrompt): Promise<string> {
  const response = await client.createMessage(buildAnswerRequest(model, question, hits, context))
  return textOf(response.content)
}
