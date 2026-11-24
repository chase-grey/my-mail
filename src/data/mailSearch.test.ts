import { expect, it, vi } from 'vitest'
import type { GraphClient } from './graphClient'
import { MailSearch, searchParam } from './mailSearch'

it('searches every folder, names the folder a hit is in, and reads the folder list once', async () => {
  const hit = (id: string, parentFolderId: string) => ({ id, receivedDateTime: '2026-11-02T15:00:00Z', isRead: true, webLink: 'w', parentFolderId })
  const request = vi.fn(async (path: string) => {
    if (path.startsWith('/me/mailFolders/inbox?')) return { id: 'inbox-id' }
    if (path.startsWith('/me/mailFolders?')) return { value: [{ id: 'inbox-id', displayName: 'Inbox' }, { id: 'archive-id', displayName: 'Archive' }] }
    if (path === 'next') return { value: [hit('c', 'nested-id')] }
    return { value: [hit('a', 'inbox-id'), hit('b', 'archive-id')], '@odata.nextLink': 'next' }
  })
  const search = new MailSearch({ request } as unknown as GraphClient)

  const page = await search.search('subject:"property tax" treasurer', 10)
  const path = request.mock.calls[0][0]
  const query = new URLSearchParams(path.split('?')[1])
  expect(path.startsWith('/me/messages?')).toBe(true)
  expect(query.get('$search')).toBe('"subject:\\"property tax\\" treasurer"')
  expect(query.get('$top')).toBe('10')
  expect(query.get('$select')).toContain('parentFolderId')
  expect(page.hits.map((item) => [item.message.id, item.inInbox, item.folder])).toEqual([['a', true, undefined], ['b', false, 'Archive']])

  const more = await search.more(page.next!)
  expect(more.hits.map((item) => [item.message.id, item.inInbox, item.folder])).toEqual([['c', false, undefined]])
  expect(more.next).toBeUndefined()
  expect(request.mock.calls.filter(([called]) => called.startsWith('/me/mailFolders'))).toHaveLength(2)
  expect(searchParam(' dinner ')).toBe('"dinner"')
})

it('asks the mailbox who matches a word, reading only who sent each message', async () => {
  const request = vi.fn(async (_path: string) => ({ value: [{ from: { emailAddress: { name: 'Ruth Okafor', address: 'ruth@example.com' } } }, {}, { from: { emailAddress: { address: 'ruiz@example.com' } } }] }))
  const found = await new MailSearch({ request } as unknown as GraphClient).senders('ru')
  const query = new URLSearchParams(request.mock.calls[0][0].split('?')[1])
  expect(query.get('$search')).toBe('"from:ru"')
  expect(query.get('$select')).toBe('from')
  expect(found).toEqual([{ name: 'Ruth Okafor', address: 'ruth@example.com' }, { name: '', address: 'ruiz@example.com' }])
})
