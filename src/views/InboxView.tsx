import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { MessageActions } from '../App'
import { ruleActionLabel, senderDomain } from '../domain/rules'
import { snoozeOptions, type SnoozeOption } from '../domain/snooze'
import { inboxThreads, type InboxThread } from '../domain/threads'
import { categoryLabel, type RunSummary, type Triaged } from '../domain/triage'
import type { Message, RuleAction, Snooze } from '../domain/types'
import { Card, Field, Fold, Icon, Menu, Segmented, Sheet, Toast, useMediaQuery, usePresence, type MenuItem, type ToastState } from '../ui'
import type { ConnectionStatus } from './SettingsView'
import { Conversation } from './Thread'

type SheetState =
  | { kind: 'snooze'; threads: InboxThread[] }
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
  /** Ticks or unticks a row on a wide screen. With shift held, every row from the last ticked one to this one. */
  pick: (item: InboxThread, range?: boolean) => void
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
const oneByOne = (work: (message: Message) => Promise<void>) => (list: Message[]) => each(list, work)

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

/** What `more` holds for one conversation. The same list on a phone row and in the bar on a wide screen. */
function moreItems(item: InboxThread, kept: boolean, on: Handlers): MenuItem[] {
  return [
    { label: kept ? 'kept' : 'keep in inbox', disabled: kept, onSelect: () => on.keep(item) },
    { label: 'reply all', onSelect: () => on.replyAll(item) },
    { label: 'forward', onSelect: () => on.forward(item) },
    { label: item.message.flagged ? 'unflag' : 'flag', onSelect: () => on.flag(item) },
    { label: 'unsubscribe', onSelect: () => on.unsubscribe(item) },
    { label: 'always do this for the sender', onSelect: () => on.rule(item) },
    { label: 'archive everything else', onSelect: () => on.archiveOthers(item) },
    { label: 'archive all from sender', onSelect: () => on.archiveSender(item) },
    { label: 'delete', onSelect: () => on.remove(item) },
  ]
}

/**
 * The full message. On a phone it opens under its row, whose archive and to do sit just above, so it adds only the rest.
 * In the reading pane it has no buttons at all: the bar above the pane acts on it.
 */
function Detail({ item, kept, pane, on }: { item: InboxThread; kept: boolean; pane: boolean; on: Handlers }) {
  const { message, triage } = item
  const suggested = triage?.suggested
  const button = (label: string, action: string, run: () => void) =>
    <button key={label} type="button" className={suggested === action ? 'is-suggested' : ''} onClick={run}>{label}</button>
  const facts = [message.flagged && 'flagged', message.hasAttachments && 'attachment', triage && `${categoryLabel[triage.category]} · ${percent(triage.confidence)}`].filter(Boolean).join(' · ')

  return <div className="detail">
    {!pane && <div className="mail-actions">
      <button type="button" onClick={() => on.block(item)}>archive + rule</button>
      {button('reply', 'reply', () => on.reply(item))}
      {button('snooze', 'snooze', () => on.snooze(item))}
      <Menu label={`more for ${message.subject}`} items={moreItems(item, kept, on)} />
    </div>}
    {pane && <h2 className="detail-subject">{message.subject}</h2>}
    {pane && triage?.summary && <p className="detail-summary">{triage.summary}</p>}
    <p className="detail-meta"><span>{pane && <b className="detail-from">{message.from.name}</b>}{`<${message.from.address}>`}</span><span>{when(message.receivedAt, true)}</span></p>
    {facts && <p className="detail-meta">{facts}</p>}
    <Conversation message={message} />
  </div>
}

