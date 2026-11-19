import { useState } from 'react'
import { ruleTier } from '../domain/outlookRules'
import { describeRule, newRule, ruleActionLabel } from '../domain/rules'
import { describeSnooze } from '../domain/snooze'
import type { OutlookRule, Rule, RuleAction, Snooze } from '../domain/types'
import { Card, Empty, Field, Menu, Segmented } from '../ui'

const actionOptions = (Object.keys(ruleActionLabel) as RuleAction[]).map((value) => ({ value, label: ruleActionLabel[value] }))

export function RulesView({ rules, outlookRules, snoozes, error, onRules }: {
  rules: Rule[]
  outlookRules: OutlookRule[]
  snoozes: Snooze[]
  error?: string
  onRules: (rules: Rule[]) => Promise<void>
}) {
  const [from, setFrom] = useState('')
  const [subject, setSubject] = useState('')
  const [action, setAction] = useState<RuleAction>('archive')

  function add(event: React.FormEvent): void {
    event.preventDefault()
    if (!from.trim() && !subject.trim()) return
    void onRules([...rules, newRule({ from, subject, action }, crypto.randomUUID(), new Date().toISOString())])
    setFrom(''); setSubject('')
  }

  const replace = (rule: Rule) => onRules(rules.map((item) => item.id === rule.id ? rule : item))
  const meta = (rule: Rule) => [
    rule.enabled ? undefined : 'off',
    rule.auto ? 'auto' : undefined,
    ruleTier(rule) === 'outlook' ? (rule.outlookId ? 'runs in outlook' : 'going to outlook') : `runs here · ${rule.hits} ${rule.hits === 1 ? 'hit' : 'hits'}`,
  ].filter(Boolean).join(' · ')

  return <>
    <Card title="rules" aside={rules.length > 0 && <span className="count">{rules.length}</span>}>
      {rules.length > 0 && <ul className="rows">{rules.map((rule) => <li className="row" key={rule.id}>
        <div className="row-main"><span className="row-title">{ruleActionLabel[rule.action]} {describeRule(rule)}</span><small>{meta(rule)}</small></div>
        <Menu label={`options for ${describeRule(rule)}`} items={[
          { label: rule.enabled ? 'turn off' : 'turn on', onSelect: () => void replace({ ...rule, enabled: !rule.enabled }) },
          { label: 'delete', danger: true, onSelect: () => void onRules(rules.filter((item) => item.id !== rule.id)) },
        ]} />
      </li>)}</ul>}
      {error && <p className="note is-error" role="alert">{error}</p>}
      <form className="stack" onSubmit={add}>
        <Segmented label="what to do" options={actionOptions} value={action} onChange={setAction} />
        <div className="grid-2">
          <Field label="from"><input value={from} placeholder="@shop.example.com" onChange={(event) => setFrom(event.target.value)} /></Field>
          <Field label="subject has"><input value={subject} onChange={(event) => setSubject(event.target.value)} /></Field>
        </div>
        <button className="primary" type="submit" disabled={!from.trim() && !subject.trim()}>add rule</button>
      </form>
    </Card>

    {outlookRules.length > 0 && <Card title="made in outlook" aside={<span className="count">{outlookRules.length}</span>}>
      <ul className="rows">{outlookRules.map((rule) => <li className="row" key={rule.id}>
        <div className="row-main"><span className="row-title">{rule.displayName}</span><small>{[rule.isEnabled ? undefined : 'off', rule.description].filter(Boolean).join(' · ')}</small></div>
      </li>)}</ul>
      <div className="actions"><button className="link" type="button" onClick={() => window.open('https://outlook.live.com/mail/0/options/mail/rules', '_blank', 'noreferrer')}>edit in outlook</button></div>
    </Card>}

    <Card title="snoozed" aside={snoozes.length > 0 && <span className="count">{snoozes.length}</span>}>
      {snoozes.length
        ? <ul className="rows">{[...snoozes].sort((a, b) => a.until.localeCompare(b.until)).map((snooze) => <li className="row" key={snooze.messageId}><div className="row-main"><span className="row-title">{snooze.subject}</span><small>{snooze.from}</small></div><span className="row-meta">{describeSnooze(snooze)}</span></li>)}</ul>
        : <Empty>nothing snoozed</Empty>}
    </Card>
  </>
}
