import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { MessageActions } from '../App'
import { ruleActionLabel, senderDomain, type RuleSuggestion } from '../domain/rules'
import { snoozeOptions, type SnoozeOption } from '../domain/snooze'
import { categoryLabel, groupInbox, summaryLine, type RunSummary, type Triaged } from '../domain/triage'
import type { Message, RuleAction, Snooze } from '../domain/types'
import { Card, Field, Fold, Menu, Segmented, Sheet, Toast, useMediaQuery, usePresence, type ToastState } from '../ui'
import type { ConnectionStatus } from './SettingsView'

type SheetState =
  | { kind: 'reply'; message: Message; draft: string }
  | { kind: 'snooze'; message: Message }
  | { kind: 'task'; message: Message; title: string }
  | { kind: 'rule'; message: Message }

/** Which way a row slides as it leaves, and how long it waits when a whole group goes at once. */
type Leave = { to: 'right' | 'left' | 'fade'; delay?: number }

/** Everything a row or the open message can ask for. Each one animates, acts, and offers undo where it can. */
type Handlers = {
  open: (item: Triaged) => void
  archive: (item: Triaged) => void
  remove: (item: Triaged) => void
  keep: (item: Triaged) => void
  flag: (item: Triaged) => void
  task: (item: Triaged) => void
  reply: (item: Triaged) => void
  snooze: (item: Triaged) => void
  rule: (item: Triaged) => void
  unsubscribe: (item: Triaged) => void
}

const swipeAt = 88
const keyOf = (item: Triaged) => item.message.id

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
function quickAction(item: Triaged, kept: boolean, on: Handlers): { label: string; run: () => void } {
  const suggested = item.triage?.suggested
  if (suggested === 'reply') return { label: 'reply', run: () => on.reply(item) }
  if (suggested === 'task') return { label: 'to do', run: () => on.task(item) }
  if (suggested === 'snooze') return { label: 'snooze', run: () => on.snooze(item) }
  if (suggested === 'delete') return { label: 'delete', run: () => on.remove(item) }
  if (suggested === 'keep' && !kept) return { label: 'keep', run: () => on.keep(item) }
  return { label: 'archive', run: () => on.archive(item) }
}

/** The full message and every action on it. Inline under the row on a phone, in the reading pane on a wide screen. */
function Detail({ item, kept, quiet, pane, on }: { item: Triaged; kept: boolean; quiet: boolean; pane: boolean; on: Handlers }) {
  const { message, triage } = item
  const suggested = triage?.suggested
  const button = (label: string, action: string, run: () => void) =>
    <button key={label} type="button" className={suggested === action ? 'is-suggested' : ''} onClick={run}>{label}</button>
  const facts = [message.flagged && 'flagged', message.hasAttachments && 'attachment', triage && `${categoryLabel[triage.category]} · ${percent(triage.confidence)}`].filter(Boolean).join(' · ')

  return <div className="detail">
    <div className="mail-actions">
      {button('archive', 'archive', () => on.archive(item))}
      {!quiet && button('to do', 'task', () => on.task(item))}
      {!quiet && button('reply', 'reply', () => on.reply(item))}
      {quiet ? button('keep', 'keep', () => on.keep(item)) : button('snooze', 'snooze', () => on.snooze(item))}
      <Menu label={`more for ${message.subject}`} items={[
        ...(quiet ? [
          { label: 'to do', onSelect: () => on.task(item) },
          { label: 'reply', onSelect: () => on.reply(item) },
          { label: 'snooze', onSelect: () => on.snooze(item) },
        ] : [{ label: kept ? 'kept' : 'keep in inbox', disabled: kept, onSelect: () => on.keep(item) }]),
        { label: message.flagged ? 'unflag' : 'flag', onSelect: () => on.flag(item) },
        { label: 'open in outlook', onSelect: () => window.open(message.webLink, '_blank', 'noreferrer') },
        { label: 'unsubscribe', onSelect: () => on.unsubscribe(item) },
        { label: 'always do this for the sender', onSelect: () => on.rule(item) },
        { label: 'delete', danger: true, onSelect: () => on.remove(item) },
      ]} />
    </div>
    {pane && <h2 className="detail-subject">{message.subject}</h2>}
    {pane && triage?.summary && <p className={`detail-summary${isLoud(item) ? ' is-loud' : ''}`}>{triage.summary}</p>}
    <p className="detail-meta"><span>{pane ? `${message.from.name} ` : ''}{`<${message.from.address}>`}</span><span>{when(message.receivedAt, true)}</span></p>
    {facts && <p className="detail-meta">{facts}</p>}
    <div className="mail-body">{message.body || message.preview || '(empty)'}</div>
  </div>
}

