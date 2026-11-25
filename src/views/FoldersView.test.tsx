import { afterEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { message } from '../domain/fixtures'
import { FoldersView, lastFolder, rowName } from './FoldersView'
import { Shell } from './Shell'

afterEach(() => vi.unstubAllGlobals())

const actions = { load: async () => ({ messages: [], more: false }), toInbox: async () => {}, remove: async () => {}, putBack: async () => {}, compose: () => {} }

it('offers sent, drafts, archive, snoozed and deleted, and no junk', () => {
  vi.stubGlobal('localStorage', { getItem: () => 'archive', setItem: () => {} })
  const html = renderToStaticMarkup(<FoldersView actions={actions} />)
  for (const name of ['sent', 'drafts', 'archive', 'snoozed', 'deleted']) expect(html).toContain(`>${name}<`)
  expect(html).not.toMatch(/junk|spam/)
  expect(html).not.toContain('load more')
})

it('opens on the folder last looked at, and on sent the first time', () => {
  expect(lastFolder('archive')).toBe('archive')
  expect(lastFolder(null)).toBe('sent')
  expect(lastFolder('junk')).toBe('sent')
})

it('lists sent mail and drafts by who they are to, and the rest by who they are from', () => {
  const mail = { ...message('a', 'me@example.com'), from: { name: 'Me', address: 'me@example.com' }, to: [{ name: 'Mom', address: 'mom@example.com' }, { name: 'Dad', address: 'dad@example.com' }] }
  expect(rowName(mail, 'sent')).toBe('Mom +1')
  expect(rowName({ ...mail, to: [] }, 'drafts')).toBe('no recipient')
  expect(rowName(mail, 'archive')).toBe('Me')
  expect(rowName(mail, 'deleted')).toBe('Me')
})

it('has folders in the navigation', () => {
  const html = renderToStaticMarkup(<Shell view="inbox" views={['inbox', 'search', 'folders', 'receipts', 'settings']} busy={false} canRefresh links={[]} onView={() => {}} onRefresh={() => {}}>x</Shell>)
  expect(html).toContain('folders')
})
