import { describe, expect, it } from 'vitest'
import { codeOf } from './codes'
import { message } from './fixtures'
import { historyTriage } from './history'
import { compileRule, outlookRuleName, planRuleSync } from './outlookRules'
import { applyRules, newRule } from './rules'
import { inboxThreads } from './threads'
import { autoArchivable, codeTriage, holdsCode, needsMe, rankTriaged } from './triage'
import type { Triage } from './types'

const now = '2026-11-25T12:00:00.000Z'
const recent = '2026-11-25T11:58:00.000Z'
const mail = (subject: string, body: string, extra = {}) => message('m1', 'notify@mail.notion.example.com', subject, { body, receivedAt: recent, ...extra })
const code = (subject: string, body = '') => codeOf({ subject, body, preview: '' })

describe('finding a code', () => {
  it('reads the code out of the subject or the text', () => {
    expect(code('Your Notion signup code is 482913')).toBe('482913')
    expect(code('482913 is your verification code')).toBe('482913')
    expect(code('Your temporary Notion login code', 'Hi,\n\nCopy and paste this temporary login code:\n\n482913\n\nIf you did not try to log in, you can ignore this email.')).toBe('482913')
    expect(code('Verify your sign-in', 'Your one-time code is 731 204. It expires in 10 minutes.')).toBe('731204')
    expect(code('Security code', 'Use security code G-551207 to finish signing in.')).toBe('551207')
    expect(code('Your verification code', 'Enter 7QK4M2 to continue.')).toBe('7QK4M2')
    expect(code('Confirm it is you', 'Please use the following verification code to finish signing in to your account. This code will expire in 10 minutes and can only be used once.\n\n9041')).toBe('9041')
  })

  it('takes the number nearest the words, not a year, price, time or phone number', () => {
    expect(code('Your login code', '© 2026 Example Inc. Your login code is 660318. Call 1 800 555 0199 with questions.')).toBe('660318')
    expect(code('Your access code', 'Paid $4500.00 at 10:30 on 2026-11-25. Your access code: 20931')).toBe('20931')
  })

  it('finds nothing in ordinary mail', () => {
    expect(code('Dinner Sunday?', 'Does five work? Call me on 555-0142.')).toBeUndefined()
    expect(code('Order 4100 confirmed', 'Order total $48.12. Paid with card ending 4417.')).toBeUndefined()
    expect(code('20% off through Sunday', 'Your code: SAVE20 at checkout. Ends 11/30.')).toBeUndefined()
    expect(code('Your statement is ready', 'Account ending 8841. No verification is needed.')).toBeUndefined()
    expect(code('New sign-in to your account', 'We noticed a new sign-in on November 25, 2026.')).toBeUndefined()
  })
})

describe('holding code mail', () => {
  const held = mail('Your Notion login code', 'Your login code is 482913.')
  const sure: Triage = { messageId: 'm1', category: 'notification', summary: '', needsReply: false, suggested: 'archive', confidence: 0.97, source: 'jev', triagedAt: now }

  it('needs me, whatever the sorter said', () => {
    expect(holdsCode(held, now)).toBe(true)
    expect(needsMe({ message: held, triage: sure }, now)).toBe(true)
    expect(needsMe({ message: held, pending: true }, now)).toBe(true)
    expect(inboxThreads([{ message: held, triage: sure }], now)[0].needsMe).toBe(true)
    const reply = message('m9', 'mom@example.com', 'Dinner?', { receivedAt: recent })
    expect(rankTriaged([{ message: reply, triage: { ...sure, messageId: 'm9', category: 'reply', needsReply: true, suggested: 'reply' } }, { message: held, triage: sure }], now)[0].message.id).toBe('m1')
  })

  it('is never archived by the sorter or by the sender\'s history', () => {
    expect(autoArchivable(held, sure)).toBe(false)
    expect(autoArchivable(mail('Statement ready', 'Your statement is ready.'), sure)).toBe(true)
    expect(historyTriage(held, new Set([held.from.address]), now)).toBeUndefined()
  })

  it('gets its verdict free, so no model is asked', () => {
    expect(codeTriage(held, now)).toMatchObject({ category: 'notification', suggested: 'keep', confidence: 1, source: 'code' })
    expect(codeTriage(mail('Statement ready', 'Your statement is ready.'), now)).toBeUndefined()
  })

  it('is passed over by rules that would take it away, and still marked read or flagged by the others', () => {
    const other = message('m2', held.from.address, 'What is new in Notion', { body: 'Three new features this month.', receivedAt: recent })
    for (const action of ['archive', 'receipts', 'delete', 'task'] as const) {
      const hits = applyRules([held, other], [newRule({ from: 'notion.example.com', action }, 'r', now)], now)
      expect(hits.map((hit) => hit.message.id)).toEqual(['m2'])
    }
    expect(applyRules([held], [newRule({ from: 'notion.example.com', action: 'read' }, 'r', now)], now)).toHaveLength(1)
  })

  it('lets go once the mail is old', () => {
    const old = mail('Your Notion login code', 'Your login code is 482913.', { receivedAt: '2026-09-01T12:00:00.000Z' })
    expect(holdsCode(old, now)).toBe(false)
    expect(needsMe({ message: old, triage: sure }, now)).toBe(false)
    expect(codeTriage(old, now)).toBeUndefined()
    expect(applyRules([old], [newRule({ from: 'notion.example.com', action: 'archive' }, 'r', now)], now)).toHaveLength(1)
  })
})

describe('outlook rules and code mail', () => {
  const archive = newRule({ from: '@notion.example.com', action: 'archive' }, 'a', now)
  const read = newRule({ from: '@notion.example.com', action: 'read' }, 'b', now)

  it('writes rules that take mail away with an exception for code mail', () => {
    expect(compileRule(archive, 'archive-id', 1).exceptions?.bodyOrSubjectContains).toContain('verification code')
    expect(compileRule({ ...archive, action: 'delete' }, 'archive-id', 1).exceptions?.bodyOrSubjectContains).toContain('login code')
    expect(compileRule(read, 'archive-id', 1).exceptions).toBeUndefined()
  })

  it('rewrites a rule written before the exception existed', () => {
    const rules = [{ ...archive, outlookId: 'o-a' }, { ...read, outlookId: 'o-b' }]
    const existing = (id: string, rule: typeof archive, sparesCodes: boolean) => ({ id, displayName: outlookRuleName(rule), isEnabled: true, sequence: 1, marksRead: true, sparesCodes, description: '' })
    expect(planRuleSync(rules, [existing('o-a', archive, false), existing('o-b', read, false)]).update.map((rule) => rule.id)).toEqual(['a'])
    expect(planRuleSync(rules, [existing('o-a', archive, true), existing('o-b', read, false)]).update).toEqual([])
  })
})
