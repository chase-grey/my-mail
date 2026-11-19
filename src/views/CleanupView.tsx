import { useState } from 'react'
import { describeGroup, likelyNoise, type SenderGroup } from '../domain/cleanup'
import { categoryLabel } from '../domain/triage'
import { Card, Empty, Menu } from '../ui'

export type CleanupState = {
  scanned: number
  total?: number
  groups: SenderGroup[]
  staleCount: number
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
  archiveStale: () => Promise<void>
}

function SenderRow({ group, onError, actions }: { group: SenderGroup; onError: (text?: string) => void; actions: CleanupActions }) {
  const [working, setWorking] = useState(false)
  const [note, setNote] = useState<string>()
  const noise = likelyNoise(group)
  const perform = (work: () => Promise<void>) => {
    setWorking(true); onError(undefined)
    void work().catch((error: unknown) => onError(error instanceof Error ? error.message.toLowerCase() : 'that failed')).finally(() => setWorking(false))
  }
  return <li className={`row sender${working ? ' is-working' : ''}${group.cleared ? ' is-cleared' : ''}`}>
    <div className="row-main">
      <span className="row-title" title={group.address}>{group.name}{group.kind && <span className={`chip${noise ? '' : ' is-quiet'}`}>{categoryLabel[group.kind]}</span>}</span>
      <small>{[describeGroup(group), note, group.cleared && (group.cleared === 'archive' ? 'archived' : 'deleted')].filter(Boolean).join(' · ')}</small>
    </div>
    {group.cleared ? <div className="row-buttons">
      <button type="button" disabled={working} onClick={() => perform(() => actions.undoSender(group))}>undo</button>
    </div> : <div className="row-buttons">
      <button type="button" className={noise ? 'is-suggested' : ''} disabled={working} onClick={() => perform(() => actions.blockSender(group, 'archive'))}>archive all + rule</button>
      <Menu label={`more for ${group.name}`} items={[
        { label: 'archive all', onSelect: () => perform(() => actions.archiveSender(group)) },
        { label: 'unsubscribe', onSelect: () => perform(async () => setNote(await actions.unsubscribe(group))) },
        { label: 'open latest in outlook', onSelect: () => window.open(`https://outlook.live.com/mail/0/inbox/id/${encodeURIComponent(group.sample.id)}`, '_blank', 'noreferrer') },
        { label: 'delete all + rule', danger: true, onSelect: () => perform(() => actions.blockSender(group, 'delete')) },
        { label: 'delete all', danger: true, onSelect: () => perform(() => actions.deleteSender(group)) },
      ]} />
    </div>}
  </li>
}

export function CleanupView({ state, error, actions, onError }: { state: CleanupState; error?: string; actions: CleanupActions; onError: (text?: string) => void }) {
  const [showAll, setShowAll] = useState(false)
  const noise = state.groups.filter(likelyNoise)
  const left = (groups: SenderGroup[]) => groups.filter((group) => !group.cleared)
  const rest = state.groups.filter((group) => !likelyNoise(group))
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

    {state.staleCount > 0 && <Card title="old and already read">
      <div className="suggest">
        <span>{state.staleCount} read {state.staleCount === 1 ? 'message' : 'messages'} older than 30 days, none flagged</span>
        <button className="secondary" type="button" disabled={Boolean(state.working)} onClick={() => void actions.archiveStale()}>archive them</button>
      </div>
    </Card>}

    <Card title="probably noise" aside={left(noise).length > 0 && <span className="count">{left(noise).reduce((sum, group) => sum + group.count, 0)} messages</span>}>
      {noise.length
        ? <ul className="rows">{noise.map((group) => <SenderRow key={group.address} group={group} onError={onError} actions={actions} />)}</ul>
        : <Empty>nothing looks like noise</Empty>}
    </Card>

    <Card title="everyone else" aside={left(rest).length > 0 && <span className="count">{left(rest).length} senders</span>}>
      {rest.length
        ? <>
          <ul className="rows">{shown.map((group) => <SenderRow key={group.address} group={group} onError={onError} actions={actions} />)}</ul>
          {rest.length > shown.length && <div className="actions"><button className="link" type="button" onClick={() => setShowAll(true)}>show all {rest.length}</button></div>}
        </>
        : <Empty>no one else</Empty>}
    </Card>

    <div className="actions"><button className="plain" type="button" disabled={Boolean(state.working)} onClick={() => void actions.scan()}>read again</button></div>
  </>
}
