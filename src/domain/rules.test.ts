import { describe, expect, it } from 'vitest'
import { applyRules, matchesRule, newRule, recordHits, rememberDecision, senderDomain, suggestRules } from './rules'
import { message } from './fixtures'
import type { Decision, Rule } from './types'


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
    const hits = applyRules([message('m1', 'deals@shop.example.com', 'sale'), message('m2', 'mom@example.com', 'dinner'), message('m3', 'promo@other.example', 'big sale')], rules)
    expect(hits.map((hit) => [hit.message.id, hit.rule.id])).toEqual([['m1', 'a'], ['m3', 'b']])
    expect(recordHits(rules, hits).map((item) => item.hits)).toEqual([1, 1])
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

  it('builds a rule from a form, trimming blanks away', () => {
    expect(newRule({ from: ' deals@shop.example.com ', subject: '  ', action: 'archive' }, 'id', 'now')).toEqual({ id: 'id', from: 'deals@shop.example.com', subject: undefined, action: 'archive', enabled: true, createdAt: 'now', hits: 0 })
    expect(senderDomain('Deals@Shop.Example.com')).toBe('@shop.example.com')
  })
})