function Row({ item, index, kept, quiet, open, picked, pane, leave, on }: { item: InboxThread; index: number; kept: boolean; quiet: boolean; open: boolean; picked: boolean; pane: boolean; leave?: Leave; on: Handlers }) {
  const { message, triage } = item
  const drag = useRef<{ x: number; y: number; active: boolean }>(undefined)
  const dragged = useRef(false)
  const loud = isLoud(item)
  const line = triage?.summary || message.preview
  const suggested = triage?.suggested
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

  return <li id={`mail-${item.key}`} className={`item${leave ? ' is-leaving' : ''}${open ? ' is-open' : ''}${picked ? ' is-picked' : ''}${kept ? ' is-kept' : ''}`} data-leave={leave?.to} style={{ '--i': Math.min(index, 12), '--d': leave?.delay ?? 0 } as CSSProperties}>
    <div className="item-clip">
      <div className="item-under" aria-hidden="true"><span>archive</span><span>snooze</span></div>
      <article className="mail" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
        onClickCapture={(event) => { if (dragged.current) { dragged.current = false; event.stopPropagation(); event.preventDefault() } }}>
        <div className="mail-row">
          <button className="mail-open" type="button" aria-expanded={open} onClick={(event) => { if (pane && !kept && (event.ctrlKey || event.metaKey || event.shiftKey)) on.pick(item, event.shiftKey); else on.open(item) }}>
            <span className="mail-top">
              <span className={`mail-from${message.isRead ? '' : ' is-unread'}`} title={message.from.address}>{message.from.name}{item.all.length > 1 && <span className="mail-count">{item.all.length}</span>}</span>
              <small>{kind ? `${kind} · ` : ''}{when(message.receivedAt)}</small>
            </span>
            <span className="mail-subject">{message.subject}</span>
            {line && <span className="mail-summary">{line}</span>}
          </button>
          {/* The same two buttons on every row, in the same place. On a wide screen the bar has them and the row has a tick. */}
          {pane
            ? !kept && <button className="pick" type="button" role="checkbox" aria-checked={picked} aria-label={`select ${message.subject}`} onClick={(event) => on.pick(item, event.shiftKey)} />
            : <>
              <button className={`quick${suggested === 'archive' ? ' is-suggested' : ''}`} type="button" onClick={() => on.archive(item)}>archive</button>
              <button className={`quick${suggested === 'task' ? ' is-suggested' : ''}`} type="button" onClick={() => on.task(item)}>to do</button>
            </>}
        </div>
        {!pane && <Fold open={open}><Detail item={item} kept={kept} pane={false} on={on} /></Fold>}
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
  const [pickedKeys, setPickedKeys] = useState<string[]>([])
  const lastPick = useRef<string>(undefined)
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
  // What the bar acts on: the ticked rows, or the open message when none is ticked.
  const picked = pane ? order.filter((item) => pickedKeys.includes(item.key)) : []
  const targets = picked.length ? picked : selected ? [selected] : []
  const one = targets.length === 1 ? targets[0] : undefined
  // Archive all takes every row in the list but the ticked ones.
  const unpicked = order.filter((item) => !pickedKeys.includes(item.key))

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

  const say = (text: string, undo?: () => void, ms?: number) => setToast({ key: Date.now(), text, undo, ms })
  const stay = (ids: string[]) => setLeaving((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id))))

  /** The rows leave at once; the mailbox catches up behind them. A failure brings a row back with what is left of it. */
  function clear(list: InboxThread[], to: Leave['to'], work: (messages: Message[]) => Promise<void>, done?: string | (() => string), undoable = false, undoMs?: number, alsoUndo?: () => Promise<void> | undefined, restored?: () => Message[]): void {
    if (!list.length) return
    setLocalError(undefined)
    const keys = list.map(keyOf)
    if (selectedId && keys.includes(selectedId)) {
      const at = order.findIndex((entry) => entry.key === selectedId)
      const stays = (entry: InboxThread) => !keys.includes(entry.key)
      setOpenId(pane ? (order.slice(at + 1).find(stays) ?? order.slice(0, at).reverse().find(stays))?.key : undefined)
    }
    setPickedKeys((current) => current.filter((key) => !keys.includes(key)))
    setLeaving((current) => ({ ...current, ...Object.fromEntries(keys.map((key, index) => [key, { to, delay: Math.min(index, 12) }])) }))
    const messages = list.flatMap((item) => item.all)
    void work(messages)
      .then(() => {
        const text = typeof done === 'string' ? done : done?.()
        if (text) say(text, undoable ? () => { setToast(undefined); void (alsoUndo?.() ?? Promise.resolve()).then(() => each(restored?.() ?? messages, actions.restore)).catch(() => undefined) } : undefined, undoMs)
      })
      .catch(() => undefined)
      .finally(() => stay(keys))
  }

  const counted = (word: string, list: InboxThread[]) => list.length > 1 ? `${word} ${list.length}` : word

  function archive(list: InboxThread[]): void {
    const single = list.length === 1 ? list[0] : undefined
    if (single) clear(list, 'right', oneByOne(actions.archive), actions.isReceipt(single.message) ? 'moved to receipts' : 'archived', true)
    else sweep(list)
  }

  /** One conversation gets the sheet, to name the task. Several are added as they are titled, then archived. */
  function task(list: InboxThread[]): void {
    if (list.length === 1) { on.task(list[0]); return }
    clear(list, 'right', async () => {
      for (const item of list) {
        await actions.task(item.message, item.triage?.task ?? item.message.subject)
        await each(item.all.slice(1), actions.archive)
      }
    }, `added ${list.length} to to do`)
  }

  /**
   * Blocks a sender: every conversation of theirs on the list is archived and a rule archives what they send next.
   * Undo brings the mail back and takes the rule away. If the mail will not move, the rule does not stay either.
   */
  function block(item: InboxThread): void {
    const from = item.message.from.address.toLowerCase()
    const gone = [item, ...order.filter((other) => other.key !== item.key && other.message.from.address.toLowerCase() === from)]
    let unrule: (() => Promise<void>) | undefined
    clear(gone, 'right', (all) => actions.block(item.message)
      .then((undo) => { unrule = undo; return each(all, actions.archive) })
      .catch((failure: unknown) => { void unrule?.().catch(() => undefined); throw failure }),
    () => unrule ? 'archived · rule added' : 'archived', true, undefined, () => unrule?.())
  }

  /** Many rows leave in one go. Kept mail is never in the list handed over. Undo brings back whatever did move, and stays up longer than for one message. */
  function sweep(list: InboxThread[]): void {
    let moved: Message[] = []
    let count = 0
    clear(list, 'right', async (messages) => {
      moved = await actions.archiveAll(messages)
      const gone = new Set(moved.map((message) => message.id))
      count = list.filter((item) => item.all.every((message) => gone.has(message.id))).length
    }, () => count ? `archived ${count}` : '', true, 20_000, undefined, () => moved)
  }

  /** The newest message was handled on its own; the older ones in the conversation are archived behind it. */
  function clearRest(item: InboxThread): void {
    const rest = item.all.slice(1)
    if (!rest.length) return
    setLeaving((current) => ({ ...current, [item.key]: { to: 'right' } }))
    void each(rest, actions.archive).catch(() => undefined).finally(() => stay([item.key]))
  }

  /** A sent reply archives the message it answers when the setting says so; the rest of the conversation goes with it. */
  function answer(item: InboxThread, mode: 'reply' | 'replyAll'): void {
    actions.compose({ mode, message: item.message, text: item.triage?.draft ?? '', onCard: true, onSent: () => { if (archiveAfterReply) clearRest(item) } })
  }

  const on: Handlers = {
    open: (item) => setOpenId(pane || selectedId !== item.key ? item.key : undefined),
    pick: (item, range) => {
      const from = range && lastPick.current ? order.findIndex((entry) => entry.key === lastPick.current) : -1
      const to = order.findIndex((entry) => entry.key === item.key)
      lastPick.current = item.key
      if (from >= 0 && to >= 0) {
        const span = order.slice(Math.min(from, to), Math.max(from, to) + 1).map(keyOf)
        setPickedKeys((current) => [...new Set([...current, ...span])])
      } else setPickedKeys((current) => current.includes(item.key) ? current.filter((key) => key !== item.key) : [...current, item.key])
    },
    archive: (item) => archive([item]),
    block,
    remove: (item) => clear([item], 'fade', oneByOne(actions.remove), 'deleted', true),
    keep: (item) => clear([item], 'fade', oneByOne(actions.keep)),
    flag: (item) => void actions.flag(item.message).catch(() => undefined),
    task: (item) => setSheet({ kind: 'task', thread: item, title: item.triage?.task ?? item.message.subject }),
    reply: (item) => answer(item, 'reply'),
    replyAll: (item) => answer(item, 'replyAll'),
    forward: (item) => actions.compose({ mode: 'forward', message: item.message }),
    snooze: (item) => setSheet({ kind: 'snooze', threads: [item] }),
    rule: (item) => setSheet({ kind: 'rule', message: item.message }),
    unsubscribe: (item) => void actions.unsubscribe(item.message).then((text) => say(text)).catch(() => undefined),
    archiveOthers: (item) => sweep(order.filter((entry) => entry.key !== item.key)),
    archiveSender: (item) => sweep(order.filter((entry) => sameSender(entry, item))),
  }

  // Keys act on what the bar acts on: j and k move, x ticks, e archive, r reply, a reply all, f forward, t to do, s snooze, # delete, u undo.
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
    if (event.key === 'Escape') { if (pane) setPickedKeys([]); else setOpenId(undefined); return }
    if (event.key === 'x' && pane && selected && order.includes(selected)) { on.pick(selected); return }
    const many = ({ e: archive, t: task, s: (list) => setSheet({ kind: 'snooze', threads: list }), '#': (list) => clear(list, 'fade', oneByOne(actions.remove), counted('deleted', list), true) } as Record<string, ((list: InboxThread[]) => void) | undefined>)[event.key]
    const single = ({ r: on.reply, a: on.replyAll, f: on.forward } as Record<string, ((item: InboxThread) => void) | undefined>)[event.key]
    if (!targets.length || (!many && !(single && one))) return
    event.preventDefault()
    if (many) many(targets)
    else single!(one!)
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
    {entries.map((entry, index) => <Row key={entry.key} item={entry.item} index={index} kept={isKept} quiet={quiet} open={selectedId === entry.key} picked={!isKept && pickedKeys.includes(entry.key)} pane={pane} leave={leaving[entry.key] ?? (entry.leaving ? { to: 'fade' } : undefined)} on={on} />)}
  </ul>

  return <div className="inbox">
    <div className="list">
      {/* A phone has no bar, so the check's status and archive all sit here. A wide screen has the status beside the title. */}
      {!pane && <div className="list-head">
        <p className={`status${busy ? ' is-busy' : ''}`} aria-live="polite">{busy ?? ''}</p>
        {order.length > 1 && <button className="link" type="button" onClick={() => sweep(order)}>archive all</button>}
      </div>}
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

    {/* One set of buttons for the whole screen, always in the same place. They act on the ticked rows, or the open message. */}
    {pane && targets.length > 0 && <div className="bar mail-actions" role="toolbar" aria-label="actions">
      <button type="button" className={one?.triage?.suggested === 'archive' ? 'is-suggested' : ''} onClick={() => archive(targets)}>archive</button>
      <button type="button" disabled={!one} onClick={() => one && on.block(one)}>archive + rule</button>
      <button type="button" className={one?.triage?.suggested === 'task' ? 'is-suggested' : ''} onClick={() => task(targets)}>to do</button>
      <button type="button" className={one?.triage?.suggested === 'reply' ? 'is-suggested' : ''} disabled={!one} onClick={() => one && on.reply(one)}>reply</button>
      <button type="button" className={one?.triage?.suggested === 'snooze' ? 'is-suggested' : ''} onClick={() => setSheet({ kind: 'snooze', threads: targets })}>snooze</button>
      <Menu label="more" items={one ? moreItems(one, Boolean(kept[one.message.id]), on) : [
        { label: 'keep in inbox', onSelect: () => clear(targets, 'fade', oneByOne(actions.keep)) },
        { label: 'delete', onSelect: () => clear(targets, 'fade', oneByOne(actions.remove), counted('deleted', targets), true) },
      ]} />
      {picked.length > 0 && <button className="bar-count" type="button" onClick={() => setPickedKeys([])}>{picked.length} selected<Icon name="close" size={14} /></button>}
      <button className="bar-all" type="button" disabled={!unpicked.length} onClick={() => sweep(unpicked)}>{picked.length === 0 ? 'archive all' : picked.length === 1 ? 'archive all but this' : 'archive all but these'}</button>
    </div>}

    {pane && <section className="reader" aria-label="message">
      {selected && <div className="reader-inner" key={selected.key}><Detail item={selected} kept={Boolean(kept[selected.message.id])} pane on={on} /></div>}
    </section>}

    <Toast toast={toast} onDone={() => setToast(undefined)} />

    {sheet?.kind === 'snooze' && <Sheet title="snooze until" onClose={() => setSheet(undefined)}>
      <div className="options">{snoozeOptions.map((option) => <button key={option} type="button" onClick={() => { setSheet(undefined); clear(sheet.threads, 'left', oneByOne((message) => actions.snooze(message, option as SnoozeOption)), `${counted('snoozed', sheet.threads)} until ${option}`, true) }}>{option}</button>)}</div>
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
