import { useState } from 'react'
import type { MessageActions } from '../App'
import { ruleActionLabel, senderDomain, type RuleSuggestion } from '../domain/rules'
import { snoozeOptions, type SnoozeOption } from '../domain/snooze'
import { categoryLabel, groupInbox, summaryLine, type RunSummary, type Triaged } from '../domain/triage'
import type { Message, RuleAction, Snooze } from '../domain/types'
import { Card, Empty, Field, Menu, Segmented, Sheet } from '../ui'
import type { ConnectionStatus } from './SettingsView'

type SheetState =
  | { kind: 'reply'; message: Message; draft: string }
  | { kind: 'snooze'; message: Message }
  | { kind: 'task'; message: Message; title: string }
  | { kind: 'rule'; message: Message }

function when(receivedAt: string): string {
  const value = new Date(receivedAt)
  const today = new Date().toDateString() === value.toDateString()
  return today
    ? value.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase()
    : value.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toLowerCase()
}

const percent = (value: number) => `${Math.round(value * 100)}% sure`

function MessageCard({ item, kept, quiet, actions, onSheet, onError }: { item: Triaged; kept: boolean; quiet: boolean; actions: MessageActions; onSheet: (state: SheetState) => void; onError: (text?: string) => void }) {
  const [open, setOpen] = useState(false)
  const [working, setWorking] = useState(false)
  const [note, setNote] = useState<string>()
  const { message, triage } = item
  const suggested = triage?.suggested
  const loud = triage?.needsReply || triage?.category === 'action'
  const line = triage?.summary || message.preview

  function perform(work: () => Promise<void>): void {
    setWorking(true)
    onError(undefined)
    void work().catch(() => undefined).finally(() => setWorking(false))
  }

  const button = (label: string, action: string, onClick: () => void) =>
    <button key={label} type="button" className={suggested === action ? 'is-suggested' : ''} disabled={working} onClick={onClick}>{label}</button>

  const chip = triage && (quiet || loud || triage.confidence < 0.6)
    ? <span className={`chip${loud ? ' is-loud' : ''}`}>{quiet ? `${categoryLabel[triage.category]} · ${percent(triage.confidence)}` : categoryLabel[triage.category]}</span>
    : null

  return <article className={`card mail${kept ? ' is-kept' : ''}`}>
    <div className="mail-head">
      <span className={`mail-from${message.isRead ? '' : ' is-unread'}`} title={message.from.address}>{message.from.name}</span>
      <small>{[message.flagged && 'flagged', message.hasAttachments && 'attachment', when(message.receivedAt)].filter(Boolean).join(' · ')}</small>
    </div>
    <button className="mail-subject" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>{message.subject}</button>
    {(line || chip) && <div className="mail-head"><span className={`mail-summary${loud ? ' is-loud' : ''}`}>{line}</span>{chip}</div>}
    {open && <div className="mail-body">{message.body || message.preview || '(empty)'}</div>}
    {note && <small className="mail-note">{note}</small>}
    <div className="mail-actions">
      {button('archive', 'archive', () => perform(() => actions.archive(message)))}
      {!quiet && button('to do', 'task', () => onSheet({ kind: 'task', message, title: triage?.task ?? message.subject }))}
      {!quiet && button('reply', 'reply', () => onSheet({ kind: 'reply', message, draft: triage?.draft ?? '' }))}
      {quiet ? button('keep', 'keep', () => perform(() => actions.keep(message))) : button('snooze', 'snooze', () => onSheet({ kind: 'snooze', message }))}
      <Menu label={`more for ${message.subject}`} items={[
        ...(quiet ? [
          { label: 'to do', onSelect: () => onSheet({ kind: 'task', message, title: triage?.task ?? message.subject }) },
          { label: 'reply', onSelect: () => onSheet({ kind: 'reply', message, draft: triage?.draft ?? '' }) },
          { label: 'snooze', onSelect: () => onSheet({ kind: 'snooze', message }) },
        ] : [{ label: kept ? 'kept' : 'keep in inbox', disabled: kept, onSelect: () => perform(() => actions.keep(message)) }]),
        { label: message.flagged ? 'unflag' : 'flag', onSelect: () => perform(() => actions.flag(message)) },
        { label: 'open in outlook', onSelect: () => window.open(message.webLink, '_blank', 'noreferrer') },
        { label: 'unsubscribe', onSelect: () => perform(async () => setNote(await actions.unsubscribe(message))) },
        { label: 'always do this for the sender', onSelect: () => onSheet({ kind: 'rule', message }) },
        { label: 'delete', danger: true, onSelect: () => perform(() => actions.remove(message)) },
      ]} />
    </div>
  </article>
}

