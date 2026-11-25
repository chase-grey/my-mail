import { useEffect, useRef, useState } from 'react'
import { folderNames, type FolderName } from '../data/mailProvider'
import type { Message } from '../domain/types'
import { Empty, Fold, Menu, Segmented, Toast, useMediaQuery, type MenuItem, type ToastState } from '../ui'
import type { ComposeRequest } from './Compose'
import { NearEnd } from './NearEnd'
import { Conversation } from './Thread'

export type FolderActions = {
  /** The newest mail in the folder, or the next page received at or before `before`. */
  load: (folder: FolderName, before?: string) => Promise<{ messages: Message[]; more: boolean }>
  toInbox: (message: Message) => Promise<void>
  remove: (message: Message) => Promise<void>
  /** Undo for a delete: back to the folder it was in. */
  putBack: (message: Message, folder: FolderName) => Promise<void>
  compose: (request: ComposeRequest) => void
}

const folderKey = 'my-mail.folder.v1'
const options = folderNames.map((name) => ({ value: name, label: name }))

/** The folder last looked at, on this device. */
export function lastFolder(stored: string | null): FolderName {
  return folderNames.find((name) => name === stored) ?? 'sent'
}

function loadFolder(): FolderName {
  try { return lastFolder(localStorage.getItem(folderKey)) } catch { return 'sent' }
}

/** Sent mail and drafts are all from me, so they are listed by who they are to. */
export const listedByRecipient = (folder: FolderName) => folder === 'sent' || folder === 'drafts'

export function rowName(message: Message, folder: FolderName): string {
  if (!listedByRecipient(folder)) return message.from.name
  const [first, ...rest] = message.to ?? []
  if (!first) return 'no recipient'
  return rest.length ? `${first.name} +${rest.length}` : first.name
}

