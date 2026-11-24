/** A message as it was written, for reading: its html when it has any, and its whole text otherwise. */
export type MailContent = { html?: string; text: string }

/** What a message's own markup may load. No scripts, frames, forms, or stylesheets from elsewhere; pictures only over https. */
export const framePolicy = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:"

const text = 'light-dark(#1a1a1a, #ececea)'
const accent = 'light-dark(#1f6f5f, #5fc2a8)'
const font = 'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", sans-serif'

/** True when the markup sets no colours of its own, so it can wear the app's and follow dark mode. */
export function wearsAppColours(html: string): boolean {
  return !/bgcolor|background|color\s*[:=]/i.test(html)
}

/**
 * The document the reading frame shows: the message's markup behind a policy that stops it loading anything but pictures,
 * with links opening in a new tab. Mail with its own colours is laid on white, the way it was designed to be seen.
 * The policy comes first so it governs everything the message brings; the frame's sandbox is what stops scripts.
 */
export function frameDocument(html: string): string {
  const themed = wearsAppColours(html)
  const style = [
    `:root { color-scheme: ${themed ? 'light dark' : 'light'}; }`,
    'html { overflow-y: hidden; }',
    `body { margin: 0; font: 16px/1.6 ${font}; overflow-wrap: break-word; ${themed ? `color: ${text}; background: transparent;` : 'color: #1a1a1a; background: #fff;'} }`,
    themed ? `a { color: ${accent}; }` : '@media (prefers-color-scheme: dark) { body { padding: 12px; } }',
    'img { max-width: 100%; height: auto; }',
    'img[src^="cid:"] { display: none; }',
    'pre { font: inherit; white-space: pre-wrap; }',
  ].join('\n')
  const head = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${framePolicy}"><base target="_blank"><style>${style}</style>`
  return head + html.replace(/<meta[^>]+http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, '')
}

/** Text split around the links in it, so each can be made tappable. */
export function linkParts(body: string): (string | { href: string })[] {
  const parts: (string | { href: string })[] = []
  let at = 0
  for (const match of body.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    const href = match[0].replace(/[.,;:!?]+$/, '')
    if (match.index > at) parts.push(body.slice(at, match.index))
    parts.push({ href })
    at = match.index + href.length
  }
  if (at < body.length) parts.push(body.slice(at))
  return parts
}
