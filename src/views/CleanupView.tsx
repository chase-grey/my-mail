import { useState } from 'react'
import { describeCleared, describeGroup, likelyNoise, type SenderGroup } from '../domain/cleanup'
import { categoryLabel } from '../domain/triage'
import { Card, Empty, Menu } from '../ui'

export type CleanupState = {
  scanned: number
  total?: number
  groups: SenderGroup[]
  /** Mail past thirty days that one press would archive, and the flagged mail it would leave. */
  old: { count: number; unread: number; flagged: number }
  /** Senders I said are not noise. They are never suggested. */
  notNoise?: string[]
  /** How many the old mail sweep has archived this visit and can still bring back. */
  swept?: number
  done: boolean
  working?: string
}

export type CleanupActions = {
  scan: () => Promise<void>
  archiveSender: (group: SenderGroup) => Promise<void>
  deleteSender: (group: SenderGroup) => Promise<void>
  /** Archive everything from the sender and add a rule so the next one never lands. */
  blockSender: (group: SenderGroup, action: 'archive' | 'delete') => Promise<void>
  /** Put a cleared sender's mail back in the inbox and drop the rule made with it. */
  undoSender: (group: SenderGroup) => Promise<void>
  unsubscribe: (group: SenderGroup) => Promise<string>
  /** Say a sender is not noise, so it is not suggested for a rule again; false takes that back. */
  markNotNoise: (group: SenderGroup, on: boolean) => Promise<void>
  /** Archive all mail older than thirty days, unread included. Flagged mail stays. */
  archiveOld: () => Promise<void>
  undoOld: () => Promise<void>
}

function SenderRow({ group, noise, marked, onMark, onError, actions }: { group: SenderGroup; noise: boolean; marked?: boolean; onMark?: (on: boolean) => void; onError: (text?: string) => void; actions: CleanupActions }) {
  const [working, setWorking] = useState(false)
  const [note, setNote] = useState<string>()
  const perform = (work: () => Promise<void>) => {
    setWorking(true); onError(undefined)
    void work().catch((error: unknown) => onError(error instanceof Error ? error.message.toLowerCase() : 'that failed')).finally(() => setWorking(false))
  }
  const mark = (on: boolean) => perform(async () => { await actions.markNotNoise(group, on); onMark?.(on) })
  return <li className={`row sender${working ? ' is-working' : ''}${group.cleared || marked ? ' is-cleared' : ''}`}>
    <div className="row-main">
      <span className="row-title" title={group.address}>{group.name}{group.kind && <span className={`chip${noise ? '' : ' is-quiet'}`}>{categoryLabel[group.kind]}</span>}</span>
      {group.cleared || marked
        ? <small className="sender-done" role="status">{group.cleared ? describeCleared(group) : 'not noise'}</small>
        : <small>{[describeGroup(group), note].filter(Boolean).join(' · ')}</small>}
    </div>
    {group.cleared || marked ? <div className="row-buttons">
      <button type="button" disabled={working} onClick={() => group.cleared ? perform(() => actions.undoSender(group)) : mark(false)}>undo</button>
    </div> : <div className="row-buttons">
      <button type="button" className={noise ? 'is-suggested' : ''} disabled={working} onClick={() => perform(() => actions.blockSender(group, 'archive'))}>archive all + rule</button>
      <Menu label={`more for ${group.name}`} items={[
        ...(noise ? [{ label: 'not noise', onSelect: () => mark(true) }] : []),
        { label: 'archive all', onSelect: () => perform(() => actions.archiveSender(group)) },
        { label: 'unsubscribe', onSelect: () => perform(async () => setNote(await actions.unsubscribe(group))) },
        { label: 'delete all + rule', onSelect: () => perform(() => actions.blockSender(group, 'delete')) },
        { label: 'delete all', onSelect: () => perform(() => actions.deleteSender(group)) },
      ]} />
    </div>}
  </li>
}

export function CleanupView({ state, error, actions, onError }: { state: CleanupState; error?: string; actions: CleanupActions; onError: (text?: string) => void }) {
  const [showAll, setShowAll] = useState(false)
  // A sender marked this visit keeps its row where it was; the next scan lists it with everyone else.
  const [marked, setMarked] = useState<string[]>([])
  const isMarked = (group: SenderGroup) => marked.includes(group.address)
  const suggested = (group: SenderGroup) => likelyNoise(group, state.notNoise)
  const noise = state.groups.filter((group) => suggested(group) || isMarked(group))
  const left = (groups: SenderGroup[]) => groups.filter((group) => !group.cleared)
  const rest = state.groups.filter((group) => !suggested(group) && !isMarked(group))
  const row = (group: SenderGroup) => <SenderRow key={group.address} group={group} noise={suggested(group)} marked={isMarked(group)} onMark={(on) => setMarked((current) => on ? [...current, group.address] : current.filter((address) => address !== group.address))} onError={onError} actions={actions} />
  const shown = showAll ? rest : rest.slice(0, 15)

  if (!state.done) {
    return <Card title="clean up">
      <p className="status is-busy" aria-live="polite">{state.working ?? (state.scanned ? `read ${state.scanned} messages` : 'reading the inbox')}</p>
      {error && <p className="note is-error" role="alert">{error}</p>}
    </Card>
  }

  return <>
    <p className="status" aria-live="polite">{state.working ?? `${state.total ?? state.scanned} in inbox · ${left(state.groups).length} senders`}</p>
    {error && <p className="note is-error" role="alert">{error}</p>}

    {(state.old.count > 0 || Boolean(state.swept)) && <Card title="old mail" className="is-wide">
      {state.old.count > 0 && <div className="suggest">
        <span>{[`${state.old.count.toLocaleString()} older than 30 days`, state.old.unread > 0 && `${state.old.unread.toLocaleString()} unread`, state.old.flagged > 0 && `${state.old.flagged.toLocaleString()} flagged stay`].filter(Boolean).join(' · ')}</span>
        <button className="primary" type="button" disabled={Boolean(state.working)} onClick={() => void actions.archiveOld()}>archive all</button>
      </div>}
      {Boolean(state.swept) && <div className="suggest">
        <span>archived {state.swept!.toLocaleString()}</span>
        <button className="secondary" type="button" disabled={Boolean(state.working)} onClick={() => void actions.undoOld()}>undo</button>
      </div>}
    </Card>}

    <Card title="probably noise" aside={left(noise).filter((group) => !isMarked(group)).length > 0 && <span className="count">{left(noise).filter((group) => !isMarked(group)).reduce((sum, group) => sum + group.count, 0)} messages</span>}>
      {noise.length
        ? <ul className="rows">{noise.map(row)}</ul>
        : <Empty>nothing looks like noise</Empty>}
    </Card>

    <Card title="everyone else" aside={left(rest).length > 0 && <span className="count">{left(rest).length} senders</span>}>
      {rest.length
        ? <>
          <ul className="rows">{shown.map(row)}</ul>
          {rest.length > shown.length && <div className="actions"><button className="link" type="button" onClick={() => setShowAll(true)}>show all {rest.length}</button></div>}
        </>
        : <Empty>no one else</Empty>}
    </Card>

    <div className="actions"><button className="plain" type="button" disabled={Boolean(state.working)} onClick={() => { setMarked([]); void actions.scan() }}>read again</button></div>
  </>
}
