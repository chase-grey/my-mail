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

export type Sender = { name: string; address: string }

/** The word being typed, when it could be the start of a sender: the last one, two letters or more, and not already an operator or a phrase. */
export function senderWord(text: string): string {
  const word = /(\S+)$/.exec(text)?.[1].toLowerCase() ?? ''
  return word.length < 2 || /[:"<>=()]/.test(word) ? '' : word
}

/** Senders whose name or address starts with the word being typed, in the order given, one per address. */
export function suggestSenders(text: string, senders: Sender[], limit = 4): Sender[] {
  const word = senderWord(text)
  if (!word) return []
  const seen = new Set<string>()
  const found: Sender[] = []
  for (const sender of senders) {
    const address = sender.address.toLowerCase()
    if (!address || seen.has(address)) continue
    const starts = [address, address.split('@')[1] ?? '', ...sender.name.toLowerCase().split(/[^\p{L}\p{N}]+/u)]
    if (!starts.some((part) => part.startsWith(word))) continue
    seen.add(address)
    found.push(sender)
    if (found.length === limit) break
  }
  return found
}

/** The search with the word being typed swapped for mail from that address. */
export function fromSender(text: string, address: string): string {
  return text.replace(/\S+$/, `from:${address}`)
}

/** What has been typed, when it is plain words long enough to look for in mail: three letters or more and no operator or phrase. */
export function subjectText(text: string): string {
  const value = text.trim().toLowerCase()
  return value.length < 3 || /[:"<>=()]/.test(value) ? '' : value
}

/** A subject without the reply and forward marks in front of it. */
export function bareSubject(subject: string): string {
  return subject.replace(/^((re|fw|fwd)\s*:\s*)+/i, '').trim()
}

/**
 * Subjects to offer for what has been typed. Those at hand are kept when every word typed starts a word in them;
 * those the mailbox found are kept as they are, since it may have matched the body. One of each, in the order given.
 */
export function suggestSubjects(text: string, atHand: string[], found: string[] = [], limit = 4): string[] {
  const typed = subjectText(text)
  if (!typed) return []
  const words = typed.split(/\s+/)
  const matches = (subject: string) => {
    const parts = subject.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    return words.every((word) => parts.some((part) => part.startsWith(word)))
  }
  const seen = new Set<string>([typed])
  const offered: string[] = []
  for (const subject of [...atHand.map(bareSubject).filter(matches), ...found.map(bareSubject)]) {
    const key = subject.toLowerCase()
    if (!subject || subject === '(no subject)' || seen.has(key)) continue
    seen.add(key)
    offered.push(subject)
    if (offered.length === limit) break
  }
  return offered
}

/** A search for mail with that subject. */
export function subjectSearch(subject: string): string {
  return `subject:"${subject.replace(/"/g, '')}"`
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
