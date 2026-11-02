export type Header = { name: string; value: string }

/** Where a sender says to go to stop their mail, from the List-Unsubscribe headers (RFC 2369 and RFC 8058). */
export type UnsubscribeTarget = {
  /** A one-click POST the app can send itself without opening anything. */
  oneClick?: string
  /** A page that has to be opened. */
  url?: string
  /** An address to write to; the app sends the message through Graph. */
  mailto?: { to: string; subject: string; body: string }
}

const header = (headers: Header[], name: string) => headers.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? ''

export function parseUnsubscribe(headers: Header[]): UnsubscribeTarget | undefined {
  const list = header(headers, 'List-Unsubscribe')
  if (!list.trim()) return undefined
  const targets = [...list.matchAll(/<([^>]+)>/g)].map((match) => match[1].trim())
  const oneClick = /list-unsubscribe=one-click/i.test(header(headers, 'List-Unsubscribe-Post'))
  const result: UnsubscribeTarget = {}
  for (const target of targets) {
    if (/^https?:\/\//i.test(target)) {
      if (oneClick && !result.oneClick) result.oneClick = target
      else if (!result.url) result.url = target
    } else if (/^mailto:/i.test(target) && !result.mailto) {
      const [address, query = ''] = target.slice('mailto:'.length).split('?')
      const params = new URLSearchParams(query)
      result.mailto = { to: decodeURIComponent(address), subject: params.get('subject') ?? 'unsubscribe', body: params.get('body') ?? 'unsubscribe' }
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
