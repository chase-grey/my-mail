import { useEffect, useRef, useState } from 'react'
import type { Message } from '../domain/types'
import { Empty, Fold, useMediaQuery } from '../ui'
import { NearEnd } from './NearEnd'
import { Conversation } from './Thread'

export type ReceiptActions = {
  /** The newest receipts, or the next page received at or before `before`. */
  load: (before?: string) => Promise<{ messages: Message[]; more: boolean }>
  /** Moves archived mail tagged as a receipt into the folder. Returns how many it found. */
  fromArchive: (onProgress?: (done: number) => void) => Promise<number>
  toInbox: (message: Message) => Promise<void>
  forward: (message: Message) => void
}

/** Receipts reach back years, so anything from another year says which. */
function dated(receivedAt: string, long = false): string {
  const value = new Date(receivedAt)
  const sameYear = new Date().getFullYear() === value.getFullYear()
  const day = value.toLocaleDateString(undefined, sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase()
  return long ? `${day}, ${value.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase()}` : day
}

/** The receipt itself. Inline under the row on a phone, in the reading pane on a wide screen. */
function Detail({ message, pane, onInbox, onForward }: { message: Message; pane: boolean; onInbox: (message: Message) => void; onForward: (message: Message) => void }) {
  return <div className="detail">
    <div className="mail-actions">
      <button type="button" onClick={() => onForward(message)}>forward</button>
      <button type="button" onClick={() => onInbox(message)}>move to inbox</button>
    </div>
    {pane && <h2 className="detail-subject">{message.subject}</h2>}
    {pane && <p className="detail-meta"><span><b className="detail-from">{message.from.name}</b>{`<${message.from.address}>`}</span><span>{dated(message.receivedAt, true)}</span></p>}
    <Conversation message={message} />
  </div>
}

const failed = (error: unknown) => error instanceof Error ? error.message.toLowerCase() : 'something failed'

export function ReceiptsView({ actions }: { actions: ReceiptActions }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState<string | undefined>('loading')
  const [note, setNote] = useState<string>()
  const [error, setError] = useState<string>()
  const [openId, setOpenId] = useState<string>()
  const pane = useMediaQuery('(min-width: 60rem)')
  const selected = messages.find((message) => message.id === openId) ?? (pane ? messages[0] : undefined)
  const current = useRef(actions)
  current.current = actions

  async function read(shown: Message[]): Promise<void> {
    setBusy(shown.length ? 'loading more' : 'loading')
    setError(undefined)
    try {
      const oldest = shown.reduce<string | undefined>((least, message) => !least || message.receivedAt < least ? message.receivedAt : least, undefined)
      const page = await current.current.load(oldest)
      const have = new Set(shown.map((message) => message.id))
      const fresh = page.messages.filter((message) => !have.has(message.id))
      setMessages([...shown, ...fresh])
      // A page of nothing new means the date window did not move; stop instead of asking again.
      setMore(page.more && fresh.length > 0)
    } catch (failure) {
      setError(failed(failure))
    } finally {
      setBusy(undefined)
    }
  }

  useEffect(() => { void read([]) }, [])

  async function fromArchive(): Promise<void> {
    setBusy('looking in archive')
    setError(undefined)
    setNote(undefined)
    try {
      const count = await actions.fromArchive((done) => setBusy(`moved ${done}`))
      setNote(count ? `moved ${count} from archive` : 'none tagged in archive')
      if (count) await read([])
    } catch (failure) {
      setError(failed(failure))
    } finally {
      setBusy(undefined)
    }
  }

  function toInbox(message: Message): void {
    setError(undefined)
    void actions.toInbox(message)
      .then(() => setMessages((shown) => shown.filter((item) => item.id !== message.id)))
      .catch((failure: unknown) => setError(failed(failure)))
  }

  return <div className="receipts">
    <div className="list">
      <p className={`status${busy ? ' is-busy' : ''}`} aria-live="polite">{busy ?? note ?? ''}</p>
      {error && <p className="note is-error" role="alert">{error}</p>}

      {messages.length > 0 && <ul className="items">
        {messages.map((message) => {
          const open = selected?.id === message.id
          return <li key={message.id} className={`item${open ? ' is-open' : ''}`}>
            <div className="item-clip">
              <article className="mail">
                <div className="mail-row">
                  <button className="mail-open" type="button" aria-expanded={open} onClick={() => setOpenId(pane || !open ? message.id : undefined)}>
                    <span className="mail-top">
                      <span className="mail-from" title={message.from.address}>{message.from.name}</span>
                      <small>{dated(message.receivedAt)}</small>
                    </span>
                    <span className="mail-subject">{message.subject}</span>
                    {message.preview && <span className="mail-summary">{message.preview}</span>}
                  </button>
                </div>
                {!pane && <Fold open={open}><Detail message={message} pane={false} onInbox={toInbox} onForward={actions.forward} /></Fold>}
              </article>
            </div>
          </li>
        })}
      </ul>}
      {!busy && !messages.length && !error && <Empty>no receipts</Empty>}

      {more && <NearEnd busy={Boolean(busy)} failed={Boolean(error)} onNear={() => void read(messages)} />}
      <div className="actions">
        <button className="link" type="button" disabled={Boolean(busy)} onClick={() => void fromArchive()}>move receipts from archive</button>
      </div>
    </div>

    {pane && <section className="reader" aria-label="message">
      {selected && <div className="reader-inner" key={selected.id}><Detail message={selected} pane onInbox={toInbox} onForward={actions.forward} /></div>}
    </section>}
  </div>
}
