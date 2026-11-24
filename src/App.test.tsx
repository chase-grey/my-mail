import { afterEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import App from './App'
import { InboxView } from './views/InboxView'
import { SearchView } from './views/SearchView'
import { message } from './domain/fixtures'
import type { MessageActions } from './App'

afterEach(() => vi.unstubAllGlobals())

it('renders the connect step before anything else when signed out', () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  const html = renderToStaticMarkup(<App />)
  expect(html).toContain('>inbox<')
  expect(html).toMatch(/connect microsoft|no microsoft app id/)
  expect(html).not.toContain('class="mail"')
})

it('shows triaged mail with the suggested action highlighted and kept mail folded away', () => {
  const noop = async () => {}
  const actions: MessageActions = { archive: noop, archiveAll: noop, remove: noop, task: noop, compose: () => {}, draft: async () => '', snooze: noop, isReceipt: () => false, keep: noop, flag: noop, unsubscribe: async () => '', makeRule: noop, restore: noop }
  const items = [
    { message: message('m1', 'mom@example.com', 'Dinner Sunday?'), triage: { messageId: 'm1', category: 'reply' as const, summary: 'mom asks about sunday dinner', needsReply: true, suggested: 'reply' as const, draft: 'Yes!', confidence: 0.9, source: 'model' as const, triagedAt: 'now' } },
    { message: message('m2', 'news@daily.example.com', 'Daily digest'), triage: { messageId: 'm2', category: 'newsletter' as const, summary: 'daily digest', needsReply: false, suggested: 'archive' as const, confidence: 0.9, source: 'jev' as const, triagedAt: 'now' } },
    { message: message('m3', 'kept@example.com', 'Keep me') },
  ]
  const html = renderToStaticMarkup(<InboxView items={items} kept={{ m3: 'now' }} summary={{ inbox: 3, needReply: 1, byRules: 2, autoArchived: 0, returned: 0, withoutModel: 1 }} connection="connected" suggestions={[{ from: 'news@daily.example.com', action: 'archive', count: 3 }]} snoozes={[]} actions={actions} onConnect={noop} onDismissSuggestion={() => {}} />)
  expect(html).not.toContain('in inbox ·')
  expect(html).toContain('mom asks about sunday dinner')
  expect(html).not.toContain('is-loud')
  expect(html).toMatch(/class="quick is-suggested"[^>]*>reply</)
  expect(html).toContain('archive everything from news@daily.example.com')
  expect(html).toContain('1 kept in inbox')
  expect(html.indexOf('Dinner Sunday?')).toBeLessThan(html.indexOf('Daily digest'))
  expect(html).toContain('needs me <span class="group-count">1</span>')
  expect(html).not.toContain('probably fine')
  expect(html).toContain('newsletter · ')
  // The body and the rest of the actions stay folded away until a row is opened.
  expect(html).not.toContain('90% sure')
  expect(html).not.toContain('class="mail-body"')
  expect(html).not.toContain('archive all')
})

it('offers one search field, with find or ask only when there is a model', () => {
  vi.stubGlobal('localStorage', { getItem: () => '["property tax"]', setItem: () => {} })
  const noop = async () => {}
  const actions: MessageActions = { archive: noop, archiveAll: noop, remove: noop, task: noop, compose: () => {}, draft: async () => '', snooze: noop, isReceipt: () => false, keep: noop, flag: noop, unsubscribe: async () => '', makeRule: noop, restore: noop }
  const search = { find: async () => ({ hits: [] }), more: async () => ({ hits: [] }), translate: async () => '', answer: async () => '' }
  const withModel = renderToStaticMarkup(<SearchView search={search} actions={actions} hasModel />)
  expect(withModel).toContain('placeholder="search or ask"')
  expect(withModel).toMatch(/aria-pressed="true"[^>]*>find</)
  expect(withModel).toContain('>ask<')
  expect(withModel).toContain('>property tax<')
  const without = renderToStaticMarkup(<SearchView search={search} actions={actions} hasModel={false} />)
  expect(without).toContain('placeholder="search"')
  expect(without).not.toContain('>ask<')
})