function Row({ item, index, kept, quiet, open, pane, leave, on }: { item: Triaged; index: number; kept: boolean; quiet: boolean; open: boolean; pane: boolean; leave?: Leave; on: Handlers }) {
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

  return <li id={`mail-${message.id}`} className={`item${leave ? ' is-leaving' : ''}${open ? ' is-open' : ''}${kept ? ' is-kept' : ''}`} data-leave={leave?.to} style={{ '--i': Math.min(index, 12), '--d': leave?.delay ?? 0 } as CSSProperties}>
    <div className="item-clip">
      <div className="item-under" aria-hidden="true"><span>archive</span><span>snooze</span></div>
      <article className="mail" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
        onClickCapture={(event) => { if (dragged.current) { dragged.current = false; event.stopPropagation(); event.preventDefault() } }}>
        <div className="mail-row">
          <button className="mail-open" type="button" aria-expanded={open} onClick={() => on.open(item)}>
            <span className="mail-top">
              <span className={`mail-from${message.isRead ? '' : ' is-unread'}`} title={message.from.address}>{message.from.name}</span>
              <small>{kind ? `${kind} · ` : ''}{when(message.receivedAt)}</small>
            </span>
            <span className="mail-subject">{message.subject}</span>
            {line && <span className={`mail-summary${loud ? ' is-loud' : ''}`}>{line}</span>}
          </button>
          <button className={`quick${triage ? ' is-suggested' : ''}`} type="button" onClick={quick.run}>{quick.label}</button>
        </div>
        {!pane && <Fold open={open}><Detail item={item} kept={kept} quiet={quiet} pane={false} on={on} /></Fold>}
      </article>
    </div>
  </li>
}

