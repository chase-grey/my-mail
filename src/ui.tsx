import { useEffect, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'

export function Card({ title, aside, children, className = '' }: { title?: ReactNode; aside?: ReactNode; children?: ReactNode; className?: string }) {
  return <section className={`card ${className}`.trim()}>
    {(title || aside) && <header className="card-head">{title && <h2>{title}</h2>}{aside}</header>}
    {children}
  </section>
}

export type MenuItem = { label: string; onSelect: () => void; disabled?: boolean; danger?: boolean }

export function Menu({ label = 'more', items, align = 'end', children }: { label?: string; items: MenuItem[]; align?: 'start' | 'end'; children?: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const element = details.current
    if (!element) return
    const close = (event: Event) => {
      if (!element.open || element.contains(event.target as Node)) return
      element.open = false
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') element.open = false }
    document.addEventListener('pointerdown', close)
    element.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); element.removeEventListener('keydown', escape) }
  }, [])
  return <details className={`menu menu-${align}`} ref={details}>
    <summary aria-label={label} title={label}>{children ?? <Icon name="more" />}</summary>
    <div className="menu-list" role="menu">
      {items.map((item) => <button key={item.label} role="menuitem" type="button" className={item.danger ? 'is-danger' : ''} disabled={item.disabled} onClick={() => { details.current!.open = false; item.onSelect() }}>{item.label}</button>)}
    </div>
  </details>
}

export function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return <div className="segmented" role="group" aria-label={label}>
    {options.map((option) => <button key={option.value} type="button" aria-pressed={value === option.value} className={value === option.value ? 'selected' : ''} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>
}

export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <button className="switch" type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span>{label}</span><i aria-hidden="true" /></button>
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog className="sheet" ref={dialog} aria-label={title} onCancel={onClose} onClose={onClose} onClick={(event) => { if (event.target === dialog.current) onClose() }}>
    <div className="sheet-body"><h2>{title}</h2>{children}</div>
  </dialog>
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}

/** Height that opens and closes smoothly. The content stays mounted just long enough to close. */
export function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) { setMounted(true); return }
    const timer = setTimeout(() => setMounted(false), exitMs)
    return () => clearTimeout(timer)
  }, [open])
  return <div className={`fold${open ? ' is-open' : ''}`}><div className="fold-clip">{(open || mounted) && children}</div></div>
}

export type ToastState = { key: number; text: string; undo?: () => void }

export function Toast({ toast, onDone }: { toast?: ToastState; onDone: () => void }) {
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => done.current(), 5000)
    return () => clearTimeout(timer)
  }, [toast])
  if (!toast) return null
  return <div className="toast" role="status" key={toast.key}>
    <span>{toast.text}</span>
    {toast.undo && <button type="button" onClick={toast.undo}>undo</button>}
  </div>
}

export const exitMs = 260

type Present<T> = { key: string; item: T; leaving: boolean; until: number }

/** Where a row that just left the list belongs among the rows that stayed: right after its nearest surviving predecessor. */
export function ghostIndex(previous: string[], index: number, next: string[]): number {
  for (let before = index - 1; before >= 0; before--) {
    const at = next.indexOf(previous[before])
    if (at >= 0) return at + 1
  }
  return 0
}

/** Keeps rows that left the list around for one exit animation, in the place they left from. */
export function usePresence<T>(items: T[], keyOf: (item: T) => string, ms = exitMs): { key: string; item: T; leaving: boolean }[] {
  const shown = useRef<Present<T>[]>([])
  const [, bump] = useReducer((count: number) => count + 1, 0)
  const now = Date.now()
  const next: Present<T>[] = items.map((item) => ({ key: keyOf(item), item, leaving: false, until: 0 }))
  const live = new Set(next.map((entry) => entry.key))
  const previous = shown.current
  const previousKeys = previous.map((entry) => entry.key)
  previous.forEach((entry, index) => {
    if (live.has(entry.key)) return
    const until = entry.leaving ? entry.until : now + ms
    if (until <= now) return
    next.splice(ghostIndex(previousKeys, index, next.map((item) => item.key)), 0, { ...entry, leaving: true, until })
  })
  shown.current = next
  const soonest = next.reduce((least, entry) => entry.leaving ? Math.min(least, entry.until) : least, Infinity)
  useEffect(() => {
    if (soonest === Infinity) return
    const timer = setTimeout(bump, Math.max(0, soonest - Date.now()) + 10)
    return () => clearTimeout(timer)
  }, [soonest])
  return next
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', notify)
      return () => list.removeEventListener('change', notify)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

export type IconName = 'more' | 'refresh' | 'back' | 'inbox' | 'clean' | 'rules' | 'settings' | 'out'

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  switch (name) {
    case 'more':
      return <svg {...common}><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" /></svg>
    case 'refresh':
      return <svg {...common}><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v5h-5" /></svg>
    case 'back':
      return <svg {...common}><path d="M15 5l-7 7 7 7" /></svg>
    case 'inbox':
      return <svg {...common}><path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M4 13h4.5a3.5 3.5 0 0 0 7 0H20" /></svg>
    case 'clean':
      return <svg {...common}><path d="M11 4l1.9 4.9L18 10.5l-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.6z" /><path d="M18.5 16v4M16.5 18h4" /></svg>
    case 'rules':
      return <svg {...common}><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>
    case 'settings':
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></svg>
    case 'out':
      return <svg {...common}><path d="M14 5h5v5M19 5l-8 8" /><path d="M11 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-5" /></svg>
  }
}
