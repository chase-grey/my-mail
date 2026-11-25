export type Header = { name: string; value: string }

/** Where a sender says to go to stop their mail, from the List-Unsubscribe headers (RFC 2369 and RFC 8058). */
export type UnsubscribeTarget = {
  /** A one-click POST the app can send itself without opening anything. */
  oneClick?: string
  /** A page that has to be opened. */
  url?: string
  /** An address to write to; the app sends the message through Graph. Only the address is taken from the header. */
  mailto?: { to: string }
}

/** What an unsubscribe mail says, always. The header's own subject and body are the sender's words and are never sent from this mailbox. */
export const unsubscribeMail = { subject: 'unsubscribe', body: '' } as const

/**
 * The one address a `mailto:` target names, or nothing when it asks for more than that:
 * several recipients, or a to, cc or bcc among its fields. Its subject and body are ignored.
 */
export function mailtoAddress(target: string): string | undefined {
  const [recipient, ...rest] = target.slice('mailto:'.length).split('?')
  const fields = new URLSearchParams(rest.join('?'))
  if ([...fields.keys()].some((name) => ['to', 'cc', 'bcc'].includes(name.trim().toLowerCase()))) return undefined
  try {
    const address = decodeURIComponent(recipient).trim()
    return /^[^\s@,;:<>()"'\\?&%]+@[^\s@,;:<>()"'\\?&%]+\.[^\s@,;:<>()"'\\?&%]+$/.test(address) ? address : undefined
  } catch {
    return undefined
  }
}

const header = (headers: Header[], name: string) => headers.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? ''

export function parseUnsubscribe(headers: Header[]): UnsubscribeTarget | undefined {
  const list = header(headers, 'List-Unsubscribe')
  if (!list.trim()) return undefined
  const targets = [...list.matchAll(/<([^>]+)>/g)].map((match) => match[1].trim())
  const oneClick = /list-unsubscribe=one-click/i.test(header(headers, 'List-Unsubscribe-Post'))
  const result: UnsubscribeTarget = {}
  for (const target of targets) {
    // Only https is followed. A plain http target is ignored, for the POST and for the page alike.
    if (/^https:\/\//i.test(target)) {
      if (oneClick && !result.oneClick) result.oneClick = target
      else if (!result.url) result.url = target
    } else if (/^mailto:/i.test(target) && !result.mailto) {
      const to = mailtoAddress(target)
      if (to) result.mailto = { to }
    }
  }
  return result.oneClick || result.url || result.mailto ? result : undefined
}

export type UnsubscribeMethod = 'one-click' | 'mail' | 'page'

/** The quietest way that works: a one-click POST, then a mail, then opening the page. */
export function unsubscribeMethod(target: UnsubscribeTarget): UnsubscribeMethod {
  if (target.oneClick) return 'one-click'
  if (target.mailto) return 'mail'
  return 'page'
}

export const unsubscribeLabel: Record<UnsubscribeMethod, string> = {
  'one-click': 'unsubscribe',
  mail: 'unsubscribe by mail',
  page: 'open unsubscribe page',
}
