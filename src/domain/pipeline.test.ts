import { describe, expect, it } from 'vitest'
import { describeGroup, groupBySender, keepSenderKinds, likelyNoise, oldMail, sendersToAsk, type ScanMessage } from './cleanup'
import { codeWords } from './codes'
import { message } from './fixtures'
import { historyTriage, noiseSenders, senderHistoryLine } from './history'
import { compilable, compileRule, describeOutlookRule, outlookRuleName, planRuleSync } from './outlookRules'
import { rememberDecision } from './rules'
import { trimForModel } from './text'
import type { Decision, OutlookRule, Rule } from './types'
import { parseUnsubscribe, unsubscribeMail, unsubscribeMethod } from './unsubscribe'

const rule = (id: string, extra: Partial<Rule>): Rule => ({ id, action: 'archive', enabled: true, createdAt: 'then', hits: 0, ...extra })
const outlook = (id: string, displayName: string, isEnabled = true, marksRead = true): OutlookRule => ({ id, displayName, isEnabled, sequence: 1, marksRead, sparesCodes: true, description: '' })

describe('text for the model', () => {
  it('drops quoted history, mailing footers, and raw links, then caps', () => {
    const body = ['Sunday at 6?', 'See https://example.com/x for the menu', '', 'On Mon, Nov 2, 2026 Chase wrote:', '> earlier words', '> more'].join('\n')
    expect(trimForModel(body)).toBe('Sunday at 6?\nSee [link] for the menu')
    expect(trimForModel('Start a return<https://example.com/r?id=1> today, or see <https://example.com/help>.')).toBe('Start a return today, or see [link].')
    const promo = ['20% off everything', '', 'Unsubscribe here', 'You are receiving this because you signed up'].join('\n')
    expect(trimForModel(promo)).toBe('20% off everything')
    expect(trimForModel('> only a quote\nthen text')).toBe('> only a quote\nthen text')
    expect(trimForModel('a'.repeat(50), 10)).toBe(`${'a'.repeat(10)}…`)
  })
})

describe('sender history', () => {
  const decisions: Decision[] = [
    { messageId: '1', from: 'news@daily.example.com', action: 'archive', at: 't', unread: true },
    { messageId: '2', from: 'news@daily.example.com', action: 'archive', at: 't', unread: true },
    { messageId: '3', from: 'news@daily.example.com', action: 'delete', at: 't', unread: true },
    { messageId: '4', from: 'mom@example.com', action: 'archive', at: 't', unread: true },
    { messageId: '5', from: 'mom@example.com', action: 'archive', at: 't' },
    { messageId: '6', from: 'mom@example.com', action: 'reply', at: 't' },
  ]

  it('settles unread mail from senders I always clear unread, and nothing else', () => {
    const noise = noiseSenders(decisions)
    expect([...noise]).toEqual(['news@daily.example.com'])
    expect(historyTriage(message('m1', 'news@daily.example.com'), noise, 'now')).toMatchObject({ category: 'newsletter', source: 'history', suggested: 'archive', confidence: 0.9 })
    expect(historyTriage(message('m2', 'news@daily.example.com', 'x', { isRead: true }), noise, 'now')).toBeUndefined()
    expect(historyTriage(message('m3', 'news@daily.example.com', 'x', { flagged: true }), noise, 'now')).toBeUndefined()
    expect(historyTriage(message('m4', 'mom@example.com'), noise, 'now')).toBeUndefined()
  })

  it('writes one history line per sender and records whether a decision was made unread', () => {
    expect(senderHistoryLine(decisions, 'MOM@example.com')).toBe('history with sender: replied 1, archived 2')
    expect(senderHistoryLine(decisions, 'news@daily.example.com')).toBe('history with sender: archived 2 unread, deleted 1')
    expect(senderHistoryLine(decisions, 'nobody@example.com')).toBe('')
    expect(rememberDecision([], message('m1', 'a@example.com'), 'archive', 'now')[0].unread).toBe(true)
    expect(rememberDecision([], message('m1', 'a@example.com', 'x', { isRead: true }), 'archive', 'now')[0].unread).toBeUndefined()
  })
})

