import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { SearchHit } from '../domain/search'
import { hitThreads, threadKey, type HitThread } from '../domain/threads'
import type { Message } from '../domain/types'
import { MailBody } from './MailBody'
import './thread.css'

/** What an open message needs from the mailbox to show its conversation and the mail around it. */
export type ThreadActions = {
  /** Every message in the conversation, in any folder, newest first, with whole bodies. */
  thread: (message: Message) => Promise<Message[]>
  /** Other mail from the same sender, in any folder. */
  fromSender: (message: Message) => Promise<SearchHit[]>
  /** One line on what the message is and what it wants, written by a model when asked. Missing when there is no model. */
  /** Nothing comes back when the message already shows its summary. */
  summarize?: (message: Message) => Promise<string | undefined>
  /** Mail about the same matter, found by a model. Missing when there is no model. */
  related?: (message: Message, onStep: (step: string) => void) => Promise<SearchHit[]>
  /** Opens My Brain's chat about this conversation. Missing when no My Brain is set. */
  chat?: (message: Message) => void
}

/** Given by the app once it is connected. Without it an open message shows only itself. */
export const ThreadContext = createContext<ThreadActions | undefined>(undefined)

/** Conversations already read this visit, so reopening one shows it at once. The oldest leave past the cap. */
const read = new Map<string, Message[]>()
const readCap = 60
function remember(key: string, messages: Message[]): void {
  read.delete(key)
  read.set(key, messages)
  for (const oldest of read.keys()) {
    if (read.size <= readCap) break
    read.delete(oldest)
  }
}

/** Related mail reaches back years, so anything from another year says which. */
function dated(receivedAt: string, long = false): string {
  const value = new Date(receivedAt)
  const now = new Date()
  const time = value.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  if (now.toDateString() === value.toDateString()) return time
  const sameYear = now.getFullYear() === value.getFullYear()
  const day = value.toLocaleDateString(undefined, sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase()
  return long ? `${day}, ${time}` : day
}

const failed = (error: unknown) => error instanceof Error ? error.message.toLowerCase() : 'search failed'

/**
 * The body of an open message, as its whole conversation: every message in it from any folder, newest first,
 * the one that was opened shown in full and the rest one tap away. Under it, ways to the mail around it.
 * Until the conversation is read, and whenever it cannot be, the message shows alone.
 */
export function Conversation({ message, related = true }: { message: Message; related?: boolean }) {
  const actions = useContext(ThreadContext)
  const current = useRef(actions)
  current.current = actions
  const key = threadKey(message)
  const [messages, setMessages] = useState(() => read.get(key))
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const connected = Boolean(actions)

  useEffect(() => {
    if (!current.current) return
    let live = true
    setMessages(read.get(key))
    current.current.thread(message).then((found) => {
      if (!found.length) return
      remember(key, found)
      if (live) setMessages(found)
    }).catch(() => undefined)
    return () => { live = false }
    // A new message in the conversation changes the id at its head, which reads it again.
  }, [key, message.id, connected])

  const list = messages?.length ? messages : [message]
  const lead = (list.find((item) => item.id === message.id) ?? list[0]).id

  return <>
    <div className="thread">
      {list.map((item) => {
        const open = toggled[item.id] ?? item.id === lead
        return <section className="thread-mail" key={item.id}>
          {list.length > 1 && <button className="thread-head" type="button" aria-expanded={open} onClick={() => setToggled((shown) => ({ ...shown, [item.id]: !open }))}>
            <span className="thread-from" title={item.from.address}>{item.from.name}</span>
            <span className="thread-preview">{open ? '' : item.preview}</span>
            <small>{dated(item.receivedAt, open)}</small>
          </button>}
          {open && <MailBody message={item} />}
        </section>
      })}
    </div>
    {related && actions && <Related message={message} actions={actions} />}
  </>
}

type Kind = 'sender' | 'related'

/** Mail around the open message: the rest from its sender, or what a model finds about the same matter. */
function Related({ message, actions }: { message: Message; actions: ThreadActions }) {
  const [shown, setShown] = useState<{ kind: Kind; threads: HitThread[] }>()
  const [busy, setBusy] = useState<{ kind: Kind; step: string }>()
  const [error, setError] = useState<string>()
  const [openKey, setOpenKey] = useState<string>()
  const [summary, setSummary] = useState<string>()
  const [summarizing, setSummarizing] = useState(false)
  const run = useRef(0)
  const picked = busy?.kind ?? shown?.kind

  function look(kind: Kind): void {
    const id = ++run.current
    setError(undefined)
    setOpenKey(undefined)
    // A second tap on what is showing puts it away.
    if (picked === kind) { setShown(undefined); setBusy(undefined); return }
    setShown(undefined)
    setBusy({ kind, step: 'searching' })
    const work = kind === 'sender' ? actions.fromSender(message) : actions.related!(message, (step) => { if (id === run.current) setBusy({ kind, step }) })
    work.then((hits) => { if (id === run.current) setShown({ kind, threads: hitThreads(hits, threadKey(message)) }) })
      .catch((failure: unknown) => { if (id === run.current) setError(failed(failure)) })
      .finally(() => { if (id === run.current) setBusy(undefined) })
  }

  function summarize(): void {
    setError(undefined)
    setSummarizing(true)
    actions.summarize!(message).then(setSummary).catch((failure: unknown) => setError(failed(failure))).finally(() => setSummarizing(false))
  }

  return <div className="related">
    <div className="related-actions">
      {actions.summarize && <button className="link" type="button" disabled={summarizing} onClick={summarize}>{summarizing ? 'summarizing' : 'summarize'}</button>}
      <button className="link" type="button" aria-pressed={picked === 'sender'} onClick={() => look('sender')}>more from {message.from.name}</button>
      {actions.related && <button className="link" type="button" aria-pressed={picked === 'related'} onClick={() => look('related')}>find related</button>}
      {actions.chat && <button className="link" type="button" onClick={() => actions.chat!(message)}>chat</button>}
    </div>
    {summary && <p className="note">{summary}</p>}
    {busy && <p className="status is-busy" aria-live="polite">{busy.step}</p>}
    {error && <p className="note is-error" role="alert">{error}</p>}
    {shown && !shown.threads.length && <p className="note">nothing found</p>}
    {shown && shown.threads.length > 0 && <ul className="related-list">
      {shown.threads.map((thread) => {
        const open = openKey === thread.key
        const facts = [shown.kind === 'related' && thread.message.from.name, thread.folder].filter(Boolean).join(' · ')
        return <li key={thread.key}>
          <button className="related-row" type="button" aria-expanded={open} onClick={() => setOpenKey(open ? undefined : thread.key)}>
            <span className="related-top"><span className="related-subject">{thread.message.subject}</span><small>{dated(thread.message.receivedAt)}</small></span>
            <span className="related-line">{facts ? `${facts} · ` : ''}{thread.message.preview}</span>
          </button>
          {open && <div className="related-open"><Conversation message={thread.message} related={false} /></div>}
        </li>
      })}
    </ul>}
  </div>
}
