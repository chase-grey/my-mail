import { APP_BUILD_TIME, APP_COMMIT, checkForUpdate, useAppUpdate } from '../appUpdate'
import { modelOptions, type Settings } from '../settings'
import { Card, Field, Switch } from '../ui'
import { AccentPicker } from './AccentPicker'

export type ConnectionStatus = 'unconfigured' | 'disconnected' | 'connected'

export function SettingsView({ settings, connection, accountName, busy, error, onSettings, onConnect, onDisconnect }: {
  settings: Settings
  connection: ConnectionStatus
  accountName?: string
  busy: boolean
  error?: string
  onSettings: React.Dispatch<React.SetStateAction<Settings>>
  onConnect: () => Promise<void>
  onDisconnect: () => Promise<void>
}) {
  const set = <K extends keyof Settings>(key: K) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    onSettings((current) => ({ ...current, [key]: event.target.value }))
  const toggle = (key: 'autoArchive' | 'archiveAfterReply' | 'writeCategories' | 'fileReceipts' | 'aiSorting') => (value: boolean) => onSettings((current) => ({ ...current, [key]: value }))

  const update = useAppUpdate()

  return <>
    <Card title="microsoft account">
      {connection === 'connected'
        ? <><p className="note">{accountName}</p><div className="actions"><button className="plain" disabled={busy} type="button" onClick={() => void onDisconnect()}>disconnect</button></div></>
        : <div className="actions"><button className="primary" disabled={busy || connection === 'unconfigured'} type="button" onClick={() => void onConnect()}>{connection === 'unconfigured' ? 'no microsoft app id' : busy ? 'connecting' : 'connect microsoft'}</button></div>}
      {error && <p className="note is-error" role="alert">{error}</p>}
    </Card>

    <Card title="ai">
      <div className="stack">
        <Field label="anthropic api key"><input type="password" autoComplete="off" value={settings.anthropicApiKey} onChange={set('anthropicApiKey')} /></Field>
        <Field label="jev api key"><input type="password" autoComplete="off" value={settings.jevApiKey} onChange={set('jevApiKey')} /></Field>
        <div className="grid-2">
          <Field label="reading"><select value={settings.anthropicModel} onChange={set('anthropicModel')}>{modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}</select></Field>
          <Field label="better drafts"><select value={settings.strongModel} onChange={set('strongModel')}>{modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}</select></Field>
        </div>
        <Switch label="sort mail with ai" checked={settings.aiSorting === true} onChange={toggle('aiSorting')} />
        <Field label="about me, for replies"><textarea value={settings.aboutMe} placeholder="who you are, how you sign off, what you usually say yes and no to" onChange={set('aboutMe')} /></Field>
      </div>
    </Card>

    <Card title="mail">
      <div className="stack">
        <Switch label="write each verdict to the message as an outlook category" checked={settings.writeCategories} onChange={toggle('writeCategories')} />
        <Switch label="archive newsletters, promos, and receipts it is sure about and make rules for them" checked={settings.autoArchive} onChange={toggle('autoArchive')} />
        <Switch label="move receipts to their own folder" checked={settings.fileReceipts} onChange={toggle('fileReceipts')} />
        <Switch label="archive after sending a reply" checked={settings.archiveAfterReply} onChange={toggle('archiveAfterReply')} />
      </div>
    </Card>

    <Card title="links">
      <div className="stack">
        <Field label="my brain"><input autoComplete="off" inputMode="url" value={settings.brainUrl} onChange={set('brainUrl')} /></Field>
      </div>
    </Card>

    <Card title="color">
      <AccentPicker />
    </Card>

    <Card title="app">
      <p className="note">build {APP_COMMIT} · {new Date(APP_BUILD_TIME).toLocaleString()}</p>
      <div className="actions"><button className={update.ready ? 'primary' : 'secondary'} disabled={update.checking} type="button" onClick={() => void checkForUpdate()}>{update.checking ? 'checking…' : update.ready ? 'update ready · restart' : 'check for updates'}</button></div>
    </Card>
  </>
}
