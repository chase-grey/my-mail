import { useEffect, useRef, type ReactNode } from 'react'

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
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
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

export type IconName = 'more' | 'refresh' | 'back'

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  switch (name) {
    case 'more':
      return <svg {...common}><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" /></svg>
    case 'refresh':
      return <svg {...common}><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v5h-5" /></svg>
    case 'back':
      return <svg {...common}><path d="M15 5l-7 7 7 7" /></svg>
  }
}
