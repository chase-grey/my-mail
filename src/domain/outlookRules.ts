import { codeWords } from './codes'
import { describeRule, ruleActionLabel } from './rules'
import type { OutlookRule, Rule } from './types'

/** Rules this app writes to Outlook are named so they can be told from rules made in Outlook. */
export const outlookRulePrefix = 'my mail: '

/** What Graph accepts for a message rule. Flag and task have no server-side action, so those rules stay in the app. */
export type OutlookRuleBody = {
  displayName: string
  sequence: number
  isEnabled: boolean
  conditions: { senderContains?: string[]; subjectContains?: string[] }
  actions: { moveToFolder?: string; delete?: boolean; markAsRead?: boolean; stopProcessingRules: boolean }
  exceptions?: { bodyOrSubjectContains: string[] }
}

export function compilable(rule: Rule): boolean {
  if (!rule.from && !rule.subject) return false
  return rule.action === 'archive' || rule.action === 'receipts' || rule.action === 'delete' || rule.action === 'read'
}

export function outlookRuleName(rule: Rule): string {
  return `${outlookRulePrefix}${ruleActionLabel[rule.action]} ${describeRule(rule)}`.slice(0, 256)
}

/** A rule that puts mail away marks it read on the way, the same as archiving by hand. */
const marksRead = (rule: Rule): boolean => rule.action === 'archive' || rule.action === 'receipts' || rule.action === 'read'

/** A rule that takes mail out of the inbox leaves mail with a sign-in code where it is. Outlook runs these while the app is closed, so the exception has to be in the rule. */
const sparesCodes = (rule: Rule): boolean => rule.action === 'archive' || rule.action === 'receipts' || rule.action === 'delete'

/** `folderId` is where a rule that moves mail sends it: the archive, or the receipts folder for a receipts rule. */
export function compileRule(rule: Rule, folderId: string, sequence: number): OutlookRuleBody {
  return {
    displayName: outlookRuleName(rule),
    sequence,
    isEnabled: rule.enabled,
    conditions: {
      ...(rule.from ? { senderContains: [rule.from.trim()] } : {}),
      ...(rule.subject ? { subjectContains: [rule.subject.trim()] } : {}),
    },
    actions: {
      ...(rule.action === 'archive' || rule.action === 'receipts' ? { moveToFolder: folderId } : {}),
      ...(rule.action === 'delete' ? { delete: true } : {}),
      ...(marksRead(rule) ? { markAsRead: true } : {}),
      stopProcessingRules: true,
    },
    ...(sparesCodes(rule) ? { exceptions: { bodyOrSubjectContains: codeWords } } : {}),
  }
}

export const isOurs = (rule: OutlookRule): boolean => rule.displayName.startsWith(outlookRulePrefix)

export type RuleSyncPlan = {
  /** App rules to write to Outlook for the first time. */
  create: Rule[]
  /** App rules whose Outlook copy should be rewritten. */
  update: Rule[]
  /** Outlook rule ids of ours that no app rule claims any more. */
  remove: string[]
  /** App rules deleted in Outlook by hand; Outlook wins, so they leave the app too. */
  dropped: string[]
  /** Rules made in Outlook itself, listed read-only. */
  foreign: OutlookRule[]
}

/**
 * Reconcile the app's rules with what Outlook has. Every compilable app rule should exist in Outlook exactly once;
 * an Outlook rule of ours that the app no longer has is removed; an app rule whose Outlook copy was deleted by hand is dropped.
 */
export function planRuleSync(rules: Rule[], outlook: OutlookRule[]): RuleSyncPlan {
  const ours = outlook.filter(isOurs)
  const byId = new Map(ours.map((rule) => [rule.id, rule]))
  const claimed = new Set<string>()
  const plan: RuleSyncPlan = { create: [], update: [], remove: [], dropped: [], foreign: outlook.filter((rule) => !isOurs(rule)) }
  for (const rule of rules) {
    if (!compilable(rule)) {
      if (rule.outlookId && byId.has(rule.outlookId)) plan.remove.push(rule.outlookId)
      continue
    }
    if (!rule.outlookId) { plan.create.push(rule); continue }
    const existing = byId.get(rule.outlookId)
    if (!existing) { plan.dropped.push(rule.id); continue }
    claimed.add(rule.outlookId)
    if (existing.displayName !== outlookRuleName(rule) || existing.isEnabled !== rule.enabled || existing.marksRead !== marksRead(rule) || (sparesCodes(rule) && !existing.sparesCodes)) plan.update.push(rule)
  }
  for (const rule of ours) if (!claimed.has(rule.id) && !plan.remove.includes(rule.id)) plan.remove.push(rule.id)
  return plan
}

export function ruleTier(rule: Rule): 'outlook' | 'app' {
  return compilable(rule) ? 'outlook' : 'app'
}

/** A plain reading of a rule made in Outlook, from the parts Graph gives back. */
export function describeOutlookRule(rule: { displayName: string; conditions?: Record<string, unknown>; actions?: Record<string, unknown> }): string {
  const conditions = Object.entries(rule.conditions ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== false && !(Array.isArray(value) && !value.length))
  const actions = Object.entries(rule.actions ?? {}).filter(([key, value]) => key !== 'stopProcessingRules' && value !== undefined && value !== null && value !== false)
  const words = (key: string) => key.replace(/([A-Z])/g, ' $1').toLowerCase()
  const show = (value: unknown) => Array.isArray(value) ? value.map((item) => typeof item === 'object' && item && 'emailAddress' in item ? (item as { emailAddress: { address?: string } }).emailAddress.address ?? '' : String(item)).join(', ') : typeof value === 'boolean' ? '' : ''
  const when = conditions.map(([key, value]) => `${words(key)} ${show(value)}`.trim()).join(', ')
  const then = actions.map(([key]) => words(key)).join(', ')
  return [when, then].filter(Boolean).join(' → ') || rule.displayName
}
