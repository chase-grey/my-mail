import type { ReactNode } from 'react'
import { Icon, Menu, type IconName } from '../ui'

export type View = 'inbox' | 'cleanup' | 'rules' | 'settings'
export type ShellLink = { label: string; onSelect: () => void }

export const viewLabel: Record<View, string> = { inbox: 'inbox', cleanup: 'clean up', rules: 'rules', settings: 'settings' }
const viewIcon: Record<View, IconName> = { inbox: 'inbox', cleanup: 'clean', rules: 'rules', settings: 'settings' }

/** The frame around every screen: a side rail on wide screens, a top bar with a menu on a phone. */
export function Shell({ view, views, busy, canRefresh, links, onView, onRefresh, children }: {
  view: View
  views: View[]
  busy: boolean
  canRefresh: boolean
  links: ShellLink[]
  onView: (view: View) => void
  onRefresh: () => void
  children: ReactNode
}) {
  return <div className="shell">
    <nav className="rail" aria-label="screens">
      {views.map((item) => <button key={item} type="button" className={item === view ? 'is-current' : ''} aria-current={item === view ? 'page' : undefined} onClick={() => onView(item)}><Icon name={viewIcon[item]} size={18} />{viewLabel[item]}</button>)}
      <div className="rail-links">
        {links.map((link) => <button key={link.label} type="button" onClick={link.onSelect}><Icon name="out" size={18} />{link.label}</button>)}
      </div>
    </nav>
    <div className="main">
      <header className="topbar">
        {view !== 'inbox' && <button className="back icon-button" type="button" aria-label="back to inbox" onClick={() => onView('inbox')}><Icon name="back" /></button>}
        <h1>{viewLabel[view]}</h1>
        {view === 'inbox' && <button className={`icon-button${busy ? ' is-spinning' : ''}`} type="button" aria-label="check mail" title="check mail" disabled={!canRefresh} onClick={onRefresh}><Icon name="refresh" /></button>}
        <Menu items={[
          ...views.filter((item) => item !== view && item !== 'inbox').map((item) => ({ label: viewLabel[item], onSelect: () => onView(item) })),
          ...links,
        ]} />
      </header>
      <div className={`progress${busy ? ' is-busy' : ''}`} aria-hidden="true" />
      <div className={`content is-${view}`} key={view}>{children}</div>
    </div>
  </div>
}
