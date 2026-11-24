/** Lines that start quoted history. Everything from the first one on is someone else's words, already read. */
const quoteStarts = [
  /^on .{3,120} wrote:\s*$/i,
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^-{2,}\s*forwarded message\s*-{2,}$/i,
  /^from:\s.+$/i,
  /^_{10,}$/,
  /^>/,
]

/** Lines after which a bulk mailing has nothing left to say. */
const footerStarts = [
  /^unsubscribe\b/i,
  /^to unsubscribe\b/i,
  /^you (are|'re) receiving this (email|message)\b/i,
  /^you received this (email|message)\b/i,
  /^this email was sent to\b/i,
  /^view (this email )?in (your )?browser\b/i,
  /^manage (your )?(email )?preferences\b/i,
  /^update (your )?(email )?preferences\b/i,
  /^privacy policy\b/i,
  /^©|^\(c\) \d{4}/i,
]

const urlPattern = /https?:\/\/\S+/g

/**
 * Graph writes a link as its words and then the address in angle brackets: `return<https://…>`.
 * The words stay and the address goes; an address with no words of its own becomes `[link]`.
 */
const shortLinks = (line: string) => line.replace(/(\S)?<https?:\/\/[^>\s]*>/g, (_, before?: string) => before ?? '[link]').replace(urlPattern, '[link]')

/** The part of a body worth a model's attention: no quoted history, no mailing footer, no raw links, capped. */
export function trimForModel(body: string, limit = 1500): string {
  const lines = body.replace(/\r/g, '').split('\n')
  const kept: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (quoteStarts.some((pattern) => pattern.test(line)) && kept.length) break
    if (footerStarts.some((pattern) => pattern.test(line)) && kept.length) break
    kept.push(shortLinks(line))
  }
  const text = kept.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