export function InboxView({ items, kept, summary, busy, error, connection, hasModel, suggestions, snoozes, actions, more, onMore, onConnect, onSettings, onDismissSuggestion }: {
  items: Triaged[]
  kept: Record<string, string>
  summary?: RunSummary
  busy?: string
  error?: string
  connection: ConnectionStatus
  hasModel: boolean
  suggestions: RuleSuggestion[]
  snoozes: Snooze[]
  actions: MessageActions
  more?: boolean
  onMore?: () => void
  onConnect: () => Promise<void>
  onSettings: () => void
  onDismissSuggestion: (item: RuleSuggestion) => void
}) {
  const [sheet, setSheet] = useState<SheetState>()
  const [localError, setLocalError] = useState<string>()
  const [openId, setOpenId] = useState<string>()
  const [leaving, setLeaving] = useState<Record<string, Leave>>({})
  const [toast, setToast] = useState<ToastState>()
  const pane = useMediaQuery('(min-width: 60rem)')
  const live = items.filter((item) => !kept[item.message.id])
  const keptItems = items.filter((item) => kept[item.message.id])
  const groups = groupInbox(live)
  const needsRows = usePresence(groups.needsMe, keyOf)
  const fineRows = usePresence(groups.probablyFine, keyOf)
  const keptRows = usePresence(keptItems, keyOf)
  const shownError = error ?? localError
  const moreRef = useRef<HTMLButtonElement>(null)
  const onMoreRef = useRef(onMore)
  onMoreRef.current = onMore
  const follow = useRef(false)

  // Rows still in play, top to bottom. The reading pane always shows one of them when there is one.
  const order = [...groups.needsMe, ...groups.probablyFine].filter((item) => !leaving[item.message.id])
  const selected = items.find((item) => item.message.id === openId && !leaving[item.message.id]) ?? (pane ? order[0] : undefined)
  const selectedId = selected?.message.id
  const isQuiet = (item: Triaged) => groups.probablyFine.includes(item)

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

  /** The row leaves at once; the mailbox catches up behind it. A failure brings the row back. */
  function clear(item: Triaged, to: Leave['to'], work: () => Promise<void>, done?: string, undoable = false): void {
    const { message } = item
    setLocalError(undefined)
    if (selectedId === message.id) {
      const at = order.indexOf(item)
      setOpenId(pane ? (order[at + 1] ?? order[at - 1])?.message.id : undefined)
    }
    setLeaving((current) => ({ ...current, [message.id]: { to } }))
    void work()
      .then(() => { if (done) say(done, undoable ? () => { setToast(undefined); void actions.restore(message).catch(() => undefined) } : undefined) })
      .catch(() => undefined)
      .finally(() => stay([message.id]))
  }

  function archiveAll(list: Triaged[]): void {
    setLocalError(undefined)
    setLeaving((current) => ({ ...current, ...Object.fromEntries(list.map((item, index) => [item.message.id, { to: 'right', delay: Math.min(index, 14) }])) }))
    void actions.archiveAll(list.map((item) => item.message))
      .then(() => say(`archived ${list.length}`))
      .finally(() => stay(list.map(keyOf)))
  }

  const on: Handlers = {
    open: (item) => setOpenId(pane || selectedId !== item.message.id ? item.message.id : undefined),
    archive: (item) => clear(item, 'right', () => actions.archive(item.message), 'archived', true),
    remove: (item) => clear(item, 'fade', () => actions.remove(item.message), 'deleted', true),
    keep: (item) => clear(item, 'fade', () => actions.keep(item.message)),
    flag: (item) => void actions.flag(item.message).catch(() => undefined),
    task: (item) => setSheet({ kind: 'task', message: item.message, title: item.triage?.task ?? item.message.subject }),
    reply: (item) => setSheet({ kind: 'reply', message: item.message, draft: item.triage?.draft ?? '' }),
    snooze: (item) => setSheet({ kind: 'snooze', message: item.message }),
    rule: (item) => setSheet({ kind: 'rule', message: item.message }),
    unsubscribe: (item) => void actions.unsubscribe(item.message).then((text) => say(text)).catch(() => undefined),
  }

  // Keys on the open message: j and k move, e archive, r reply, t to do, s snooze, # delete, u undo.
  const onKey = useRef<(event: KeyboardEvent) => void>(undefined)
  onKey.current = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || sheet) return
    if ((event.target as HTMLElement).closest?.('input, textarea, select, dialog, details[open]')) return
    if (event.key === 'u') { toast?.undo?.(); return }
    if (event.key === 'j' || event.key === 'k') {
      const at = selected ? order.indexOf(selected) : -1
      const next = order[Math.max(0, Math.min(order.length - 1, at + (event.key === 'j' ? 1 : -1)))]
      if (next) { follow.current = true; setOpenId(next.message.id) }
      return
    }
    if (event.key === 'Escape' && !pane) { setOpenId(undefined); return }
    if (!selected) return
    const act = ({ e: on.archive, r: on.reply, t: on.task, s: on.snooze, '#': on.remove } as Record<string, ((item: Triaged) => void) | undefined>)[event.key]
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

  const rows = (entries: { key: string; item: Triaged; leaving: boolean }[], quiet: boolean, isKept = false) => <ul className="items">
    {entries.map((entry, index) => <Row key={entry.key} item={entry.item} index={index} kept={isKept} quiet={quiet} open={selectedId === entry.key} pane={pane} leave={leaving[entry.key] ?? (entry.leaving ? { to: 'fade' } : undefined)} on={on} />)}
  </ul>

  return <div className="inbox">
    <div className="list">
      <p className={`status${busy ? ' is-busy' : ''}`} aria-live="polite">{busy ?? (summary ? summaryLine(summary) : '')}</p>
      {shownError && <p className="note is-error" role="alert">{shownError}</p>}
      {!hasModel && items.length > 0 && <p className="note">no summaries without an anthropic key · <button className="link" type="button" onClick={onSettings}>settings</button></p>}

      {suggestions.length > 0 && <details className="card group">
        <summary>{suggestions.length} {suggestions.length === 1 ? 'rule' : 'rules'} to add</summary>
        {suggestions.map((item) => <div className="suggest" key={`${item.from}|${item.action}`}>
          <span>{ruleActionLabel[item.action]} everything from {item.from} <small>{item.count} so far</small></span>
          <button className="secondary" type="button" onClick={() => { void actions.makeRule({ from: item.from, action: item.action }); onDismissSuggestion(item) }}>add rule</button>
          <button className="plain" type="button" onClick={() => onDismissSuggestion(item)}>not now</button>
        </div>)}
      </details>}

      {(needsRows.length > 0 || fineRows.length > 0) && <div className="lanes">
        {needsRows.length > 0 && <section className="lane">
          {groups.needsMe.length > 0 && groups.probablyFine.length > 0 && <h2 className="group-title">needs me</h2>}
          {rows(needsRows, false)}
        </section>}
        {fineRows.length > 0 && <section className="lane">
          {groups.probablyFine.length > 0 && <div className="group-head">
            <h2 className="group-title">probably fine</h2>
            <button className="link" type="button" onClick={() => archiveAll(groups.probablyFine.filter((item) => !leaving[item.message.id]))}>archive all {groups.probablyFine.length}</button>
          </div>}
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
      {selected && <div className="reader-inner" key={selected.message.id}><Detail item={selected} kept={Boolean(kept[selected.message.id])} quiet={isQuiet(selected)} pane on={on} /></div>}
    </section>}

    <Toast toast={toast} onDone={() => setToast(undefined)} />

    {sheet?.kind === 'reply' && <ReplySheet message={sheet.message} draft={sheet.draft} hasModel={hasModel} onDraft={(strong, instruction) => actions.draft(sheet.message, strong, instruction)} onClose={() => setSheet(undefined)} onSend={(text, mode) => actions.reply(sheet.message, text, mode).then(() => { setSheet(undefined); say(mode === 'send' ? 'sent' : 'saved to drafts') }).catch(() => undefined)} />}
    {sheet?.kind === 'snooze' && <Sheet title="snooze until" onClose={() => setSheet(undefined)}>
      <div className="options">{snoozeOptions.map((option) => <button key={option} type="button" onClick={() => { const item = items.find((entry) => entry.message.id === sheet.message.id); setSheet(undefined); if (item) clear(item, 'left', () => actions.snooze(item.message, option as SnoozeOption), `snoozed until ${option}`, true) }}>{option}</button>)}</div>
    </Sheet>}
    {sheet?.kind === 'task' && <TaskSheet title={sheet.title} onClose={() => setSheet(undefined)} onSave={(title) => actions.task(sheet.message, title).then(() => { setSheet(undefined); say('added to to do') }).catch(() => undefined)} />}
    {sheet?.kind === 'rule' && <RuleSheet message={sheet.message} onClose={() => setSheet(undefined)} onSave={(input) => actions.makeRule(input).then(() => { setSheet(undefined); say('rule saved') }).catch(() => undefined)} />}
  </div>
}