export function InboxView({ items, kept, summary, busy, error, connection, hasModel, suggestions, snoozes, actions, onConnect, onSettings, onDismissSuggestion }: {
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
  onConnect: () => Promise<void>
  onSettings: () => void
  onDismissSuggestion: (item: RuleSuggestion) => void
}) {
  const [sheet, setSheet] = useState<SheetState>()
  const [localError, setLocalError] = useState<string>()
  const live = items.filter((item) => !kept[item.message.id])
  const keptItems = items.filter((item) => kept[item.message.id])
  const groups = groupInbox(live)
  const shownError = error ?? localError

  if (connection !== 'connected') {
    return <Card title="microsoft account">
      <div className="actions"><button className="primary" type="button" disabled={connection === 'unconfigured' || Boolean(busy)} onClick={() => void onConnect()}>{connection === 'unconfigured' ? 'no microsoft app id' : busy ? 'connecting' : 'connect microsoft'}</button></div>
      {shownError && <p className="note is-error" role="alert">{shownError}</p>}
    </Card>
  }

  return <>
    <p className={`status${busy ? ' is-busy' : ''}`} aria-live="polite">{busy ?? (summary ? summaryLine(summary) : '')}</p>
    {shownError && <p className="note is-error" role="alert">{shownError}</p>}
    {!hasModel && items.length > 0 && <p className="note">no summaries without an anthropic key · <button className="link" type="button" onClick={onSettings}>settings</button></p>}

    {suggestions.length > 0 && <Card title="rules to add">
      {suggestions.map((item) => <div className="suggest" key={`${item.from}|${item.action}`}>
        <span>{ruleActionLabel[item.action]} everything from {item.from} <small>{item.count} so far</small></span>
        <button className="secondary" type="button" onClick={() => { void actions.makeRule({ from: item.from, action: item.action }); onDismissSuggestion(item) }}>add rule</button>
        <button className="plain" type="button" onClick={() => onDismissSuggestion(item)}>not now</button>
      </div>)}
    </Card>}

    {groups.needsMe.length > 0 && groups.probablyFine.length > 0 && <h2 className="group-title">needs me</h2>}
    {groups.needsMe.map((item) => <MessageCard key={item.message.id} item={item} kept={false} quiet={false} actions={actions} onSheet={setSheet} onError={setLocalError} />)}

    {groups.probablyFine.length > 0 && <div className="group-head">
      <h2 className="group-title">probably fine</h2>
      <button className="link" type="button" onClick={() => { setLocalError(undefined); void actions.archiveAll(groups.probablyFine.map((item) => item.message)) }}>archive all {groups.probablyFine.length}</button>
    </div>}
    {groups.probablyFine.map((item) => <MessageCard key={item.message.id} item={item} kept={false} quiet actions={actions} onSheet={setSheet} onError={setLocalError} />)}

    {!busy && items.length === 0 && summary && <Card><Empty>inbox zero{snoozes.length ? ` · ${snoozes.length} snoozed` : ''}</Empty></Card>}

    {keptItems.length > 0 && <details className="card group">
      <summary>{keptItems.length} kept in inbox</summary>
      {keptItems.map((item) => <MessageCard key={item.message.id} item={item} kept quiet={false} actions={actions} onSheet={setSheet} onError={setLocalError} />)}
    </details>}

    {sheet?.kind === 'reply' && <ReplySheet message={sheet.message} draft={sheet.draft} hasModel={hasModel} onDraft={(strong, instruction) => actions.draft(sheet.message, strong, instruction)} onClose={() => setSheet(undefined)} onSend={(text, mode) => actions.reply(sheet.message, text, mode).then(() => setSheet(undefined)).catch(() => undefined)} />}
    {sheet?.kind === 'snooze' && <Sheet title="snooze until" onClose={() => setSheet(undefined)}>
      <div className="options">{snoozeOptions.map((option) => <button key={option} type="button" onClick={() => void actions.snooze(sheet.message, option as SnoozeOption).then(() => setSheet(undefined)).catch(() => undefined)}>{option}</button>)}</div>
    </Sheet>}
    {sheet?.kind === 'task' && <TaskSheet title={sheet.title} onClose={() => setSheet(undefined)} onSave={(title) => actions.task(sheet.message, title).then(() => setSheet(undefined)).catch(() => undefined)} />}
    {sheet?.kind === 'rule' && <RuleSheet message={sheet.message} onClose={() => setSheet(undefined)} onSave={(input) => actions.makeRule(input).then(() => setSheet(undefined)).catch(() => undefined)} />}
  </>
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