describe('outlook rules', () => {
  it('compiles archive, delete, and read rules and leaves flag and task in the app', () => {
    expect(compilable(rule('a', { from: '@shop.example.com' }))).toBe(true)
    expect(compilable(rule('b', { subject: 'statement', action: 'read' }))).toBe(true)
    expect(compilable(rule('c', { from: 'x', action: 'flag' }))).toBe(false)
    expect(compilable(rule('d', { from: 'x', action: 'task' }))).toBe(false)
    expect(compilable(rule('e', {}))).toBe(false)
    const body = compileRule(rule('a', { from: '@shop.example.com', subject: 'sale' }), 'archive-id', 3)
    expect(body).toEqual({ displayName: 'my mail: archive anyone @shop.example.com and subject has “sale”', sequence: 3, isEnabled: true, conditions: { senderContains: ['@shop.example.com'], subjectContains: ['sale'] }, actions: { moveToFolder: 'archive-id', markAsRead: true, stopProcessingRules: true }, exceptions: { bodyOrSubjectContains: codeWords } })
    expect(compilable(rule('f', { from: 'x', action: 'receipts' }))).toBe(true)
    expect(compileRule(rule('f', { from: 'orders@shop.example.com', action: 'receipts' }), 'receipts-id', 2)).toMatchObject({ displayName: 'my mail: move to receipts from orders@shop.example.com', actions: { moveToFolder: 'receipts-id', markAsRead: true, stopProcessingRules: true } })
    expect(compileRule(rule('b', { from: 'x', action: 'delete' }), 'archive-id', 1).actions).toEqual({ delete: true, stopProcessingRules: true })
    expect(compileRule(rule('c', { from: 'x', action: 'read' }), 'archive-id', 1).actions).toEqual({ markAsRead: true, stopProcessingRules: true })
  })

  it('plans creates, updates, removals, and drops rules deleted in outlook', () => {
    const rules = [
      rule('new', { from: '@a.example.com' }),
      rule('same', { from: '@b.example.com', outlookId: 'o-same' }),
      rule('renamed', { from: '@c.example.com', outlookId: 'o-renamed', enabled: false }),
      rule('gone', { from: '@d.example.com', outlookId: 'o-gone' }),
      rule('unread', { from: '@f.example.com', outlookId: 'o-unread' }),
      rule('flag', { from: '@e.example.com', action: 'flag', outlookId: 'o-flag' }),
    ]
    const plan = planRuleSync(rules, [
      outlook('o-same', outlookRuleName(rules[1])),
      outlook('o-renamed', outlookRuleName(rules[2]), true),
      // Written before archiving marked mail read: rewritten so it does.
      outlook('o-unread', 'my mail: archive from @f.example.com', true, false),
      outlook('o-orphan', 'my mail: archive from nobody'),
      outlook('o-flag', 'my mail: flag from @e.example.com'),
      outlook('o-theirs', 'Bank alerts'),
    ])
    expect(plan.create.map((item) => item.id)).toEqual(['new'])
    expect(plan.update.map((item) => item.id)).toEqual(['renamed', 'unread'])
    expect(plan.remove.sort()).toEqual(['o-flag', 'o-orphan'])
    expect(plan.dropped).toEqual(['gone'])
    expect(plan.foreign.map((item) => item.displayName)).toEqual(['Bank alerts'])
  })

  it('describes a rule made in outlook from its parts', () => {
    expect(describeOutlookRule({ displayName: 'x', conditions: { fromAddresses: [{ emailAddress: { address: 'bank@example.com' } }], subjectContains: ['alert'] }, actions: { moveToFolder: 'id', markAsRead: true, stopProcessingRules: true } })).toBe('from addresses bank@example.com, subject contains alert → move to folder, mark as read')
    expect(describeOutlookRule({ displayName: 'empty' })).toBe('empty')
  })
})