/** Folders reach back years, so anything from another year says which. */
function dated(receivedAt: string, long = false): string {
  const value = new Date(receivedAt)
  const now = new Date()
  const time = value.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  if (now.toDateString() === value.toDateString()) return time
  const sameYear = now.getFullYear() === value.getFullYear()
  const day = value.toLocaleDateString(undefined, sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase()
  return long ? `${day}, ${time}` : day
}

type Handlers = {
  compose: (message: Message, mode: 'reply' | 'replyAll' | 'forward') => void
  toInbox: (message: Message) => void
  remove: (message: Message) => void
}

/** The message itself. Inline under the row on a phone, in the reading pane on a wide screen. */
function Detail({ message, folder, pane, on }: { message: Message; folder: FolderName; pane: boolean; on: Handlers }) {
  const sent = folder === 'sent'
  const rest: MenuItem[] = [
    { label: 'reply all', onSelect: () => on.compose(message, 'replyAll') },
    ...(sent ? [] : [{ label: 'forward', onSelect: () => on.compose(message, 'forward') }]),
    ...(folder === 'deleted' ? [] : [{ label: 'delete', onSelect: () => on.remove(message) }]),
  ]
  const people = sent ? `to ${(message.to ?? []).map((person) => person.name).join(', ')}` : `<${message.from.address}>`
  return <div className="detail">
    <div className="mail-actions">
      <button type="button" onClick={() => on.compose(message, 'reply')}>reply</button>
      {sent
        ? <button type="button" onClick={() => on.compose(message, 'forward')}>forward</button>
        : <button type="button" onClick={() => on.toInbox(message)}>move to inbox</button>}
      <Menu label={`more for ${message.subject}`} items={rest} />
    </div>
    {pane && <h2 className="detail-subject">{message.subject}</h2>}
    <p className="detail-meta"><span>{pane && !sent && <b className="detail-from">{message.from.name}</b>}{people}</span><span>{dated(message.receivedAt, true)}</span></p>
    <Conversation message={message} />
  </div>
}

const failed = (error: unknown) => error instanceof Error ? error.message.toLowerCase() : 'something failed'

/** The folders beside the inbox: sent, drafts, archive, snoozed and deleted. One at a time, newest first. */
export function FoldersView({ actions, refresh = 0 }: { actions: FolderActions; /** Changes when a message was written, so drafts and sent are read again. */ refresh?: number }) {
  const [folder, setFolder] = useState<FolderName>(loadFolder)
  const [messages, setMessages] = useState<Message[]>([])
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState<string | undefined>('loading')
  const [error, setError] = useState<string>()
  const [openId, setOpenId] = useState<string>()
  const [toast, setToast] = useState<ToastState>()
  const pane = useMediaQuery('(min-width: 60rem)')
  const drafts = folder === 'drafts'
  const selected = drafts ? undefined : messages.find((message) => message.id === openId) ?? (pane ? messages[0] : undefined)
  const current = useRef(actions)
  current.current = actions
  const run = useRef(0)

  /** The first page when `shown` is empty, the next one otherwise. A quiet read leaves the list up while it asks. */
  async function read(from: FolderName, shown: Message[], quiet = false): Promise<void> {
    const id = ++run.current
    if (!quiet) setBusy(shown.length ? 'loading more' : 'loading')
    setError(undefined)
    try {
      const oldest = shown.reduce<string | undefined>((least, message) => !least || message.receivedAt < least ? message.receivedAt : least, undefined)
      const page = await current.current.load(from, oldest)
      if (id !== run.current) return
      const have = new Set(shown.map((message) => message.id))
      const fresh = page.messages.filter((message) => !have.has(message.id))
      setMessages([...shown, ...fresh])
      // A page of nothing new means the date window did not move; stop instead of asking again.
      setMore(page.more && fresh.length > 0)
    } catch (failure) {
      if (id === run.current) setError(failed(failure))
    } finally {
      if (id === run.current) setBusy(undefined)
    }
  }

  const first = useRef(true)
  const lastRead = useRef<FolderName>(undefined)
  useEffect(() => {
    // Picking a folder empties the list; a message just written only reads the same folder again.
    const quiet = !first.current && lastRead.current === folder
    first.current = false
    lastRead.current = folder
    if (!quiet) { setMessages([]); setMore(false); setOpenId(undefined) }
    void read(folder, [], quiet)
  }, [folder, refresh])

  function pick(next: FolderName): void {
    setFolder(next)
    try { localStorage.setItem(folderKey, next) } catch { /* the choice still holds for this visit */ }
  }

  const gone = (message: Message) => setMessages((shown) => shown.filter((item) => item.id !== message.id))
  const act = (work: Promise<void>, done: () => void) => { setError(undefined); void work.then(done).catch((failure: unknown) => setError(failed(failure))) }
  const on: Handlers = {
    compose: (message, mode) => actions.compose({ mode, message }),
    toInbox: (message) => act(actions.toInbox(message), () => { gone(message); setToast({ key: Date.now(), text: 'moved to inbox' }) }),
    remove: (message) => {
      const from = folder
      const at = messages.indexOf(message)
      act(actions.remove(message), () => {
        gone(message)
        setToast({ key: Date.now(), text: 'deleted', undo: () => {
          setToast(undefined)
          act(actions.putBack(message, from), () => setMessages((shown) => from !== lastRead.current || shown.some((item) => item.id === message.id) ? shown : [...shown.slice(0, at), message, ...shown.slice(at)]))
        } })
      })
    },
  }

  function open(message: Message): void {
    // A draft goes straight back into compose; everything else opens to read.
    if (drafts) actions.compose({ mode: 'draft', message })
    else setOpenId(pane || selected?.id !== message.id ? message.id : undefined)
  }

  return <div className="receipts folders">
    <div className="list">
      <Segmented label="folder" options={options} value={folder} onChange={pick} />
      {busy && <p className="status is-busy" aria-live="polite">{busy}</p>}
      {error && <p className="note is-error" role="alert">{error}</p>}

      {messages.length > 0 && <ul className="items">
        {messages.map((message) => {
          const isOpen = selected?.id === message.id
          return <li key={message.id} className={`item${isOpen ? ' is-open' : ''}`}>
            <div className="item-clip">
              <article className="mail">
                <div className="mail-row">
                  <button className="mail-open" type="button" aria-expanded={drafts ? undefined : isOpen} onClick={() => open(message)}>
                    <span className="mail-top">
                      <span className={`mail-from${message.isRead || listedByRecipient(folder) ? '' : ' is-unread'}`}>{rowName(message, folder)}</span>
                      <small>{dated(message.receivedAt)}</small>
                    </span>
                    <span className="mail-subject">{message.subject}</span>
                    {message.preview && <span className="mail-summary">{message.preview}</span>}
                  </button>
                </div>
                {!pane && !drafts && <Fold open={isOpen}><Detail message={message} folder={folder} pane={false} on={on} /></Fold>}
              </article>
            </div>
          </li>
        })}
      </ul>}
      {!busy && !messages.length && !error && <Empty>nothing in {folder}</Empty>}

      {more && <NearEnd busy={Boolean(busy)} failed={Boolean(error)} onNear={() => void read(folder, messages)} />}
    </div>

    {pane && <section className="reader" aria-label="message">
      {selected && <div className="reader-inner" key={selected.id}><Detail message={selected} folder={folder} pane on={on} /></div>}
    </section>}

    <Toast toast={toast} onDone={() => setToast(undefined)} />
  </div>
}