function ReplySheet({ message, draft, hasModel, onDraft, onClose, onSend }: { message: Message; draft: string; hasModel: boolean; onDraft: (strong: boolean, instruction?: string) => Promise<string>; onClose: () => void; onSend: (text: string, mode: 'send' | 'draft') => Promise<void> }) {
  const [text, setText] = useState(draft)
  const [instruction, setInstruction] = useState('')
  const [sending, setSending] = useState<'send' | 'draft'>()
  const [drafting, setDrafting] = useState(false)
  const [failure, setFailure] = useState<string>()
  const submit = (mode: 'send' | 'draft') => { setSending(mode); void onSend(text, mode).finally(() => setSending(undefined)) }
  const draftNow = (strong: boolean) => {
    setDrafting(true); setFailure(undefined)
    void onDraft(strong, instruction).then(setText).catch((error: unknown) => setFailure(error instanceof Error ? error.message.toLowerCase() : 'draft failed')).finally(() => setDrafting(false))
  }
  return <Sheet title={`reply to ${message.from.name}`} onClose={onClose}>
    <div className="stack">
      <Field label={message.subject}><textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} /></Field>
      {hasModel && <>
        <Field label="what to say"><input value={instruction} placeholder="yes, but push it to 6" onChange={(event) => setInstruction(event.target.value)} /></Field>
        <div className="actions">
          <button className="secondary" type="button" disabled={drafting} onClick={() => draftNow(false)}>{drafting ? 'drafting' : text ? 'redraft' : 'draft for me'}</button>
          <button className="plain" type="button" disabled={drafting} onClick={() => draftNow(true)}>better draft</button>
        </div>
      </>}
      {failure && <p className="note is-error" role="alert">{failure}</p>}
      <div className="actions">
        <button className="primary" type="button" disabled={!text.trim() || Boolean(sending)} onClick={() => submit('send')}>{sending === 'send' ? 'sending' : 'send'}</button>
        <button className="secondary" type="button" disabled={Boolean(sending)} onClick={() => submit('draft')}>{sending === 'draft' ? 'saving' : 'finish in outlook'}</button>
        <button className="plain" type="button" onClick={onClose}>cancel</button>
      </div>
    </div>
  </Sheet>
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
