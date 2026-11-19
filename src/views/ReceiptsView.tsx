import { useEffect, useRef, useState } from 'react'
import type { Message } from '../domain/types'
import { Empty, Fold } from '../ui'

export type ReceiptActions = {
  /** The newest receipts, or the next page received at or before `before`. */
  load: (before?: string) => Promise<{ messages: Message[]; more: boolean }>
  /** Moves archived mail tagged as a receipt into the folder. Returns how many it found. */
  fromArchive: (onProgress?: (done: number) => void) => Promise<number>
  toInbox: (message: Message) => Promise<void>
}

/** Receipts reach back years, so anything from another year says which. */
function dated(receivedAt: string): string {
  const value = new Date(receivedAt)
  const sameYear = new Date().getFullYear() === value.getFullYear()
  return value.toLocaleDateString(undefined, sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase()
}

const failed = (error: unknown) => error instanceof Error ? error.message.toLowerCase() : 'something failed'

export function ReceiptsView({ actions }: { actions: ReceiptActions }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState<string | undefined>('loading')
  const [note, setNote] = useState<string>()
  const [error, setError] = useState<string>()
  const [openId, setOpenId] = useState<string>()
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

  return <>
    <p className={`status${busy ? ' is-busy' : ''}`} aria-live="polite">{busy ?? note ?? ''}</p>
    {error && <p className="note is-error" role="alert">{error}</p>}

    {messages.length > 0 && <ul className="items">
      {messages.map((message) => {
        const open = openId === message.id
        return <li key={message.id} className={`item${open ? ' is-open' : ''}`}>
          <div className="item-clip">
            <article className="mail">
              <div className="mail-row">
                <button className="mail-open" type="button" aria-expanded={open} onClick={() => setOpenId(open ? undefined : message.id)}>
                  <span className="mail-top">
                    <span className="mail-from" title={message.from.address}>{message.from.name}</span>
                    <small>{dated(message.receivedAt)}</small>
                  </span>
                  <span className="mail-subject">{message.subject}</span>
                  {message.preview && <span className="mail-summary">{message.preview}</span>}
                </button>
              </div>
              <Fold open={open}>
                <div className="detail">
                  <div className="mail-actions">
                    <button type="button" onClick={() => window.open(message.webLink, '_blank', 'noreferrer')}>open in outlook</button>
                    <button type="button" onClick={() => toInbox(message)}>move to inbox</button>
                  </div>
                  <div className="mail-body">{message.body || message.preview || '(empty)'}</div>
                </div>
              </Fold>
            </article>
          </div>
        </li>
      })}
    </ul>}
    {!busy && !messages.length && !error && <Empty>no receipts</Empty>}

    <div className="actions">
      {more && <button className="secondary" type="button" disabled={Boolean(busy)} onClick={() => void read(messages)}>load more</button>}
      <button className="link" type="button" disabled={Boolean(busy)} onClick={() => void fromArchive()}>move receipts from archive</button>
    </div>
  </>
}
