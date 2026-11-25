import type { Message } from './types'

/** Words that only mail carrying a sign-in code uses. After one of these the code may have letters in it. */
const sureWords = ['verification code', 'security code', 'login code', 'log-in code', 'sign-in code', 'sign in code', 'signup code', 'sign-up code', 'authentication code', 'one-time', 'one time code', 'passcode']
/** Words a sale uses too (`your code: SAVE20`). After one of these only digits count. */
const looseWords = ['confirmation code', 'access code', 'temporary code', 'your code']

/** Every phrase that marks code mail. The rules written to Outlook carry the same list as their exception. */
export const codeWords = [...sureWords, ...looseWords]

const escaped = (words: string[]) => words.map((word) => word.replace(/[-]/g, '\\-').replace(/ /g, '\\s+')).join('|')
const wordPattern = () => new RegExp(`\\b(?:(${escaped(sureWords)})|${escaped(looseWords)})\\b`, 'gi')
/** Four to eight digits, or two groups of three. Not part of a price, a phone number, a time or a longer number. */
const digitPattern = () => /(?<![\w$#/.:]|\d[ -])(\d{3}[ -]\d{3}|\d{4,8})(?![\w%/:]|[.,]\d|[ -]\d)/g
/** Capitals and digits together, as some services send. */
const mixedPattern = () => /(?<![\w-])(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,8}(?![\w-])/g

/** How far after the words a code may sit, and how far before them (`482913 is your code`). */
const reachAfter = 200
const reachBefore = 30

const isYear = (text: string) => /^(19|20)\d\d$/.test(text)

function find(text: string): string | undefined {
  const digits = [...text.matchAll(digitPattern())].filter((match) => !isYear(match[0]))
  const mixed = [...text.matchAll(mixedPattern())]
  let best: { code: string; gap: number } | undefined
  for (const words of text.matchAll(wordPattern())) {
    const start = words.index
    const end = start + words[0].length
    for (const match of words[1] ? [...digits, ...mixed] : digits) {
      const at = match.index
      const after = at - end
      const before = start - (at + match[0].length)
      // A code ahead of the words has to be much closer to them than one that follows.
      const gap = after >= 0 && after <= reachAfter ? after : before >= 0 && before <= reachBefore ? before * 4 : undefined
      if (gap !== undefined && (!best || gap < best.gap)) best = { code: match[0].replace(/[ -]/g, ''), gap }
    }
  }
  return best?.code
}

const found = new WeakMap<object, string | undefined>()

/** The sign-in or verification code a message carries, ready to paste. Worked out from its words alone; no model reads it. */
export function codeOf(message: Pick<Message, 'subject' | 'preview' | 'body'>): string | undefined {
  if (found.has(message)) return found.get(message)
  const code = find(`${message.subject}\n${message.body || message.preview}`)
  found.set(message, code)
  return code
}
