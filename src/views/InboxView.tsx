import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { MessageActions } from '../App'
import { ruleActionLabel, senderDomain } from '../domain/rules'
import { snoozeOptions, type SnoozeOption } from '../domain/snooze'
import { inboxThreads, type InboxThread } from '../domain/threads'
import { categoryLabel, type RunSummary, type Triaged } from '../domain/triage'
import type { Message, RuleAction, Snooze } from '../domain/types'
import { Card, Field, Fold, Menu, Segmented, Sheet, Toast, useMediaQuery, usePresence, type ToastState } from '../ui'
import type { ConnectionStatus } from './SettingsView'
import { Conversation } from './Thread'

type SheetState =
  | { kind: 'snooze'; thread: InboxThread }
  | { kind: 'task'; thread: InboxThread; title: string }
  | { kind: 'rule'; message: Message }

/** Which way a row slides as it leaves, and how long it waits when a whole group goes at once. */
type Leave = { to: 'right' | 'left' | 'fade'; delay?: number }

/**
 * Everything a row or the open message can ask for. Each one animates, acts, and offers undo where it can.
 * A row is a conversation: what clears it clears every inbox message in it.
 */
type Handlers = {
  open: (item: InboxThread) => void
  archive: (item: InboxThread) => void
  /** Archive, and add a rule that archives the sender from now on. */
  block: (item: InboxThread) => void
  remove: (item: InboxThread) => void
  keep: (item: InboxThread) => void
  flag: (item: InboxThread) => void
  task: (item: InboxThread) => void
  reply: (item: InboxThread) => void
  replyAll: (item: InboxThread) => void
  forward: (item: InboxThread) => void
  snooze: (item: InboxThread) => void
  rule: (item: InboxThread) => void
  unsubscribe: (item: InboxThread) => void
  archiveOthers: (item: InboxThread) => void
  archiveSender: (item: InboxThread) => void
}

const swipeAt = 88
const keyOf = (item: InboxThread) => item.key
const sameSender = (a: InboxThread, b: InboxThread) => a.message.from.address.toLowerCase() === b.message.from.address.toLowerCase()

async function each(list: Message[], work: (message: Message) => Promise<void>): Promise<void> {
  for (const message of list) await work(message)
}

function when(receivedAt: string, long = false): string {
  const value = new Date(receivedAt)
  const today = new Date().toDateString() === value.toDateString()
  const time = value.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  if (today) return time
  const day = value.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toLowerCase()
  return long ? `${day}, ${time}` : day
}

const percent = (value: number) => `${Math.round(value * 100)}% sure`
const isLoud = (item: Triaged) => Boolean(item.triage?.needsReply || item.triage?.category === 'action')

/** The one action a closed row offers: what the verdict suggests, or archive. */
function quickAction(item: InboxThread, kept: boolean, on: Handlers): { label: string; run: () => void } {
  const suggested = item.triage?.suggested
  if (suggested === 'reply') return { label: 'reply', run: () => on.reply(item) }
  if (suggested === 'task') return { label: 'to do', run: () => on.task(item) }
  if (suggested === 'snooze') return { label: 'snooze', run: () => on.snooze(item) }
  if (suggested === 'delete') return { label: 'delete', run: () => on.remove(item) }
  if (suggested === 'keep' && !kept) return { label: 'keep', run: () => on.keep(item) }
  return { label: 'archive', run: () => on.archive(item) }
}

