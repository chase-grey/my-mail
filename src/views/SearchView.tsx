import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import type { MessageActions } from '../App'
import { answerParts, fromSender, rememberSearch, searchMode, senderWord, suggestSenders, type SearchHit, type SearchMode, type SearchPage, type Sender } from '../domain/search'
import type { Message } from '../domain/types'
import { Card, Field, Fold, Menu, Segmented, Toast, useMediaQuery, type ToastState } from '../ui'
import { MailBody } from './MailBody'
import './search.css'

export type SearchActions = {
  find: (query: string, count?: number) => Promise<SearchPage>
  more: (next: string) => Promise<SearchPage>
  /** A sentence in, a mailbox search out. */
  translate: (question: string) => Promise<string>
  /** Reads the messages found and answers, citing them by number as `[2]`. */
  answer: (question: string, hits: SearchHit[]) => Promise<string>
  /** Who in the whole mailbox matches the word being typed. */
  senders?: (word: string) => Promise<Sender[]>
}

/** What is on screen: what a find matched, or what an ask searched for, read, and said. */
type Result = { hits: SearchHit[]; next?: string; question?: string; answer?: string }

const recentKey = 'my-mail.searches.v1'
const askCount = 10
const modeOptions: { value: SearchMode; label: string }[] = [{ value: 'find', label: 'find' }, { value: 'ask', label: 'ask' }]