describe('unsubscribe', () => {
  it('reads one-click, mailto, and page targets from the headers and picks the quietest', () => {
    const headers = [
      { name: 'List-Unsubscribe', value: '<mailto:leave@list.example.com?subject=unsub%20me>, <https://list.example.com/u/1>' },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
    ]
    const target = parseUnsubscribe(headers)!
    expect(target.oneClick).toBe('https://list.example.com/u/1')
    expect(target.mailto).toEqual({ to: 'leave@list.example.com' })
    expect(unsubscribeMethod(target)).toBe('one-click')
    const pageOnly = parseUnsubscribe([{ name: 'list-unsubscribe', value: '<https://x.example.com/bye>' }])!
    expect(pageOnly).toEqual({ url: 'https://x.example.com/bye' })
    expect(unsubscribeMethod(pageOnly)).toBe('page')
    expect(unsubscribeMethod({ mailto: { to: 'a@b.c' } })).toBe('mail')
    expect(parseUnsubscribe([{ name: 'Subject', value: 'hi' }])).toBeUndefined()
  })

  it('takes only the address from a mailto, and always sends the same words', () => {
    const mailto = (value: string) => parseUnsubscribe([{ name: 'List-Unsubscribe', value: `<${value}>` }])?.mailto
    // The sender's subject and body never leave this mailbox.
    expect(mailto('mailto:leave@list.example.com?subject=I%20agree%20to%20pay&body=wire%20the%20money')).toEqual({ to: 'leave@list.example.com' })
    expect(mailto('MAILTO:leave%40list.example.com')).toEqual({ to: 'leave@list.example.com' })
    expect(unsubscribeMail).toEqual({ subject: 'unsubscribe', body: '' })
    // More than one recipient, by any route, is refused outright.
    for (const value of [
      'mailto:leave@list.example.com,boss@work.example.com',
      'mailto:leave@list.example.com%2Cboss@work.example.com',
      'mailto:leave@list.example.com;boss@work.example.com',
      'mailto:leave@list.example.com?cc=boss@work.example.com',
      'mailto:leave@list.example.com?subject=x&BCC=boss@work.example.com',
      'mailto:leave@list.example.com?to=boss@work.example.com',
      'mailto:?to=boss@work.example.com',
      'mailto:Boss <boss@work.example.com>',
      'mailto:not-an-address',
      'mailto:%E0%A4%A',
    ]) expect(mailto(value), value).toBeUndefined()
    // A refused mailto leaves the page, when there is one.
    expect(parseUnsubscribe([{ name: 'List-Unsubscribe', value: '<mailto:a@list.example.com?cc=b@work.example.com>, <https://list.example.com/bye>' }])).toEqual({ url: 'https://list.example.com/bye' })
  })

  it('follows only https, for the one-click post and for the page', () => {
    const post = { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }
    expect(parseUnsubscribe([{ name: 'List-Unsubscribe', value: '<http://list.example.com/u/1>' }, post])).toBeUndefined()
    expect(parseUnsubscribe([{ name: 'List-Unsubscribe', value: '<http://list.example.com/u/1>' }])).toBeUndefined()
    expect(parseUnsubscribe([{ name: 'List-Unsubscribe', value: '<http://list.example.com/u/1>, <mailto:leave@list.example.com>' }, post])).toEqual({ mailto: { to: 'leave@list.example.com' } })
    expect(parseUnsubscribe([{ name: 'List-Unsubscribe', value: '<http://list.example.com/u/1>, <https://list.example.com/u/2>' }, post])).toEqual({ oneClick: 'https://list.example.com/u/2' })
    expect(parseUnsubscribe([{ name: 'List-Unsubscribe', value: '<javascript:alert(1)>, <data:text/html,x>' }, post])).toBeUndefined()
  })
})

