import { useEffect, useState, type ReactNode } from 'react'
import { checkForUpdate, notePlace, takeResumePlace, useAppUpdate } from '../appUpdate'
import { Icon, Menu, Sheet, type IconName } from '../ui'
import { UpdateToast } from './UpdateToast'
import './update.css'

export type View = 'inbox' | 'search' | 'receipts' | 'cleanup' | 'rules' | 'settings'
export type ShellLink = { label: string; onSelect: () => void }

export const viewLabel: Record<View, string> = { inbox: 'inbox', search: 'search', receipts: 'receipts', cleanup: 'clean up', rules: 'rules', settings: 'settings' }
/** The screen an update reload left from, when it is still one of the screens. */
export function resumeView(): View | undefined {
  const place = takeResumePlace()
  return place && place in viewLabel ? (place as View) : undefined
}

const viewIcon: Record<View, IconName> = { inbox: 'inbox', search: 'search', receipts: 'receipt', cleanup: 'clean', rules: 'rules', settings: 'settings' }

/** Every key the app listens for. The inbox and the shell own the handlers; this is the one place they are listed. */
export const shortcuts: [string, string][] = [
  ['j', 'next'],
  ['k', 'previous'],
  ['e', 'archive'],
  ['r', 'reply'],
  ['t', 'to do'],
  ['s', 'snooze'],
  ['#', 'delete'],
  ['u', 'undo'],
  ['/', 'search'],
  ['?', 'shortcuts'],
]

/** The frame around every screen: a side rail on wide screens, a top bar with a menu on a phone. */
export function Shell({ view, views, counts = {}, busy, canRefresh, links, onView, onRefresh, children }: {
  view: View
  views: View[]
  counts?: Partial<Record<View, number>>
  busy: boolean
  canRefresh: boolean
  links: ShellLink[]
  onView: (view: View) => void
  onRefresh: () => void
  children: ReactNode
}) {
  const [keys, setKeys] = useState(false)
  const { ready: updateReady } = useAppUpdate()

  // An update reload comes back to the screen it left.
  useEffect(() => notePlace(view), [view])

  // `?` lists the keys from anywhere outside a text field.
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return
      if ((event.target as HTMLElement).closest?.('input, textarea, select, dialog')) return
      event.preventDefault()
      setKeys(true)
    }
    window.addEventListener('keydown', listen)
    return () => window.removeEventListener('keydown', listen)
  }, [])

  return <div className="shell">
    <nav className="rail" aria-label="screens">
      {views.map((item) => <button key={item} type="button" className={item === view ? 'is-current' : ''} aria-current={item === view ? 'page' : undefined} onClick={() => onView(item)}><Icon name={viewIcon[item]} size={18} />{viewLabel[item]}{counts[item] ? <span className="count">{counts[item]}</span> : null}{item === 'settings' && updateReady && <i className="update-dot" aria-hidden="true" />}</button>)}
      <div className="rail-links">
        <button type="button" onClick={() => setKeys(true)}><Icon name="keys" size={18} />shortcuts</button>
        {links.map((link) => <button key={link.label} type="button" onClick={link.onSelect}><Icon name="out" size={18} />{link.label}</button>)}
      </div>
    </nav>
    <div className="main">
      <header className="topbar">
        {view !== 'inbox' && <button className="back icon-button" type="button" aria-label="back to inbox" onClick={() => onView('inbox')}><Icon name="back" /></button>}
        <h1>{viewLabel[view]}</h1>
        {view === 'inbox' && views.includes('search') && <button className="icon-button to-search" type="button" aria-label="search" title="search" onClick={() => onView('search')}><Icon name="search" /></button>}
        {view === 'inbox' && <button className={`icon-button${busy ? ' is-spinning' : ''}`} type="button" aria-label="check mail" title="check mail" disabled={!canRefresh} onClick={onRefresh}><Icon name="refresh" /></button>}
        <Menu items={[
          ...(updateReady ? [{ label: 'update ready · restart', onSelect: () => void checkForUpdate() }] : []),
          ...views.filter((item) => item !== view && item !== 'inbox' && item !== 'search').map((item) => ({ label: viewLabel[item], onSelect: () => onView(item) })),
          ...links,
        ]}><Icon name="more" />{updateReady && <i className="update-dot" aria-hidden="true" />}</Menu>
      </header>
      <div className={`progress${busy ? ' is-busy' : ''}`} aria-hidden="true" />
      <div className={`content is-${view}`} key={view}>{children}</div>
    </div>
    <UpdateToast />
    {keys && <Sheet title="shortcuts" onClose={() => setKeys(false)}>
      <dl className="keys">{shortcuts.map(([key, does]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{does}</dd></div>)}</dl>
    </Sheet>}
  </div>
}
