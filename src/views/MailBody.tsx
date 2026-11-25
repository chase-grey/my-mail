import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { brightness, darkened, frameDocument, frameSandbox, linkParts, loadsRemote, mailLook, wantsRemote, type MailContent, type MailLook } from '../domain/mailHtml'
import type { Message } from '../domain/types'
import { useMediaQuery } from '../ui'
import './mailBody.css'

/** Where a message's real content comes from. Without one, the reader shows the text the list already has. */
export const BodySource = createContext<((message: Message) => Promise<MailContent>) | undefined>(undefined)

/** Whether a message is from someone I know. Their pictures load on opening; everyone else's wait for `load images`. */
export const KnownSender = createContext<(message: Message) => boolean>(() => false)

/** How long the reader stays empty before it shows the list's text while the real message is still coming. */
const patience = 500
const smallest = 0.5

/** Messages switched to light this visit, so one that could not be read dark stays light when it is opened again. The oldest leave past the cap. */
const lightened = new Set<string>()
const lightenedCap = 200
function setLightened(id: string, on: boolean): void {
  lightened.delete(id)
  if (on) lightened.add(id)
  for (const oldest of lightened) {
    if (lightened.size <= lightenedCap) break
    lightened.delete(oldest)
  }
}

/** Messages whose pictures were asked for this visit, so one stays loaded when it is opened again. Nothing is kept past the visit. */
const pictured = new Set<string>()
function setPictured(id: string): void {
  pictured.delete(id)
  pictured.add(id)
  for (const oldest of pictured) {
    if (pictured.size <= lightenedCap) break
    pictured.delete(oldest)
  }
}

/** True when the message paints a dark page of its own: the first background met going down from the body is dark. */
function sentDark(doc: Document): boolean {
  let element: Element | undefined = doc.body
  for (let depth = 0; element && depth < 8; depth++) {
    const value = brightness(doc.defaultView!.getComputedStyle(element).backgroundColor)
    if (value !== undefined) return value < 0.35
    element = [...element.children].find((child) => !['STYLE', 'SCRIPT', 'META', 'TITLE', 'LINK', 'BASE'].includes(child.tagName))
  }
  return false
}

/**
 * A message's markup in a frame that cannot run scripts, sized to its content so the page scrolls, not the frame.
 * Mail wider than the space it has is shrunk to fit, the way a phone's mail app does.
 */
function HtmlFrame({ html, look, remote, title }: { html: string; look: MailLook; remote: boolean; title: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const box = wrap.current
    const element = frame.current
    if (!box || !element) return
    let observer: ResizeObserver | undefined
    let across = 0

    const measure = (reflow = false) => {
      const doc = element.contentDocument
      if (!doc?.body) return
      if (reflow) element.style.width = '100%'
      const room = box.clientWidth
      const wide = doc.documentElement.scrollWidth
      const scale = wide > room + 1 ? Math.max(smallest, room / wide) : 1
      if (scale < 1) element.style.width = `${wide}px`
      const tall = Math.ceil(Math.max(doc.documentElement.getBoundingClientRect().height, doc.body.scrollHeight))
      element.style.height = `${tall}px`
      element.style.transform = scale < 1 ? `scale(${scale})` : ''
      box.style.height = `${Math.ceil(tall * scale)}px`
    }

    const ready = () => {
      const doc = element.contentDocument
      if (!doc?.body) return
      // Mail that was sent dark is left alone; darkening it would turn it light.
      if (doc.documentElement.classList.contains(darkened) && sentDark(doc)) doc.documentElement.classList.remove(darkened)
      measure(true)
      observer?.disconnect()
      observer = new ResizeObserver(() => measure())
      observer.observe(doc.body)
      for (const image of doc.images) image.addEventListener('load', () => measure())
      // Keys pressed with the message focused still reach the app's shortcuts.
      doc.addEventListener('keydown', (event) => window.dispatchEvent(new KeyboardEvent('keydown', event)))
    }

    // The frame's own width changes when it is scaled, so only a change in the room around it starts over.
    const outer = new ResizeObserver(() => {
      if (Math.abs(box.clientWidth - across) < 1) return
      across = box.clientWidth
      measure(true)
    })
    outer.observe(box)
    element.addEventListener('load', ready)
    ready()
    return () => { element.removeEventListener('load', ready); observer?.disconnect(); outer.disconnect() }
  }, [html, look, remote])

  return <div className="mail-frame" ref={wrap}>
    <iframe ref={frame} title={title} sandbox={frameSandbox} referrerPolicy="no-referrer" srcDoc={frameDocument(html, look, remote)} />
  </div>
}

/** The body of an open message: the real thing once it arrives, the list's text if it does not. */
export function MailBody({ message }: { message: Message }) {
  const source = useContext(BodySource)
  const known = useContext(KnownSender)
  const appDark = useMediaQuery('(prefers-color-scheme: dark)')
  const [loaded, setLoaded] = useState<{ id: string; content: MailContent }>()
  const [waited, setWaited] = useState(false)
  const [, redraw] = useState(0)
  const content = loaded?.id === message.id ? loaded.content : undefined
  const { look, toggle } = mailLook(appDark, lightened.has(message.id))

  useEffect(() => {
    if (!source) return
    let current = true
    setWaited(false)
    const timer = setTimeout(() => setWaited(true), patience)
    source(message).then((found) => { if (current) setLoaded({ id: message.id, content: found }) }, () => { if (current) setWaited(true) })
    return () => { current = false; clearTimeout(timer) }
  }, [source, message.id])

  if (content?.html) {
    const remote = loadsRemote(message, known(message), pictured.has(message.id))
    const held = !remote && wantsRemote(content.html)
    return <div className="mail-body is-html">
      {(held || toggle) && <div className="mail-switches">
        {held && <button className="link mail-look" type="button" onClick={() => { setPictured(message.id); redraw((count) => count + 1) }}>load images</button>}
        {toggle && <button className="link mail-look" type="button" onClick={() => { setLightened(message.id, look === 'dark'); redraw((count) => count + 1) }}>{toggle}</button>}
      </div>}
      <HtmlFrame html={content.html} look={look} remote={remote} title={message.subject} />
    </div>
  }
  if (content?.text) return <div className="mail-body">{linkParts(content.text).map((part, index) => typeof part === 'string' ? part : <a key={index} href={part.href} target="_blank" rel="noreferrer">{part.href}</a>)}</div>
  if (source && !content && !waited) return <div className="mail-body is-waiting" />
  return <div className="mail-body">{message.body || message.preview || '(empty)'}</div>
}