/** The full message and every action on it. Inline under the row on a phone, in the reading pane on a wide screen. */
function Detail({ item, kept, quiet, pane, on }: { item: InboxThread; kept: boolean; quiet: boolean; pane: boolean; on: Handlers }) {
  const { message, triage } = item
  const suggested = triage?.suggested
  const button = (label: string, action: string, run: () => void) =>
    <button key={label} type="button" className={suggested === action ? 'is-suggested' : ''} onClick={run}>{label}</button>
  const facts = [message.flagged && 'flagged', message.hasAttachments && 'attachment', triage && `${categoryLabel[triage.category]} · ${percent(triage.confidence)}`].filter(Boolean).join(' · ')

  return <div className="detail">
    <div className="mail-actions">
      {button('archive', 'archive', () => on.archive(item))}
      {/* Five buttons do not fit a phone, so mail that needs me keeps this one in the menu there. */}
      {(quiet || pane) && <button type="button" onClick={() => on.block(item)}>archive + rule</button>}
      {!quiet && button('to do', 'task', () => on.task(item))}
      {!quiet && button('reply', 'reply', () => on.reply(item))}
      {quiet ? button('keep', 'keep', () => on.keep(item)) : button('snooze', 'snooze', () => on.snooze(item))}
      <Menu label={`more for ${message.subject}`} items={[
        ...(quiet ? [
          { label: 'to do', onSelect: () => on.task(item) },
          { label: 'reply', onSelect: () => on.reply(item) },
          { label: 'snooze', onSelect: () => on.snooze(item) },
        ] : [{ label: kept ? 'kept' : 'keep in inbox', disabled: kept, onSelect: () => on.keep(item) }]),
        ...(quiet || pane ? [] : [{ label: 'archive + rule', onSelect: () => on.block(item) }]),
        { label: 'reply all', onSelect: () => on.replyAll(item) },
        { label: 'forward', onSelect: () => on.forward(item) },
        { label: message.flagged ? 'unflag' : 'flag', onSelect: () => on.flag(item) },
        { label: 'unsubscribe', onSelect: () => on.unsubscribe(item) },
        { label: 'always do this for the sender', onSelect: () => on.rule(item) },
        { label: 'archive everything else', onSelect: () => on.archiveOthers(item) },
        { label: 'archive all from sender', onSelect: () => on.archiveSender(item) },
        { label: 'delete', onSelect: () => on.remove(item) },
      ]} />
    </div>
    {pane && <h2 className="detail-subject">{message.subject}</h2>}
    {pane && triage?.summary && <p className="detail-summary">{triage.summary}</p>}
    <p className="detail-meta"><span>{pane && <b className="detail-from">{message.from.name}</b>}{`<${message.from.address}>`}</span><span>{when(message.receivedAt, true)}</span></p>
    {facts && <p className="detail-meta">{facts}</p>}
    <Conversation message={message} />
  </div>
}

function Row({ item, index, kept, quiet, open, pane, leave, on }: { item: InboxThread; index: number; kept: boolean; quiet: boolean; open: boolean; pane: boolean; leave?: Leave; on: Handlers }) {
  const { message, triage } = item
  const drag = useRef<{ x: number; y: number; active: boolean }>(undefined)
  const dragged = useRef(false)
  const loud = isLoud(item)
  const line = triage?.summary || message.preview
  const quick = quickAction(item, kept, on)
  // The colour of the summary already says a reply is owed; only the quieter verdicts are named.
  const kind = triage && !loud && (quiet || triage.confidence < 0.6) ? categoryLabel[triage.category] : undefined

  // A sideways drag with a finger: right archives, left snoozes. Up-and-down stays the page's scroll.
  function onPointerDown(event: ReactPointerEvent<HTMLElement>): void {
    if (event.pointerType !== 'touch') return
    drag.current = { x: event.clientX, y: event.clientY, active: false }
    dragged.current = false
  }
  function onPointerMove(event: ReactPointerEvent<HTMLElement>): void {
    const state = drag.current
    if (!state) return
    const dx = event.clientX - state.x
    const element = event.currentTarget
    if (!state.active) {
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(event.clientY - state.y)) return
      state.active = true
      dragged.current = true
      element.setPointerCapture(event.pointerId)
      element.style.transition = 'none'
    }
    element.style.translate = `${dx}px 0`
    const frame = element.parentElement!
    frame.dataset.swipe = dx > 0 ? 'right' : 'left'
    frame.classList.toggle('is-armed', Math.abs(dx) >= swipeAt)
  }
  function onPointerEnd(event: ReactPointerEvent<HTMLElement>): void {
    const state = drag.current
    drag.current = undefined
    if (!state?.active) return
    const element = event.currentTarget
    const frame = element.parentElement!
    element.style.transition = ''
    element.style.translate = ''
    delete frame.dataset.swipe
    frame.classList.remove('is-armed')
    if (event.type === 'pointercancel') return
    const dx = event.clientX - state.x
    if (dx >= swipeAt) on.archive(item)
    else if (dx <= -swipeAt) on.snooze(item)
  }

  return <li id={`mail-${item.key}`} className={`item${leave ? ' is-leaving' : ''}${open ? ' is-open' : ''}${kept ? ' is-kept' : ''}`} data-leave={leave?.to} style={{ '--i': Math.min(index, 12), '--d': leave?.delay ?? 0 } as CSSProperties}>
    <div className="item-clip">
      <div className="item-under" aria-hidden="true"><span>archive</span><span>snooze</span></div>
      <article className="mail" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
        onClickCapture={(event) => { if (dragged.current) { dragged.current = false; event.stopPropagation(); event.preventDefault() } }}>
        <div className="mail-row">
          <button className="mail-open" type="button" aria-expanded={open} onClick={() => on.open(item)}>
            <span className="mail-top">
              <span className={`mail-from${message.isRead ? '' : ' is-unread'}`} title={message.from.address}>{message.from.name}{item.all.length > 1 && <span className="mail-count">{item.all.length}</span>}</span>
              <small>{kind ? `${kind} · ` : ''}{when(message.receivedAt)}</small>
            </span>
            <span className="mail-subject">{message.subject}</span>
            {line && <span className="mail-summary">{line}</span>}
          </button>
          <button className={`quick${triage ? ' is-suggested' : ''}`} type="button" onClick={quick.run}>{quick.label}</button>
        </div>
        {!pane && <Fold open={open}><Detail item={item} kept={kept} quiet={quiet} pane={false} on={on} /></Fold>}
      </article>
    </div>
  </li>
}

