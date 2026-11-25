import { expect, it } from 'vitest'
import type { InboxThread } from '../domain/threads'
import type { Message } from '../domain/types'
import { mailActs } from './InboxView'

const message = (id: string, address: string, recipients = 1): Message => ({ id, subject: 'hi', from: { name: address, address }, receivedAt: '2026-11-25T10:00:00Z', preview: '', body: '', isRead: true, flagged: false, importance: 'normal', hasAttachments: false, recipients, categories: [], webLink: '' })
const thread = (...all: Message[]) => ({ key: all[0].id, message: all[0], all, needsMe: false }) as InboxThread
const on = new Proxy({}, { get: () => () => {} }) as Parameters<typeof mailActs>[1]
const many = { archive: () => {}, task: () => {}, snooze: () => {}, remove: () => {} }
const labels = (list: InboxThread[]) => { const acts = mailActs(list, on, many); return [acts.main.map((act) => act.label), acts.rest.map((act) => act.label)] }

it('always lists the actions in one order', () => {
  expect(labels([thread(message('a', 'one@example.com'))])).toEqual([['reply', 'to do', 'snooze', 'archive', 'archive + rule'], ['reply all', 'forward', 'delete', 'archive everything else']])
})

it('leads with reply all when more than one other person is on the mail', () => {
  expect(labels([thread(message('a', 'one@example.com', 3))])[0][0]).toBe('reply all')
  const chain = labels([thread(message('a', 'one@example.com'), message('b', 'two@example.com'))])
  expect(chain[0][0]).toBe('reply all')
  expect(chain[1][0]).toBe('reply')
})

it('turns off what needs one conversation when several are highlighted', () => {
  const acts = mailActs([thread(message('a', 'one@example.com')), thread(message('b', 'two@example.com'))], on, many)
  expect([...acts.main, ...acts.rest].filter((act) => act.disabled).map((act) => act.label)).toEqual(['reply', 'archive + rule', 'reply all', 'forward', 'archive everything else'])
})