describe('cleanup', () => {
  const scan = (id: string, address: string, isRead: boolean, receivedAt: string, flagged = false): ScanMessage => ({ id, from: { name: address.split('@')[0], address }, subject: 's', preview: 'p', receivedAt, isRead, flagged })
  const messages = [
    scan('1', 'news@daily.example.com', false, '2026-10-01T00:00:00Z'),
    scan('2', 'news@daily.example.com', false, '2026-10-05T00:00:00Z'),
    scan('3', 'news@daily.example.com', false, '2026-09-01T00:00:00Z'),
    scan('4', 'mom@example.com', true, '2026-09-20T00:00:00Z'),
    scan('5', 'mom@example.com', true, '2026-11-01T00:00:00Z', true),
    scan('6', 'bank@example.com', true, '2026-08-01T00:00:00Z'),
  ]

  it('groups by sender, biggest first, with the newest message as the sample', () => {
    const groups = groupBySender(messages)
    expect(groups.map((group) => group.address)).toEqual(['news@daily.example.com', 'mom@example.com', 'bank@example.com'])
    expect(groups[0]).toMatchObject({ count: 3, unread: 3, latest: '2026-10-05T00:00:00Z', oldest: '2026-09-01T00:00:00Z' })
    expect(groups[0].sample.id).toBe('2')
    expect(describeGroup(groups[1])).toBe('2 messages · 1 flagged')
  })

  it('calls a sender noise when I never open them or a classifier says so, never when flagged', () => {
    const [news, mom, bank] = groupBySender(messages)
    expect(likelyNoise(news)).toBe(true)
    expect(likelyNoise(mom)).toBe(false)
    expect(likelyNoise(bank)).toBe(false)
    expect(likelyNoise({ ...bank, kind: 'notification', kindConfidence: 0.8 })).toBe(true)
    expect(likelyNoise({ ...bank, kind: 'notification', kindConfidence: 0.5 })).toBe(false)
    expect(likelyNoise({ ...mom, kind: 'promo', kindConfidence: 0.99 })).toBe(false)
  })

  it('never calls a sender noise once I said it is not', () => {
    const [news, , bank] = groupBySender(messages)
    expect(likelyNoise(news, [news.address])).toBe(false)
    expect(likelyNoise({ ...bank, kind: 'newsletter', kindConfidence: 0.95 }, [bank.address])).toBe(false)
    expect(likelyNoise(news, [bank.address])).toBe(true)
  })

  it('takes all mail older than the cutoff, unread included, and leaves what is flagged', () => {
    const old = oldMail(messages, 30, new Date('2026-11-04T00:00:00Z'))
    expect(old.ids.sort()).toEqual(['1', '3', '4', '6'])
    expect(old.unread).toBe(2)
    expect(old.flagged).toBe(0)
    expect(oldMail([...messages, scan('7', 'mom@example.com', false, '2026-01-01T00:00:00Z', true)], 30, new Date('2026-11-04T00:00:00Z'))).toMatchObject({ unread: 2, flagged: 1 })
    expect(oldMail(messages, 30, new Date('2026-09-10T00:00:00Z')).ids).toEqual(['6'])
  })

  it('asks about a sender once, and forgets senders that have left the inbox', () => {
    const groups = groupBySender(messages)
    const repeat = groups.filter((group) => group.count >= 2)
    expect(repeat.length).toBeGreaterThan(0)
    expect(sendersToAsk(groups, {}).map((group) => group.address)).toEqual(repeat.map((group) => group.address))
    const known = { [repeat[0].address]: { kind: 'newsletter' as const, confidence: 0.9 }, 'gone@example.com': { kind: 'promo' as const, confidence: 0.8 } }
    expect(sendersToAsk(groups, known).map((group) => group.address)).toEqual(repeat.slice(1).map((group) => group.address))
    expect(Object.keys(keepSenderKinds(groups, known))).toEqual([repeat[0].address])
  })
})