export function InboxView({ items, kept, summary, busy, error, connection, archiveAfterReply, snoozes, actions, more, onMore, onConnect }: {
  items: Triaged[]
  kept: Record<string, string>
  summary?: RunSummary
  busy?: string
  error?: string
  connection: ConnectionStatus
  /** A sent reply archives its message, so the rest of the conversation goes with it. */
  archiveAfterReply?: boolean
  snoozes: Snooze[]
  actions: MessageActions
  more?: boolean
  onMore?: () => void
  onConnect: () => Promise<void>
}) {
  const [sheet, setSheet] = useState<SheetState>()
  const [localError, setLocalError] = useState<string>()
  const [openId, setOpenId] = useState<string>()
  const [leaving, setLeaving] = useState<Record<string, Leave>>({})
  const [toast, setToast] = useState<ToastState>()
  const pane = useMediaQuery('(min-width: 60rem)')
  // One row per conversation. A kept conversation comes back when something new arrives in it.
  const threads = inboxThreads(items)
  const live = threads.filter((item) => !kept[item.message.id])
  const keptItems = threads.filter((item) => kept[item.message.id])
  const groups = { needsMe: live.filter((item) => item.needsMe), probablyFine: live.filter((item) => !item.needsMe) }
  const needsRows = usePresence(groups.needsMe, keyOf)
  const fineRows = usePresence(groups.probablyFine, keyOf)
  const keptRows = usePresence(keptItems, keyOf)
  const shownError = error ?? localError
  const moreRef = useRef<HTMLButtonElement>(null)
  const onMoreRef = useRef(onMore)
  onMoreRef.current = onMore
  const follow = useRef(false)

  // Rows still in play, top to bottom. The reading pane always shows one of them when there is one.
  const order = [...groups.needsMe, ...groups.probablyFine].filter((item) => !leaving[item.key])
  const selected = threads.find((item) => item.key === openId && !leaving[item.key]) ?? (pane ? order[0] : undefined)
  const selectedId = selected?.key
  const isQuiet = (item: InboxThread) => !item.needsMe

  // Older mail loads as the end of the list scrolls into view. A failed load waits for a tap instead of retrying.
  useEffect(() => {
    const target = moreRef.current
    if (!target || busy || error || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) onMoreRef.current?.() }, { rootMargin: '600px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [more, busy, error, items.length])

  useEffect(() => {
    if (!follow.current || !selectedId) return
    follow.current = false
    document.getElementById(`mail-${selectedId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  const say = (text: string, undo?: () => void) => setToast({ key: Date.now(), text, undo })
  const stay = (ids: string[]) => setLeaving((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id))))

  /** The row leaves at once; the mailbox catches up behind it, one message of the conversation at a time. A failure brings the row back with what is left. */
  function clear(item: InboxThread, to: Leave['to'], work: (message: Message) => Promise<void>, done?: string, undoable = false): void {
    setLocalError(undefined)
    if (selectedId === item.key) {
      const at = order.findIndex((entry) => entry.key === item.key)
      setOpenId(pane ? (order[at + 1] ?? order[at - 1])?.key : undefined)
    }
    setLeaving((current) => ({ ...current, [item.key]: { to } }))
    void each(item.all, work)
      .then(() => { if (done) say(done, undoable ? () => { setToast(undefined); void each(item.all, actions.restore).catch(() => undefined) } : undefined) })
      .catch(() => undefined)
      .finally(() => stay([item.key]))
  }

  /**
   * Blocks a sender: every conversation of theirs on the list is archived and a rule archives what they send next.
   * Undo brings the mail back and takes the rule away. If the mail will not move, the rule does not stay either.
   */
  function block(item: InboxThread): void {
    const from = item.message.from.address.toLowerCase()
    const gone = [item, ...order.filter((other) => other.key !== item.key && other.message.from.address.toLowerCase() === from)]
    const keys = gone.map(keyOf)
    const all = gone.flatMap((thread) => thread.all)
    setLocalError(undefined)
    if (selectedId && keys.includes(selectedId)) {
      const at = order.findIndex((entry) => entry.key === selectedId)
      const staying = (entry: InboxThread) => !keys.includes(entry.key)
      setOpenId(pane ? (order.slice(at).find(staying) ?? order.slice(0, Math.max(at, 0)).reverse().find(staying))?.key : undefined)
    }
    setLeaving((current) => ({ ...current, ...Object.fromEntries(keys.map((key, index) => [key, { to: 'right', delay: Math.min(index, 8) } as Leave])) }))
    let unrule: (() => Promise<void>) | undefined
    void actions.block(item.message)
      .then((undo) => { unrule = undo; return each(all, actions.archive) })
      .then(() => say(unrule ? 'archived · rule added' : 'archived', () => {
        setToast(undefined)
        void (unrule?.() ?? Promise.resolve()).then(() => each(all, actions.restore)).catch(() => undefined)
      }))
      .catch(() => { void unrule?.().catch(() => undefined) })
      .finally(() => stay(keys))
  }

  /** The newest message was handled on its own; the older ones in the conversation are archived behind it. */
  function clearRest(item: InboxThread): void {
    const rest = item.all.slice(1)
    if (!rest.length) return
    setLeaving((current) => ({ ...current, [item.key]: { to: 'right' } }))
    void each(rest, actions.archive).catch(() => undefined).finally(() => stay([item.key]))
  }

  /** Many rows leave in one go. Kept mail is never in the list handed over. Undo brings back whatever did move. */
  function sweep(list: InboxThread[]): void {
    if (!list.length) return
    setLocalError(undefined)
    const keys = new Set(list.map(keyOf))
    if (selectedId && keys.has(selectedId)) setOpenId(pane ? order.find((entry) => !keys.has(entry.key))?.key : undefined)
    setLeaving((current) => ({ ...current, ...Object.fromEntries(list.map((item, index) => [item.key, { to: 'right', delay: Math.min(index, 14) } satisfies Leave])) }))
    const messages = list.flatMap((item) => item.all)
    void actions.archiveAll(messages)
      .then((moved) => {
        const gone = new Set(moved.map((message) => message.id))
        const count = list.filter((item) => item.all.every((message) => gone.has(message.id))).length
        if (count) say(`archived ${count}`, () => { setToast(undefined); void each(moved, actions.restore).catch(() => undefined) })
      })
      .catch(() => undefined)
      .finally(() => stay([...keys]))
  }

  /** A sent reply archives the message it answers when the setting says so; the rest of the conversation goes with it. */
  function answer(item: InboxThread, mode: 'reply' | 'replyAll'): void {
    actions.compose({ mode, message: item.message, text: item.triage?.draft ?? '', onCard: true, onSent: () => { if (archiveAfterReply) clearRest(item) } })
  }

  const on: Handlers = {
    open: (item) => setOpenId(pane || selectedId !== item.key ? item.key : undefined),
    archive: (item) => clear(item, 'right', actions.archive, actions.isReceipt(item.message) ? 'moved to receipts' : 'archived', true),
    block,
    remove: (item) => clear(item, 'fade', actions.remove, 'deleted', true),
    keep: (item) => clear(item, 'fade', actions.keep),
    flag: (item) => void actions.flag(item.message).catch(() => undefined),
    task: (item) => setSheet({ kind: 'task', thread: item, title: item.triage?.task ?? item.message.subject }),
    reply: (item) => answer(item, 'reply'),
    replyAll: (item) => answer(item, 'replyAll'),
    forward: (item) => actions.compose({ mode: 'forward', message: item.message }),
    snooze: (item) => setSheet({ kind: 'snooze', thread: item }),
    rule: (item) => setSheet({ kind: 'rule', message: item.message }),
    unsubscribe: (item) => void actions.unsubscribe(item.message).then((text) => say(text)).catch(() => undefined),
    archiveOthers: (item) => sweep(order.filter((entry) => entry.key !== item.key)),
    archiveSender: (item) => sweep(order.filter((entry) => sameSender(entry, item))),
  }

  // Keys on the open message: j and k move, e archive, r reply, a reply all, f forward, t to do, s snooze, # delete, u undo.
  const onKey = useRef<(event: KeyboardEvent) => void>(undefined)
  onKey.current = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || sheet) return
    if ((event.target as HTMLElement).closest?.('input, textarea, select, dialog, details[open]')) return
    if (event.key === 'u') { toast?.undo?.(); return }
    if (event.key === 'j' || event.key === 'k') {
      const at = selected ? order.findIndex((entry) => entry.key === selected.key) : -1
      const next = order[Math.max(0, Math.min(order.length - 1, at + (event.key === 'j' ? 1 : -1)))]
      if (next) { follow.current = true; setOpenId(next.key) }
      return
    }
    if (event.key === 'Escape' && !pane) { setOpenId(undefined); return }
    if (!selected) return
    const act = ({ e: on.archive, r: on.reply, a: on.replyAll, f: on.forward, t: on.task, s: on.snooze, '#': on.remove } as Record<string, ((item: InboxThread) => void) | undefined>)[event.key]
    if (!act) return
    event.preventDefault()
    act(selected)
  }
  useEffect(() => {
    const listen = (event: KeyboardEvent) => onKey.current?.(event)
    window.addEventListener('keydown', listen)
    return () => window.removeEventListener('keydown', listen)
  }, [])

  if (connection !== 'connected') {
    return <div className="lone"><Card title="microsoft account">
      <div className="actions"><button className="primary" type="button" disabled={connection === 'unconfigured' || Boolean(busy)} onClick={() => void onConnect()}>{connection === 'unconfigured' ? 'no microsoft app id' : busy ? 'connecting' : 'connect microsoft'}</button></div>
      {shownError && <p className="note is-error" role="alert">{shownError}</p>}
    </Card></div>
  }

  const rows = (entries: { key: string; item: InboxThread; leaving: boolean }[], quiet: boolean, isKept = false) => <ul className="items">
    {entries.map((entry, index) => <Row key={entry.key} item={entry.item} index={index} kept={isKept} quiet={quiet} open={selectedId === entry.key} pane={pane} leave={leaving[entry.key] ?? (entry.leaving ? { to: 'fade' } : undefined)} on={on} />)}
  </ul>

  return <div className="inbox">
    <div className="list">
      <div className="list-head">
        <p className={`status${busy ? ' is-busy' : ''}`} aria-live="polite">{busy ?? ''}</p>
        {order.length > 1 && <button className="link" type="button" onClick={() => sweep(order)}>archive all</button>}
      </div>
      {shownError && <p className="note is-error" role="alert">{shownError}</p>}

      {(needsRows.length > 0 || fineRows.length > 0) && <div className="lanes">
        {needsRows.length > 0 && <section className="lane">
          {groups.needsMe.length > 0 && <h2 className="group-title">needs me <span className="group-count">{groups.needsMe.length}</span></h2>}
          {rows(needsRows, false)}
        </section>}
        {fineRows.length > 0 && <section className="lane">
          {rows(fineRows, true)}
        </section>}
      </div>}

      {more && <div className="actions"><button ref={moreRef} className="secondary" type="button" disabled={Boolean(busy)} onClick={onMore}>load more</button></div>}

      {!busy && items.length === 0 && !more && summary && <p className="zero">inbox zero{snoozes.length ? ` · ${snoozes.length} snoozed` : ''}</p>}

      {keptItems.length > 0 && <details className="card group">
        <summary>{keptItems.length} kept in inbox</summary>
        {rows(keptRows, false, true)}
      </details>}
    </div>

    {pane && <section className="reader" aria-label="message">
      {selected && <div className="reader-inner" key={selected.key}><Detail item={selected} kept={Boolean(kept[selected.message.id])} quiet={isQuiet(selected)} pane on={on} /></div>}
    </section>}

    <Toast toast={toast} onDone={() => setToast(undefined)} />

    {sheet?.kind === 'snooze' && <Sheet title="snooze until" onClose={() => setSheet(undefined)}>
      <div className="options">{snoozeOptions.map((option) => <button key={option} type="button" onClick={() => { setSheet(undefined); clear(sheet.thread, 'left', (message) => actions.snooze(message, option as SnoozeOption), `snoozed until ${option}`, true) }}>{option}</button>)}</div>
    </Sheet>}
    {sheet?.kind === 'task' && <TaskSheet title={sheet.title} onClose={() => setSheet(undefined)} onSave={(title) => actions.task(sheet.thread.message, title).then(() => { setSheet(undefined); say('added to to do'); clearRest(sheet.thread) }).catch(() => undefined)} />}
    {sheet?.kind === 'rule' && <RuleSheet message={sheet.message} onClose={() => setSheet(undefined)} onSave={(input) => actions.makeRule(input).then(() => { setSheet(undefined); say('rule saved') }).catch(() => undefined)} />}
  </div>
}

function TaskSheet({ title, onClose, onSave }: { title: string; onClose: () => void; onSave: (title: string) => Promise<void> }) {
  const [value, setValue] = useState(title)
  const [saving, setSaving] = useState(false)
  return <Sheet title="to do" onClose={onClose}>
    <form className="stack" onSubmit={(event) => { event.preventDefault(); setSaving(true); void onSave(value).finally(() => setSaving(false)) }}>
      <Field label="task"><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} /></Field>
      <div className="actions"><button className="primary" type="submit" disabled={!value.trim() || saving}>{saving ? 'adding' : 'add and archive'}</button><button className="plain" type="button" onClick={onClose}>cancel</button></div>
    </form>
  </Sheet>
}

const ruleActionOptions = (Object.keys(ruleActionLabel) as RuleAction[]).map((value) => ({ value, label: ruleActionLabel[value] }))

function RuleSheet({ message, onClose, onSave }: { message: Message; onClose: () => void; onSave: (input: { from?: string; subject?: string; action: RuleAction }) => Promise<void> }) {
  const [from, setFrom] = useState(message.from.address)
  const [subject, setSubject] = useState('')
  const [action, setAction] = useState<RuleAction>('archive')
  const [saving, setSaving] = useState(false)
  const domain = senderDomain(message.from.address)
  return <Sheet title="always" onClose={onClose}>
    <form className="stack" onSubmit={(event) => { event.preventDefault(); setSaving(true); void onSave({ from, subject, action }).finally(() => setSaving(false)) }}>
      <Segmented label="what to do" options={ruleActionOptions} value={action} onChange={setAction} />
      <Field label="from"><input value={from} onChange={(event) => setFrom(event.target.value)} /></Field>
      {from !== domain && <button className="link" type="button" onClick={() => setFrom(domain)}>anyone {domain}</button>}
      <Field label="subject has"><input value={subject} onChange={(event) => setSubject(event.target.value)} /></Field>
      <div className="actions"><button className="primary" type="submit" disabled={saving || (!from.trim() && !subject.trim())}>{saving ? 'saving' : 'save rule'}</button><button className="plain" type="button" onClick={onClose}>cancel</button></div>
    </form>
  </Sheet>
}
