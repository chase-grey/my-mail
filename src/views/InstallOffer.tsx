import { openInChrome, useInstallPrompt } from '../installPrompt'
import { Card } from '../ui'
import './install.css'

type Install = ReturnType<typeof useInstallPrompt>

/** Whether installing comes before connecting: there is a way to install from here, or it has just been done. */
export function hasInstallStep(install: Pick<Install, 'offer' | 'installed'>, skipped: boolean): boolean {
  return !skipped && (install.installed || install.offer !== null)
}

/** The one button that moves the install along: chrome's dialog where there is one, the way over to chrome where there isn't. */
function InstallButton({ install, label }: { install: Install; label: string }) {
  return install.offer === 'prompt'
    ? <button className="primary" type="button" onClick={() => void install.install()}>{label}</button>
    : <button className="primary" type="button" onClick={openInChrome}>open in chrome</button>
}

/**
 * What a browser tab shows ahead of "connect microsoft". On android the browser's storage is the
 * installed app's, so nothing done in the tab is lost; an iPhone gives the installed app storage of
 * its own, so connecting in the tab first would only have to be done again.
 */
export function InstallStep({ install, onSkip }: { install: Install; onSkip: () => void }) {
  const ios = install.offer === 'ios'
  return <div className="lone"><Card title={ios ? 'install first' : 'install my mail'}>
    {install.installed
      ? <p className="note" role="status">installed. open my mail from your apps</p>
      : ios
        ? <ol className="install-steps">
          <li>tap share</li>
          <li>add to home screen</li>
          <li>open my mail from the home screen</li>
        </ol>
        : <div className="actions"><InstallButton install={install} label="install app" /></div>}
    <div className="actions"><button className="plain" type="button" onClick={onSkip}>{ios ? 'continue in the browser' : 'skip'}</button></div>
  </Card></div>
}

/** The same offer once connected, on the inbox, until it is installed or waved off. */
export function InstallBanner({ install }: { install: Install }) {
  if (install.installed) return <div className="install-banner"><span>installed. open my mail from your apps</span></div>
  if (!install.offer) return null
  return <div className="install-banner">
    {install.offer === 'ios'
      ? <span>share → add to home screen</span>
      : <><span>install my mail</span><InstallButton install={install} label="install" /></>}
    <button className="icon-button" type="button" aria-label="dismiss" onClick={install.dismiss}>×</button>
  </div>
}
