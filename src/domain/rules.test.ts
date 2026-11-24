import { describe, expect, it } from 'vitest'
import { applyRules, autoRuleSenders, matchesRule, newRule, recordHits, rememberDecision, retiredSenders, senderDomain, suggestRules } from './rules'
import { message } from './fixtures'
import type { Category, Decision, Rule, Triage } from './types'


const rule = (overrides: Partial<Rule>): Rule => ({ id: 'r', action: 'archive', enabled: true, createdAt: '2026-11-01T00:00:00Z', hits: 0, ...overrides })

describe('rules', () => {
  it('matches on sender substring and subject substring, case-insensitively', () => {
    const deals = message('m1', 'deals@Shop.example.com', 'Weekend SALE')
    expect(matchesRule(rule({ from: '@shop.example.com' }), deals)).toBe(true)
    expect(matchesRule(rule({ subject: 'sale' }), deals)).toBe(true)
    expect(matchesRule(rule({ from: '@shop.example.com', subject: 'invoice' }), deals)).toBe(false)
    expect(matchesRule(rule({ from: '@shop.example.com', enabled: false }), deals)).toBe(false)
    expect(matchesRule(rule({}), deals)).toBe(false)
  })

  it('applies the first matching rule per message and counts hits', () => {
    const rules = [rule({ id: 'a', from: 'deals@' }), rule({ id: 'b', subject: 'sale', action: 'delete' })]
    const hits = applyRules([message('m1', 'deals@shop.example.com', 'sale'), message('m2', 'mom@example.com', 'dinner'), message('m3', 'promo@other.example', 'big sale')], rules, '2026-11-10T00:00:00Z')
    expect(hits.map((hit) => [hit.message.id, hit.rule.id])).toEqual([['m1', 'a'], ['m3', 'b']])
    expect(recordHits(rules, hits).map((item) => item.hits)).toEqual([1, 1])
  })

  it('never flags old mail or makes a task of it, and still archives it', () => {
    const now = '2026-11-24T00:00:00Z'
    const rules = [rule({ id: 'task', from: 'school@', action: 'task' }), rule({ id: 'flag', from: 'bank@', action: 'flag' }), rule({ id: 'archive', from: 'deals@' })]
    const old = { receivedAt: '2021-06-17T09:00:00Z' }
    const recent = { receivedAt: '2026-11-20T09:00:00Z' }
    const hits = applyRules([
      message('m1', 'school@example.com', 'graduation', old), message('m2', 'bank@example.com', 'statement', old), message('m3', 'deals@example.com', 'sale', old),
      message('m4', 'school@example.com', 'conference', recent), message('m5', 'bank@example.com', 'statement', recent),
    ], rules, now)
    expect(hits.map((hit) => [hit.message.id, hit.rule.id])).toEqual([['m3', 'archive'], ['m4', 'task'], ['m5', 'flag']])
  })

  it('suggests a rule after the same sender was archived three times, unless a rule already covers it', () => {
    const at = '2026-11-02T10:00:00Z'
    let decisions: Decision[] = []
    for (const id of ['m1', 'm2', 'm3']) decisions = rememberDecision(decisions, message(id, 'News@Daily.example.com'), 'archive', at)
    decisions = rememberDecision(decisions, message('m4', 'mom@example.com'), 'archive', at)
    decisions = rememberDecision(decisions, message('m5', 'news@daily.example.com'), 'task', at)
    expect(suggestRules(decisions, [])).toEqual([{ from: 'news@daily.example.com', action: 'archive', count: 3 }])
    expect(suggestRules(decisions, [rule({ from: '@daily.example.com' })])).toEqual([])
  })

  it('replaces an earlier decision about the same message', () => {
    const at = '2026-11-02T10:00:00Z'
    const decisions = rememberDecision(rememberDecision([], message('m1', 'a@example.com'), 'keep', at), message('m1', 'a@example.com'), 'archive', at)
    expect(decisions).toHaveLength(1)
    expect(decisions[0].action).toBe('archive')
  })

  it('suggests a receipts rule for a sender whose archives went to the receipts folder', () => {
    let decisions: Decision[] = []
    for (const id of ['r1', 'r2', 'r3']) decisions = rememberDecision(decisions, message(id, 'orders@shop.example.com'), 'archive', 'now', undefined, true)
    expect(decisions[0].receipt).toBe(true)
    expect(suggestRules(decisions, [])).toEqual([{ from: 'orders@shop.example.com', action: 'receipts', count: 3 }])
  })

  it('builds a rule from a form, trimming blanks away', () => {
    expect(newRule({ from: ' deals@shop.example.com ', subject: '  ', action: 'archive' }, 'id', 'now')).toEqual({ id: 'id', from: 'deals@shop.example.com', subject: undefined, action: 'archive', enabled: true, createdAt: 'now', hits: 0 })
    expect(senderDomain('Deals@Shop.Example.com')).toBe('@shop.example.com')
  })
})

describe('rules the sorter makes', () => {
  const sure = (id: string, address: string, category: Category) => ({ message: message(id, address), triage: { messageId: id, category, summary: '', needsReply: false, suggested: 'archive', confidence: 0.95, source: 'jev', triagedAt: 'now' } satisfies Triage })
  const decision = (from: string, action: Decision['action']): Decision => ({ messageId: 'd', from, action, at: 'then' })

  it('gives one rule to each sender of an auto-archived newsletter, promo, or receipt', () => {
    const archived = [sure('m1', 'News@daily.example.com', 'newsletter'), sure('m2', 'news@daily.example.com', 'newsletter'), sure('m3', 'deals@shop.example.com', 'promo'), sure('m4', 'orders@shop.example.com', 'receipt'), sure('m5', 'alerts@bank.example.com', 'notification')]
    expect(autoRuleSenders(archived, { rules: [], decisions: [] }, [])).toEqual(['news@daily.example.com', 'deals@shop.example.com', 'orders@shop.example.com'])
  })

  it('skips senders with a rule, a deleted auto rule, mail I acted on, or mail still in the inbox', () => {
    const archived = [sure('m1', 'a@one.example.com', 'promo'), sure('m2', 'b@two.example.com', 'promo'), sure('m3', 'c@three.example.com', 'promo'), sure('m4', 'd@four.example.com', 'promo'), sure('m5', 'e@five.example.com', 'promo')]
    const state = { rules: [rule({ from: '@one.example.com', enabled: false })], decisions: [decision('c@three.example.com', 'reply'), decision('e@five.example.com', 'archive')], noRules: ['b@two.example.com'] }
    expect(autoRuleSenders(archived, state, [message('m9', 'D@four.example.com')])).toEqual(['e@five.example.com'])
  })

  it('remembers a sender whose auto rule was deleted, and only an auto rule', () => {
    const before = [rule({ id: 'a', from: 'News@daily.example.com', auto: true }), rule({ id: 'b', from: 'deals@shop.example.com' }), rule({ id: 'c', from: 'x@y.example.com', auto: true })]
    expect(retiredSenders(before, [before[2]], ['old@example.com'])).toEqual(['old@example.com', 'news@daily.example.com'])
    expect(retiredSenders(before, before, ['old@example.com'])).toEqual(['old@example.com'])
    expect(newRule({ from: 'a@b.example.com', action: 'archive', auto: true }, 'id', 'now').auto).toBe(true)
  })
})
