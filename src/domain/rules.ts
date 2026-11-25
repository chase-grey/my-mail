import { holdsCode, isOld } from './triage'
import type { Action, Category, Decision, Message, Rule, RuleAction, Triage } from './types'

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

/**
 * First enabled rule wins, in the order the rules are kept. A rule never flags old mail or makes a task of it:
 * paging back through years of inbox must not fill To Do. Old mail still archives, files, and deletes by rule.
 * A rule never takes away mail with a sign-in code in it; it can still mark it read or flag it.
 */
export function applyRules(messages: Message[], rules: Rule[], now = new Date().toISOString()): RuleHit[] {
  const hits: RuleHit[] = []
  for (const message of messages) {
    const rule = rules.find((candidate) => matchesRule(candidate, message))
    if (rule && (rule.action === 'task' || rule.action === 'flag') && isOld(message, now)) continue
    if (rule && rule.action !== 'read' && rule.action !== 'flag' && holdsCode(message, now)) continue
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
export function suggestRules(decisions: Decision[], rules: Rule[], noRules: readonly string[] = [], minimum = 3): RuleSuggestion[] {
  const tally = new Map<string, { from: string; action: RuleAction; ids: Set<string> }>()
  for (const decision of decisions) {
    const action = decision.receipt && decision.action === 'archive' ? 'receipts' : suggestible[decision.action]
    if (!action || !decision.from) continue
    const from = decision.from.toLowerCase()
    const key = `${from}|${action}`
    const entry = tally.get(key) ?? { from, action, ids: new Set<string>() }
    entry.ids.add(decision.messageId)
    tally.set(key, entry)
  }
  return [...tally.values()]
    .filter((entry) => entry.ids.size >= minimum && !noRules.includes(entry.from))
    .filter((entry) => !rules.some((rule) => rule.from && entry.from.includes(normalize(rule.from)) && !rule.subject))
    .map((entry) => ({ from: entry.from, action: entry.action, count: entry.ids.size }))
    .sort((a, b) => b.count - a.count)
}

export function rememberDecision(decisions: Decision[], message: Message, action: Action, at: string, keep = 400, receipt = false): Decision[] {
  const next = decisions.filter((decision) => decision.messageId !== message.id)
  next.push({ messageId: message.id, from: message.from.address.toLowerCase(), action, at, unread: !message.isRead || undefined, receipt: receipt || undefined })
  return next.slice(-keep)
}

export function newRule(input: { from?: string; subject?: string; action: RuleAction; auto?: boolean }, id: string, createdAt: string): Rule {
  return { id, from: input.from?.trim() || undefined, subject: input.subject?.trim() || undefined, action: input.action, enabled: true, createdAt, hits: 0, auto: input.auto || undefined }
}

const clearing: RuleAction[] = ['archive', 'receipts', 'delete']

/** The rule already takes everything from this address out of the inbox, so blocking the sender again adds nothing. */
export function clearsSender(rule: Rule, address: string): boolean {
  return rule.enabled && clearing.includes(rule.action) && !rule.subject && Boolean(rule.from) && address.toLowerCase().includes(normalize(rule.from!))
}

/** Kinds that earn their sender a rule once the sorter is sure. Notifications stay out: the same address sends login codes and security alerts. */
export const ruleCategories: Category[] = ['newsletter', 'promo', 'receipt']

const engaged: Action[] = ['reply', 'task', 'keep', 'flag', 'snooze']

/**
 * Senders of mail that was just auto-archived who should get an archive rule, so Outlook clears the next one on arrival.
 * A sender is skipped when a rule already names them, when I deleted the rule made for them before,
 * when I have ever replied to, kept, flagged, snoozed, or made a task from their mail, or when other mail of theirs stayed in the inbox.
 */
export function autoRuleSenders(archived: { message: Message; triage: Triage }[], state: { rules: Rule[]; decisions: Decision[]; noRules?: string[] }, staying: Message[]): string[] {
  const address = (message: Message) => message.from.address.trim().toLowerCase()
  const blocked = new Set([
    ...(state.noRules ?? []),
    ...state.decisions.filter((decision) => engaged.includes(decision.action)).map((decision) => decision.from),
    ...staying.map(address),
  ])
  const senders = new Set<string>()
  for (const { message, triage } of archived) {
    const from = address(message)
    if (!from.includes('@') || !ruleCategories.includes(triage.category) || blocked.has(from)) continue
    if (state.rules.some((rule) => rule.from && !rule.subject && from.includes(normalize(rule.from)))) continue
    senders.add(from)
  }
  return [...senders]
}

/** Remember the senders whose auto-made rule was deleted, here or in Outlook. */
export function retiredSenders(before: Rule[], after: Rule[], known: string[] = []): string[] {
  const kept = new Set(after.map((rule) => rule.id))
  const gone = before.filter((rule) => rule.auto && rule.from && !kept.has(rule.id)).map((rule) => normalize(rule.from!))
  return gone.length ? [...new Set([...known, ...gone])] : known
}

export function describeRule(rule: Rule): string {
  const parts = [rule.from && (rule.from.startsWith('@') ? `anyone ${rule.from}` : `from ${rule.from}`), rule.subject && `subject has “${rule.subject}”`].filter(Boolean)
  return parts.join(' and ')
}

export const ruleActionLabel: Record<RuleAction, string> = {
  archive: 'archive',
  receipts: 'move to receipts',
  delete: 'delete',
  read: 'mark read',
  task: 'make a task',
  flag: 'flag',
}
