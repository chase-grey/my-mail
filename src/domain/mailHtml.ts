/** A message as it was written, for reading: its html when it has any, and its whole text otherwise. */
export type MailContent = { html?: string; text: string }

/**
 * What a message's own markup may load. Never scripts, frames, forms, or stylesheets from elsewhere.
 * Pictures and fonts come only from inside the message itself, so opening mail tells its sender nothing,
 * unless `remote` is on: then they load over https too. That is for people I know, and for one message on a tap.
 */
export function framePolicy(remote = false): string {
  return remote
    ? "default-src 'none'; img-src https: data: cid:; style-src 'unsafe-inline'; font-src https: data:"
    : "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:"
}

/** What the reading frame is allowed to do. It never runs scripts: there is no `allow-scripts` here and there must never be. */
export const frameSandbox = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox'

/** True when the markup asks for a picture or font from somewhere else, which the frame holds back until it is allowed. */
export function wantsRemote(html: string): boolean {
  return /\b(?:src|srcset|background|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html) || /url\(\s*(?:["']|&quot;|&#39;)?\s*(?:https?:)?\/\//i.test(html)
}

/**
 * Whether a message's pictures load from elsewhere on opening: only for someone I know, and never for mail that came out of junk,
 * where the name on it is only a claim. Everyone else's wait for `load images`.
 */
export function loadsRemote(message: { fromJunk?: boolean }, known: boolean, asked: boolean): boolean {
  return asked || (known && !message.fromJunk)
}

/**
 * How an open message is drawn. `app`: the app is light and so is the mail. `dark`: the app is dark and the mail is darkened to match.
 * `light`: the app is dark, and this one message was switched back to how it was sent.
 */
export type MailLook = 'app' | 'dark' | 'light'

/**
 * In dark mode every message is darkened, and each has a switch back to light for the one that cannot be read.
 * In light mode mail is shown as sent and there is nothing to switch.
 */
export function mailLook(appDark: boolean, lightened: boolean): { look: MailLook; toggle?: 'light mode' | 'dark mode' } {
  if (!appDark) return { look: 'app' }
  return lightened ? { look: 'light', toggle: 'dark mode' } : { look: 'dark', toggle: 'light mode' }
}

/** The class on the frame's root that turns the darkening on. The reader takes it off mail that was sent dark already. */
export const darkened = 'is-darkened'

const font = 'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", sans-serif'
// Turns white into the app's dark surface and black into its text colour, and keeps hues where they were.
const darken = 'invert(1) hue-rotate(180deg) contrast(0.82)'
// The same steps undone, for what should look as it was sent: pictures.
const undarken = 'contrast(1.22) hue-rotate(180deg) invert(1)'

/** True when the markup sets no colours of its own, so it can simply wear the app's. */
export function wearsAppColours(html: string): boolean {
  return !/bgcolor|background|color\s*[:=]/i.test(html)
}

/**
 * The document the reading frame shows: the message's markup behind a policy that stops it loading anything but pictures,
 * and those from elsewhere only when `remote` says so, with links opening in a new tab.
 * The policy comes first so it governs everything the message brings; the frame's sandbox is what stops scripts.
 */
export function frameDocument(html: string, look: MailLook = 'app', remote = false): string {
  const plain = wearsAppColours(html)
  const style = [
    // A frame is only see-through when its scheme matches the app's, so dark mail says dark even though its colours are flipped after.
    `:root { color-scheme: ${look === 'dark' ? 'dark' : 'light'}; }`,
    'html { overflow-y: hidden; }',
    `body { margin: 0; font: 16px/1.6 ${font}; overflow-wrap: break-word; }`,
    // Mail with no colours of its own takes the app's and sits straight on the page.
    plain && look === 'app' ? 'body { color: #1a1a1a; } a { color: #1f6f5f; }' : '',
    plain && look === 'dark' ? 'body { color: #ececea; } a { color: #5fc2a8; }' : '',
    // Mail with its own colours was written for a white page. Light, it gets one. Dark, it sits on the app's page with the
    // ink a white page would have had, which the darkening then turns light.
    look === 'light' || (look === 'app' && !plain) ? 'html { background: #fff; } body { color: #1a1a1a; }' : '',
    look === 'dark' && !plain ? `body { color: #1a1a1a; } a { color: #1a5fb4; } html:not(.${darkened}) body { color: #ececea; } html:not(.${darkened}) a { color: #5fc2a8; }` : '',
    look === 'light' ? 'body { padding: 12px; }' : '',
    `html.${darkened} { filter: ${darken}; }`,
    `html.${darkened} :is(img, picture, video, svg) { filter: ${undarken}; }`,
    `html.${darkened} :is(picture, svg) img { filter: none; }`,
    'img { max-width: 100%; height: auto; }',
    'img[src^="cid:"] { display: none; }',
    'pre { font: inherit; white-space: pre-wrap; }',
  ].filter(Boolean).join('\n')
  const root = look === 'dark' && !plain ? `<html class="${darkened}">` : ''
  const head = `<!doctype html>${root}<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${framePolicy(remote)}"><base target="_blank"><style>${style}</style>`
  return head + html.replace(/<meta[^>]+http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, '')
}

/** How bright a css colour is, 0 to 1. Nothing for a colour that is see-through or not `rgb()`. */
export function brightness(colour: string): number | undefined {
  const parts = colour.match(/[\d.]+/g)?.map(Number)
  if (!colour.startsWith('rgb') || !parts || parts.length < 3 || (parts[3] ?? 1) < 0.5) return undefined
  return (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255
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
