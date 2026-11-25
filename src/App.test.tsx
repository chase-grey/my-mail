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
  const actions: MessageActions = { archive: noop, archiveAll: async () => [], remove: noop, task: noop, compose: () => {}, draft: async () => '', snooze: noop, isReceipt: () => false, keep: noop, flag: noop, unsubscribe: async () => '', makeRule: noop, block: async () => undefined, restore: noop, restoreAll: noop }
  const items = [
    { message: message('m1', 'mom@example.com', 'Dinner Sunday?'), triage: { messageId: 'm1', category: 'reply' as const, summary: 'mom asks about sunday dinner', needsReply: true, suggested: 'reply' as const, draft: 'Yes!', confidence: 0.9, source: 'model' as const, triagedAt: 'now' } },
    { message: message('m2', 'news@daily.example.com', 'Daily digest'), triage: { messageId: 'm2', category: 'newsletter' as const, summary: 'daily digest', needsReply: false, suggested: 'archive' as const, confidence: 0.9, source: 'jev' as const, triagedAt: 'now' } },
    { message: message('m3', 'kept@example.com', 'Keep me') },
  ]
  const html = renderToStaticMarkup(<InboxView items={items} kept={{ m3: 'now' }} read connection="connected" snoozes={[]} actions={actions} onConnect={noop} />)
  expect(html).not.toContain('in inbox ·')
  expect(html).toContain('mom asks about sunday dinner')
  expect(html).not.toContain('is-loud')
  // Every row has the same two buttons in the same order; the verdict only marks one of them.
  expect(html.match(/class="quick[^"]*"[^>]*>[^<]+/g)?.map((button) => button.replace(/.*>/, ''))).toEqual(['archive', 'to do', 'archive', 'to do', 'archive', 'to do'])
  expect(html).toMatch(/class="quick is-suggested"[^>]*>archive</)
  expect(html).not.toMatch(/class="quick[^"]*"[^>]*>reply</)
  // Nothing sits above the list but needs me: rule suggestions live on the rules screen.
  expect(html).not.toContain('to add')
  expect(html).toContain('1 kept in inbox')
  expect(html.indexOf('Dinner Sunday?')).toBeLessThan(html.indexOf('Daily digest'))
  expect(html).toContain('needs me <span class="group-count">1</span>')
  expect(html).not.toContain('probably fine')
  expect(html).toContain('newsletter · ')
  // The body and the rest of the actions stay folded away until a row is opened.
  expect(html).not.toContain('90% sure')
  expect(html).not.toContain('class="mail-body"')
  // One button clears every row still in the list; kept mail is not counted among them.
  expect(html.match(/>archive all</g)).toHaveLength(1)
})

it('offers one search field, with find or ask only when there is a model', () => {
  vi.stubGlobal('localStorage', { getItem: () => '["property tax"]', setItem: () => {} })
  const noop = async () => {}
  const actions: MessageActions = { archive: noop, archiveAll: async () => [], remove: noop, task: noop, compose: () => {}, draft: async () => '', snooze: noop, isReceipt: () => false, keep: noop, flag: noop, unsubscribe: async () => '', makeRule: noop, block: async () => undefined, restore: noop, restoreAll: noop }
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

it('says inbox zero while a check is still running, once the inbox has been read here', () => {
  const noop = async () => {}
  const view = (props: { read?: boolean; connection?: 'starting' | 'connected' }) => renderToStaticMarkup(<InboxView items={[]} kept={{}} read={props.read} busy="checking mail" connection={props.connection ?? 'connected'} snoozes={[]} actions={{} as MessageActions} onConnect={noop} />)
  expect(view({ read: true })).toContain('inbox zero')
  // The spinning check mail button is the only sign of a check; the list says nothing.
  expect(view({ read: true })).not.toContain('checking mail')
  // Before the first read an empty list only means the mail has not come yet.
  expect(view({})).not.toContain('inbox zero')
})

it('does not ask to connect before the saved sign-in has been looked for', () => {
  const html = renderToStaticMarkup(<InboxView items={[]} kept={{}} connection="starting" snoozes={[]} actions={{} as MessageActions} onConnect={async () => {}} />)
  expect(html).not.toContain('connect microsoft')
})
