import type { Message } from './types'

/** A message a search found, and where it lives now. */
export type SearchHit = {
  message: Message
  inInbox: boolean
  /** The folder's name when the message is somewhere other than the inbox and the folder is known. */
  folder?: string
}

export type SearchPage = { hits: SearchHit[]; next?: string }

/** Find sends the words to the mailbox as they are. Ask has the model write the search and read what comes back. */
export type SearchMode = 'find' | 'ask'

const operator = /\b(from|to|cc|bcc|participants|recipients|subject|body|attachment|hasattachments?|received|sent|importance|kind|size)\s*[:<>=]/i
const connective = /"|\b(AND|OR|NOT)\b/
const asking = /^(who|what|when|where|which|why|how|did|does|do|is|are|was|were|has|have|had|can|could|should|will|would|find|show|tell)\b/i

/** A search operator or a few bare words is a find; a question or a sentence is an ask. */
export function searchMode(text: string): SearchMode {
  const value = text.trim()
  if (!value || operator.test(value) || connective.test(value)) return 'find'
  if (value.endsWith('?')) return 'ask'
  const words = value.split(/\s+/).length
  return words >= 6 || (words >= 3 && asking.test(value)) ? 'ask' : 'find'
}

/** Newest first, no repeats, capped. */
export function rememberSearch(recent: string[], text: string, limit = 8): string[] {
  const value = text.trim()
  if (!value) return recent
  return [value, ...recent.filter((item) => item.toLowerCase() !== value.toLowerCase())].slice(0, limit)
}

/** An answer split into its words and the message numbers it cites, so each `[2]` can open message 2. Numbers that match nothing stay as text. */
export function answerParts(text: string, count: number): (string | number)[] {
  const parts: (string | number)[] = []
  let last = 0
  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1])
    if (n < 1 || n > count) continue
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push(n)
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