function loadRecent(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(recentKey) ?? '[]')
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** Search reaches back years, so anything from another year says which. */
function dated(receivedAt: string, long = false): string {
  const value = new Date(receivedAt)
  const now = new Date()
  const time = value.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  if (now.toDateString() === value.toDateString()) return time
  const sameYear = now.getFullYear() === value.getFullYear()
  const day = value.toLocaleDateString(undefined, sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase()
  return long ? `${day}, ${time}` : day
}

const noSenders: Sender[] = []
const failed = (error: unknown) => error instanceof Error ? error.message.toLowerCase() : 'search failed'

type Handlers = {
  open: (hit: SearchHit) => void
  archive: (hit: SearchHit) => void
  task: (hit: SearchHit) => void
  flag: (hit: SearchHit) => void
  toInbox: (hit: SearchHit) => void
  remove: (hit: SearchHit) => void
}

function Detail({ hit, pane, on }: { hit: SearchHit; pane: boolean; on: Handlers }) {
  const { message } = hit
  const facts = [hit.folder, message.flagged && 'flagged', message.hasAttachments && 'attachment'].filter(Boolean).join(' · ')
  return <div className="detail">
    <div className="mail-actions">
      {hit.inInbox && <button type="button" onClick={() => on.archive(hit)}>archive</button>}
      <button type="button" onClick={() => on.task(hit)}>to do</button>
      <Menu label={`more for ${message.subject}`} items={[
        { label: message.flagged ? 'unflag' : 'flag', onSelect: () => on.flag(hit) },
        ...(hit.inInbox ? [] : [{ label: 'move to inbox', onSelect: () => on.toInbox(hit) }]),
        { label: 'delete', danger: true, onSelect: () => on.remove(hit) },
      ]} />
    </div>
    {pane && <h2 className="detail-subject">{message.subject}</h2>}
    <p className="detail-meta"><span>{pane && <b className="detail-from">{message.from.name}</b>}{`<${message.from.address}>`}</span><span>{dated(message.receivedAt, true)}</span></p>
    {facts && <p className="detail-meta">{facts}</p>}
    <MailBody message={message} />
  </div>
}

function Row({ hit, index, open, pane, on }: { hit: SearchHit; index: number; open: boolean; pane: boolean; on: Handlers }) {
  const { message } = hit
  return <li id={`hit-${message.id}`} className={`item${open ? ' is-open' : ''}`} style={{ '--i': Math.min(index, 12) } as CSSProperties}>
    <div className="item-clip">
      <article className="mail">
        <div className="mail-row">
          <button className="mail-open" type="button" aria-expanded={open} onClick={() => on.open(hit)}>
            <span className="mail-top">
              <span className={`mail-from${message.isRead ? '' : ' is-unread'}`} title={message.from.address}>{message.from.name}</span>
              <small>{hit.folder ? `${hit.folder} · ` : ''}{dated(message.receivedAt)}</small>
            </span>
            <span className="mail-subject">{message.subject}</span>
            {message.preview && <span className="mail-summary">{message.preview}</span>}
          </button>
        </div>
        {!pane && <Fold open={open}><Detail hit={hit} pane={false} on={on} /></Fold>}
      </article>
    </div>
  </li>
}

export function SearchView({ search, actions, hasModel, senders = noSenders }: { search: SearchActions; actions: MessageActions; hasModel: boolean; senders?: Sender[] }) {
  const [text, setText] = useState('')
  const [override, setOverride] = useState<SearchMode>()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<Result>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [openId, setOpenId] = useState<string>()
  const [toast, setToast] = useState<ToastState>()
  const [recent, setRecent] = useState(loadRecent)
  const pane = useMediaQuery('(min-width: 60rem)')
  const runId = useRef(0)
  const follow = useRef(false)
  const mode: SearchMode = hasModel ? override ?? searchMode(text) : 'find'
  const hits = result?.hits ?? []
  const selected = hits.find((hit) => hit.message.id === openId) ?? (pane ? hits[0] : undefined)
  const selectedId = selected?.message.id
  const [looked, setLooked] = useState<{ word: string; senders: Sender[] }>()
  const word = mode === 'find' ? senderWord(text) : ''
  const lookUp = search.senders
  const suggested = word ? suggestSenders(text, [...senders, ...hits.map((hit) => hit.message.from), ...(looked && word.startsWith(looked.word) ? looked.senders : [])]) : []

  // The loaded mail answers at once. The mailbox is asked when typing pauses, and only adds to what is shown.
  useEffect(() => {
    if (!word || !lookUp) return
    let current = true
    const timer = setTimeout(() => void lookUp(word).then((found) => { if (current) setLooked({ word, senders: found }) }).catch(() => {}), 300)
    return () => { current = false; clearTimeout(timer) }
  }, [word, lookUp])

  useEffect(() => {
    if (!follow.current || !selectedId) return
    follow.current = false
    document.getElementById(`hit-${selectedId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  function remember(value: string): void {
    const next = rememberSearch(recent, value)
    setRecent(next)
    try { localStorage.setItem(recentKey, JSON.stringify(next)) } catch { /* the list still works for this visit */ }
  }

  /** A find runs the words as they are. An ask writes the search unless one is given, runs it, and reads what came back. */
  async function run(value: string, as: SearchMode, written?: string): Promise<void> {
    const asked = value.trim()
    if (!asked) return
    const id = ++runId.current
    const current = () => id === runId.current
    setError(undefined)
    setOpenId(undefined)
    remember(asked)
    try {
      if (as === 'find') {
        setBusy('searching')
        const page = await search.find(asked)
        if (current()) setResult(page)
        return
      }
      let kql = written?.trim()
      if (!kql) {
        setBusy('writing the search')
        kql = await search.translate(asked)
        if (!current()) return
      }
      setQuery(kql)
      setBusy('searching')
      const page = await search.find(kql, askCount)
      if (!current()) return
      setResult({ hits: page.hits, question: asked })
      if (!page.hits.length) return
      setBusy(`reading ${page.hits.length} ${page.hits.length === 1 ? 'message' : 'messages'}`)
      const answer = await search.answer(asked, page.hits)
      if (current()) setResult((shown) => shown && { ...shown, answer })
    } catch (failure) {
      if (current()) setError(failed(failure))
    } finally {
      if (current()) setBusy(undefined)
    }
  }

  async function loadMore(): Promise<void> {
    if (!result?.next) return
    const id = runId.current
    setBusy('loading more')
    setError(undefined)
    try {
      const page = await search.more(result.next)
      if (id !== runId.current) return
      setResult((shown) => {
        if (!shown) return shown
        const have = new Set(shown.hits.map((hit) => hit.message.id))
        return { ...shown, hits: [...shown.hits, ...page.hits.filter((hit) => !have.has(hit.message.id))], next: page.next }
      })
    } catch (failure) {
      if (id === runId.current) setError(failed(failure))
    } finally {
      if (id === runId.current) setBusy(undefined)
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault()
    void run(text, mode)
  }

  const say = (shown: string, undo?: () => void) => setToast({ key: Date.now(), text: shown, undo })
  const patch = (id: string, change: (hit: SearchHit) => SearchHit | undefined) =>
    setResult((shown) => shown && { ...shown, hits: shown.hits.flatMap((hit) => hit.message.id === id ? change(hit) ?? [] : hit) })
  const inInbox = (message: Message) => patch(message.id, (hit) => ({ ...hit, inInbox: true, folder: undefined }))
  const putBack = (hit: SearchHit, at: number) => () => {
    setToast(undefined)
    void actions.restore(hit.message).then(() => setResult((shown) => {
      if (!shown) return shown
      const back = { ...hit, inInbox: true, folder: undefined }
      if (shown.hits.some((item) => item.message.id === hit.message.id)) return { ...shown, hits: shown.hits.map((item) => item.message.id === hit.message.id ? back : item) }
      return { ...shown, hits: [...shown.hits.slice(0, at), back, ...shown.hits.slice(at)] }
    })).catch((failure: unknown) => setError(failed(failure)))
  }
  const act = (work: Promise<void>, done: () => void) => { setError(undefined); void work.then(done).catch((failure: unknown) => setError(failed(failure))) }

  const on: Handlers = {
    open: (hit) => setOpenId(pane || selectedId !== hit.message.id ? hit.message.id : undefined),
    archive: (hit) => act(actions.archive(hit.message), () => {
      patch(hit.message.id, (item) => ({ ...item, inInbox: false, folder: 'archive' }))
      say('archived', putBack(hit, hits.indexOf(hit)))
    }),
    task: (hit) => act(actions.task(hit.message, hit.message.subject), () => {
      patch(hit.message.id, (item) => ({ ...item, inInbox: false, folder: 'archive' }))
      say('added to to do')
    }),
    flag: (hit) => act(actions.flag(hit.message), () => patch(hit.message.id, (item) => ({ ...item, message: { ...item.message, flagged: !item.message.flagged } }))),
    toInbox: (hit) => act(actions.restore(hit.message), () => { inInbox(hit.message); say('moved to inbox') }),
    remove: (hit) => act(actions.remove(hit.message), () => {
      patch(hit.message.id, () => undefined)
      say('deleted', putBack(hit, hits.indexOf(hit)))
    }),
  }

  const cite = (n: number) => { follow.current = true; setOpenId(hits[n - 1]?.message.id) }
  const status = busy ?? (result ? hits.length ? `${hits.length} found` : 'nothing found' : '')

  return <div className="search">
    <div className="list">
      <form className="search-form" role="search" onSubmit={submit}>
        <input type="search" aria-label="search" placeholder={hasModel ? 'search or ask' : 'search'} autoFocus enterKeyHint="search" value={text} onChange={(event) => { setText(event.target.value); if (!event.target.value.trim()) setOverride(undefined) }} />
        {hasModel && <Segmented label="how to search" options={modeOptions} value={mode} onChange={setOverride} />}
      </form>
      {suggested.length > 0 && <div className="suggest">
        {suggested.map((sender) => <button key={sender.address.toLowerCase()} type="button" title={sender.name} onClick={() => { const next = fromSender(text, sender.address); setText(next); setOverride(undefined); void run(next, 'find') }}>{sender.address}</button>)}
      </div>}
      <p className={`status${busy ? ' is-busy' : ''}`} aria-live="polite">{status}</p>
      {error && <p className="note is-error" role="alert">{error}</p>}

      {!text.trim() && !busy && recent.length > 0 && <Card title="recent">
        <ul className="rows">{recent.map((item) => <li className="row" key={item}>
          <button className="row-main" type="button" onClick={() => { setText(item); void run(item, hasModel ? searchMode(item) : 'find') }}>{item}</button>
        </li>)}</ul>
      </Card>}

      {result?.question && <form onSubmit={(event) => { event.preventDefault(); void run(result.question!, 'ask', query) }}>
        <Field label="searched for"><input value={query} enterKeyHint="search" onChange={(event) => setQuery(event.target.value)} /></Field>
      </form>}
      {result?.answer && <section className="card"><p className="answer">
        {answerParts(result.answer, hits.length).map((part, index) => typeof part === 'string'
          ? <span key={index}>{part}</span>
          : <button key={index} className="cite" type="button" title={hits[part - 1].message.subject} onClick={() => cite(part)}>{part}</button>)}
      </p></section>}

      {hits.length > 0 && <ul className="items">
        {hits.map((hit, index) => <Row key={hit.message.id} hit={hit} index={index} open={selectedId === hit.message.id} pane={pane} on={on} />)}
      </ul>}
      {result?.next && <div className="actions"><button className="secondary" type="button" disabled={Boolean(busy)} onClick={() => void loadMore()}>load more</button></div>}
    </div>

    {pane && <section className="reader" aria-label="message">
      {selected && <div className="reader-inner" key={selected.message.id}><Detail hit={selected} pane on={on} /></div>}
    </section>}

    <Toast toast={toast} onDone={() => setToast(undefined)} />
  </div>
}
