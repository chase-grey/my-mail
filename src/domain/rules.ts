import type { Action, Decision, Message, Rule, RuleAction } from './types'

const normalize = (value: string) => value.trim().toLowerCase()

export function senderDomain(address: string): string {
  const at = address.lastIndexOf('@')
  return at >= 0 ? address.slice(at).toLowerCase() : address.toLowerCase()
}

export function matchesRule(rule: Rule, message: Message): boolean {
  if (!rule.enabled) return false
  if (!rule.from && !rule.subject) return false
  if (rule.from) {
    const needle = normalize(rule.from)
    const address = message.from.address.toLowerCase()
    const name = message.from.name.toLowerCase()
    if (!address.includes(needle) && !name.includes(needle)) return false
  }
  if (rule.subject && !message.subject.toLowerCase().includes(normalize(rule.subject))) return false
  return true
}

export type RuleHit = { message: Message; rule: Rule }

/** First enabled rule wins, in the order the rules are kept. */
export function applyRules(messages: Message[], rules: Rule[]): RuleHit[] {
  const hits: RuleHit[] = []
  for (const message of messages) {
    const rule = rules.find((candidate) => matchesRule(candidate, message))
    if (rule) hits.push({ message, rule })
  }
  return hits
}

export function recordHits(rules: Rule[], hits: RuleHit[]): Rule[] {
  const counts = new Map<string, number>()
  for (const hit of hits) counts.set(hit.rule.id, (counts.get(hit.rule.id) ?? 0) + 1)
  return counts.size ? rules.map((rule) => counts.has(rule.id) ? { ...rule, hits: rule.hits + counts.get(rule.id)! } : rule) : rules
}

export type RuleSuggestion = { from: string; action: RuleAction; count: number }

const suggestible: Record<string, RuleAction | undefined> = { archive: 'archive', delete: 'delete' }

/** After the same sender has been handled the same way a few times, offer to make it a rule. */
export function suggestRules(decisions: Decision[], rules: Rule[], minimum = 3): RuleSuggestion[] {
  const tally = new Map<string, { from: string; action: RuleAction; ids: Set<string> }>()
  for (const decision of decisions) {
    const action = suggestible[decision.action]
    if (!action || !decision.from) continue
    const from = decision.from.toLowerCase()
    const key = `${from}|${action}`
    const entry = tally.get(key) ?? { from, action, ids: new Set<string>() }
    entry.ids.add(decision.messageId)
    tally.set(key, entry)
  }
  return [...tally.values()]
    .filter((entry) => entry.ids.size >= minimum)
    .filter((entry) => !rules.some((rule) => rule.from && entry.from.includes(normalize(rule.from)) && !rule.subject))
    .map((entry) => ({ from: entry.from, action: entry.action, count: entry.ids.size }))
    .sort((a, b) => b.count - a.count)
}

export function rememberDecision(decisions: Decision[], message: Message, action: Action, at: string, keep = 400): Decision[] {
  const next = decisions.filter((decision) => decision.messageId !== message.id)
  next.push({ messageId: message.id, from: message.from.address.toLowerCase(), action, at, unread: !message.isRead || undefined })
  return next.slice(-keep)
}

export function newRule(input: { from?: string; subject?: string; action: RuleAction }, id: string, createdAt: string): Rule {
  return { id, from: input.from?.trim() || undefined, subject: input.subject?.trim() || undefined, action: input.action, enabled: true, createdAt, hits: 0 }
}

export function describeRule(rule: Rule): string {
  const parts = [rule.from && (rule.from.startsWith('@') ? `anyone ${rule.from}` : `from ${rule.from}`), rule.subject && `subject has “${rule.subject}”`].filter(Boolean)
  return parts.join(' and ')
}

export const ruleActionLabel: Record<RuleAction, string> = {
  archive: 'archive',
  delete: 'delete',
  read: 'mark read',
  task: 'make a task',
  flag: 'flag',
}
