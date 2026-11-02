import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { InteractionRequiredAuthError } from '@azure/msal-browser'
import { AnthropicClient } from './ai/anthropicClient'
import { JevClient, classifyWithJev, kindOf } from './ai/jev'
import { draftReply, readMessages, type ReadItem } from './ai/triage'
import { AppFolder } from './data/appFolder'
import { AutomationStore } from './data/automationStore'
import { GraphClient, GraphError } from './data/graphClient'
import { MailProvider, mailDefaultHeaders } from './data/mailProvider'
import { MicrosoftAuth, configuredClientId } from './data/microsoftAuth'
import { TodoProvider } from './data/todoProvider'
import { groupBySender, staleIds, type ScanMessage, type SenderGroup } from './domain/cleanup'
import { historyTriage, noiseSenders, senderHistoryLine } from './domain/history'
import { compileRule, planRuleSync } from './domain/outlookRules'
import { applyRules, newRule, recordHits, rememberDecision, suggestRules, type RuleSuggestion } from './domain/rules'
import { dueSnoozes, snoozeRecord, snoozeUntil, withoutSnoozes, type SnoozeOption } from './domain/snooze'
import { autoArchivable, needsReading, outlookTriage, pruneTriage, rankTriaged, summarize, unsureBelow, type RunSummary, type Triaged } from './domain/triage'
import { emptyAutomation, type Action, type Automation, type Message, type OutlookRule, type Rule, type RuleAction, type Triage } from './domain/types'
import { parseUnsubscribe, unsubscribeMethod } from './domain/unsubscribe'
import { loadSettings, saveSettings, type Settings } from './settings'
import { Icon, Menu } from './ui'
import { CleanupView, type CleanupActions, type CleanupState } from './views/CleanupView'
import { InboxView } from './views/InboxView'
import { RulesView } from './views/RulesView'
import { SettingsView, type ConnectionStatus } from './views/SettingsView'

type View = 'inbox' | 'rules' | 'settings' | 'cleanup'
const triageKey = 'my-mail.triage.v1'
const keptKey = 'my-mail.kept.v1'
const staleDays = 30

type Services = { auth: MicrosoftAuth; mail: MailProvider; todo: TodoProvider; store: AutomationStore }

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be unavailable; the session still works in memory.
  }
}

function errorText(error: unknown): string {
  if (error instanceof InteractionRequiredAuthError) return 'reconnect microsoft'
  if (error instanceof GraphError && error.status === 403) return 'reconnect microsoft to allow rules and categories'
  return error instanceof Error ? error.message.toLowerCase() : 'something failed'
}

async function createServices(clientId: string): Promise<Services> {
  const auth = await MicrosoftAuth.create(clientId)
  const graph = new GraphClient(() => auth.accessToken(), undefined, undefined, mailDefaultHeaders)
  return { auth, mail: new MailProvider(graph), todo: new TodoProvider(graph), store: new AutomationStore(new AppFolder(graph)) }
}

/** Write what Outlook can run to Outlook, and read back what was changed or made there. */
async function syncOutlookRules(mail: MailProvider, rules: Rule[]): Promise<{ rules: Rule[]; foreign: OutlookRule[]; changed: boolean }> {
  const outlook = await mail.rules()
  const plan = planRuleSync(rules, outlook)
  let next = rules.filter((rule) => !plan.dropped.includes(rule.id))
  let changed = plan.dropped.length > 0
  if (plan.create.length || plan.update.length) {
    const archiveId = await mail.archiveFolderId()
    for (const rule of plan.create) {
      const id = await mail.createRule(compileRule(rule, archiveId, next.indexOf(rule) + 1))
      next = next.map((item) => item.id === rule.id ? { ...item, outlookId: id } : item)
      changed = true
    }
    for (const rule of plan.update) await mail.updateRule(rule.outlookId!, compileRule(rule, archiveId, next.indexOf(rule) + 1))
  }
  for (const id of plan.remove) await mail.deleteRule(id)
  return { rules: next, foreign: plan.foreign, changed }
}

export type MessageActions = {
  archive: (message: Message) => Promise<void>
  archiveAll: (messages: Message[]) => Promise<void>
  remove: (message: Message) => Promise<void>
  task: (message: Message, title: string) => Promise<void>
  reply: (message: Message, text: string, mode: 'send' | 'draft') => Promise<void>
  /** Write a reply on request. The strong model is for when the first one is not good enough. */
  draft: (message: Message, strong: boolean, instruction?: string) => Promise<string>
  snooze: (message: Message, option: SnoozeOption) => Promise<void>
  keep: (message: Message) => Promise<void>
  flag: (message: Message) => Promise<void>
  /** Follows the sender's List-Unsubscribe header. Returns a short note on what happened. */
  unsubscribe: (message: Message) => Promise<string>
  makeRule: (input: { from?: string; subject?: string; action: RuleAction }) => Promise<void>
}

const emptyCleanup: CleanupState = { scanned: 0, groups: [], staleCount: 0, done: false }

export default function App() {
  const [view, setView] = useState<View>('inbox')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [services, setServices] = useState<Services>()
  const [connection, setConnection] = useState<ConnectionStatus>(configuredClientId() ? 'disconnected' : 'unconfigured')
  const [accountName, setAccountName] = useState<string>()
  const [messages, setMessages] = useState<Message[]>([])
  const [triage, setTriage] = useState<Record<string, Triage>>(() => readJson(triageKey, {}))
  const [kept, setKept] = useState<Record<string, string>>(() => readJson(keptKey, {}))
  const [automation, setAutomation] = useState<Automation>(emptyAutomation)
  const [outlookRules, setOutlookRules] = useState<OutlookRule[]>([])
  const [summary, setSummary] = useState<RunSummary>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [dismissed, setDismissed] = useState<string[]>([])
  const [cleanup, setCleanup] = useState<CleanupState>(emptyCleanup)
  const scanRef = useRef<ScanMessage[]>([])
  const started = useRef(false)
  const automationRef = useRef(automation)
  automationRef.current = automation
  const triageRef = useRef(triage)
  triageRef.current = triage
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  useEffect(() => saveSettings(settings), [settings])
  useEffect(() => writeJson(triageKey, triage), [triage])
  useEffect(() => writeJson(keptKey, kept), [kept])

  const persistAutomation = useCallback(async (next: Automation, current = services) => {
    automationRef.current = next
    setAutomation(next)
    if (!current) return
    try {
      await current.store.save(next)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [services])

  /** Rules Outlook can run are written there; this is called after every rule change and on every open. */
  const pushRules = useCallback(async (current: Services, state: Automation): Promise<Automation> => {
    try {
      const synced = await syncOutlookRules(current.mail, state.rules)
      setOutlookRules(synced.foreign)
      return synced.changed ? { ...state, rules: synced.rules } : state
    } catch (failure) {
      setError(errorText(failure))
      return state
    }
  }, [])

  const run = useCallback(async (current: Services, options: { settings: Settings }) => {
    setBusy('checking mail')
    setError(undefined)
    const now = new Date().toISOString()
    try {
      let automationState = automationRef.current
      // Snoozed mail whose time has come returns first, so the inbox read below already includes it.
      const due = dueSnoozes(automationState.snoozes)
      let returned = 0
      for (const snooze of due) if (await current.mail.unsnooze(snooze.messageId)) returned++
      if (due.length) automationState = { ...automationState, snoozes: withoutSnoozes(automationState.snoozes, due.map((item) => item.messageId)) }

      let inbox = await current.mail.inbox()

      // Outlook has had its turn on anything that arrived while the app was closed; rules run here too for what it missed.
      automationState = await pushRules(current, automationState)
      const hits = applyRules(inbox, automationState.rules)
      for (const hit of hits) {
        if (hit.rule.action === 'archive') await current.mail.archive(hit.message.id)
        else if (hit.rule.action === 'delete') await current.mail.delete(hit.message.id)
        else if (hit.rule.action === 'read') await current.mail.markRead(hit.message.id)
        else if (hit.rule.action === 'flag') await current.mail.flag(hit.message.id)
        else if (hit.rule.action === 'task') { await current.todo.createTask({ title: hit.message.subject, message: hit.message }); await current.mail.archive(hit.message.id) }
      }
      const removed = new Set(hits.filter((hit) => hit.rule.action !== 'read' && hit.rule.action !== 'flag').map((hit) => hit.message.id))
      inbox = inbox.filter((message) => !removed.has(message.id)).map((message) => {
        const hit = hits.find((item) => item.message.id === message.id)
        if (!hit) return message
        return hit.rule.action === 'read' ? { ...message, isRead: true } : { ...message, flagged: true }
      })
      if (hits.length) automationState = { ...automationState, rules: recordHits(automationState.rules, hits) }
      if (automationState !== automationRef.current) await persistAutomation(automationState, current)

      // Verdicts, cheapest source first: this device's cache, the category Outlook already carries, the sender's history, then Jev.
      let cache = pruneTriage(triageRef.current, inbox)
      const before = new Set(Object.keys(cache))
      let withoutModel = 0
      const noise = noiseSenders(automationState.decisions)
      for (const message of inbox) {
        if (cache[message.id]) continue
        const verdict = outlookTriage(message, now) ?? historyTriage(message, noise, now)
        if (verdict) { cache[message.id] = verdict; withoutModel++ }
      }
      const history = (message: Message) => senderHistoryLine(automationState.decisions, message.from.address)
      const unsorted = inbox.filter((message) => !cache[message.id])
      if (options.settings.jevApiKey && unsorted.length) {
        setBusy(`sorting ${unsorted.length} new ${unsorted.length === 1 ? 'message' : 'messages'}`)
        try {
          const results = await classifyWithJev(new JevClient(options.settings.jevApiKey), unsorted, history)
          for (const result of results) cache[result.messageId] = result
          withoutModel += results.length
        } catch (failure) {
          setError(errorText(failure))
        }
      }

      // The language model reads only what needs me, or what nothing else could settle.
      if (options.settings.anthropicApiKey) {
        const toRead = inbox.filter((message) => needsReading(message, cache[message.id]))
        if (toRead.length) {
          setBusy(`reading ${toRead.length} ${toRead.length === 1 ? 'message' : 'messages'}`)
          const items: ReadItem[] = toRead.map((message) => {
            const prior = cache[message.id]
            return { message, known: prior && prior.confidence >= unsureBelow ? { category: prior.category, needsReply: prior.needsReply } : undefined }
          })
          const results = await readMessages(new AnthropicClient(options.settings.anthropicApiKey), options.settings.anthropicModel, items, { aboutMe: options.settings.aboutMe, today: new Date().toLocaleDateString('en-CA'), history })
          for (const result of results) {
            const prior = cache[result.messageId]
            cache[result.messageId] = prior && prior.confidence >= unsureBelow ? { ...result, source: prior.source, confidence: prior.confidence } : result
          }
        }
      }

      // New verdicts go onto the message as a category so the other device, and Outlook, can see them.
      if (options.settings.writeCategories) {
        for (const message of inbox) {
          const verdict = cache[message.id]
          if (!verdict || before.has(message.id) || verdict.source === 'outlook' || message.categories.includes(verdict.category)) continue
          try { await current.mail.setVerdict(message.id, message.categories, verdict.category) } catch { /* a missing scope only costs the shared category */ }
        }
      }

      let autoArchived = 0
      if (options.settings.autoArchive) {
        const quiet = inbox.filter((message) => cache[message.id] && autoArchivable(message, cache[message.id]))
        if (quiet.length) {
          await current.mail.archiveMany(quiet.map((message) => message.id))
          autoArchived = quiet.length
          const gone = new Set(quiet.map((message) => message.id))
          inbox = inbox.filter((message) => !gone.has(message.id))
          cache = pruneTriage(cache, inbox)
        }
      }

      triageRef.current = cache
      setTriage(cache)
      setMessages(inbox)
      setKept((current) => Object.fromEntries(Object.entries(current).filter(([id]) => inbox.some((message) => message.id === id))))
      setSummary(summarize(inbox.map((message) => ({ message, triage: cache[message.id] })), { byRules: removed.size, autoArchived, returned, withoutModel }))
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(undefined)
    }
  }, [persistAutomation, pushRules])

  useEffect(() => {
    const clientId = configuredClientId()
    if (!clientId || started.current) return
    started.current = true
    void createServices(clientId).then(async (created) => {
      setServices(created)
      const account = created.auth.account()
      if (!account) return
      setAccountName(account.username)
      setConnection('connected')
      try {
        const loaded = await created.store.load()
        automationRef.current = loaded
        setAutomation(loaded)
      } catch (failure) {
        setError(errorText(failure))
      }
      await run(created, { settings: loadSettings() })
    }).catch((failure: unknown) => setError(errorText(failure)))
  }, [run])

  async function connect(): Promise<void> {
    setBusy('connecting')
    setError(undefined)
    try {
      const clientId = configuredClientId()
      if (!clientId) throw new Error('microsoft app id is not configured')
      const current = services ?? await createServices(clientId)
      setServices(current)
      const account = await current.auth.signIn()
      setAccountName(account.username)
      setConnection('connected')
      const loaded = await current.store.load()
      automationRef.current = loaded
      setAutomation(loaded)
      await run(current, { settings })
    } catch (failure) {
      setError(errorText(failure))
      setBusy(undefined)
    }
  }

  async function disconnect(): Promise<void> {
    if (!services) return
    try {
      await services.auth.signOut()
      setConnection('disconnected')
      setAccountName(undefined)
      setMessages([])
      setSummary(undefined)
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  function drop(removedMessages: Message[]): void {
    const gone = new Set(removedMessages.map((message) => message.id))
    setMessages((current) => current.filter((item) => !gone.has(item.id)))
    setSummary((current) => current ? { ...current, inbox: current.inbox - gone.size, needReply: current.needReply - removedMessages.filter((message) => triageRef.current[message.id]?.needsReply).length } : current)
  }

  async function decide(message: Message, action: Action, work: () => Promise<void>, removes = true): Promise<void> {
    if (!services) throw new Error('connect microsoft first')
    setError(undefined)
    try {
      await work()
      if (removes) drop([message])
      await persistAutomation({ ...automationRef.current, decisions: rememberDecision(automationRef.current.decisions, message, action, new Date().toISOString()) })
    } catch (failure) {
      setError(errorText(failure))
      throw failure
    }
  }

  function anthropic(): AnthropicClient {
    if (!settingsRef.current.anthropicApiKey) throw new Error('add an anthropic key in settings')
    return new AnthropicClient(settingsRef.current.anthropicApiKey)
  }

  async function unsubscribeFrom(id: string, message: Message | undefined, address: string): Promise<string> {
    if (!services) throw new Error('connect microsoft first')
    const target = parseUnsubscribe(await services.mail.headers(id))
    if (!target) return 'no unsubscribe link in this mail'
    const method = unsubscribeMethod(target)
    if (method === 'one-click') {
      // RFC 8058: a bare POST is the whole protocol. The response is opaque across origins, so success is assumed.
      await fetch(target.oneClick!, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
    } else if (method === 'mail') {
      await services.mail.send(target.mailto!.to, target.mailto!.subject, target.mailto!.body)
    } else {
      window.open(target.url, '_blank', 'noreferrer')
    }
    const decisions = message ? rememberDecision(automationRef.current.decisions, message, 'unsubscribe', new Date().toISOString()) : automationRef.current.decisions
    if (message) await persistAutomation({ ...automationRef.current, decisions })
    return method === 'page' ? `unsubscribe page opened for ${address}` : `unsubscribed from ${address}`
  }

  const actions: MessageActions = {
    archive: (message) => decide(message, 'archive', () => services!.mail.archive(message.id)),
    archiveAll: async (list) => {
      if (!services || !list.length) return
      setError(undefined)
      try {
        await services.mail.archiveMany(list.map((message) => message.id))
        drop(list)
        const at = new Date().toISOString()
        await persistAutomation({ ...automationRef.current, decisions: list.reduce((decisions, message) => rememberDecision(decisions, message, 'archive', at), automationRef.current.decisions) })
      } catch (failure) {
        setError(errorText(failure))
      }
    },
    remove: (message) => decide(message, 'delete', () => services!.mail.delete(message.id)),
    task: (message, title) => decide(message, 'task', async () => {
      await services!.todo.createTask({ title: title.trim() || message.subject, note: triageRef.current[message.id]?.summary, message })
      await services!.mail.archive(message.id)
    }),
    reply: (message, text, mode) => decide(message, 'reply', async () => {
      if (mode === 'draft') {
        const draft = await services!.mail.draftReply(message.id, text)
        window.open(draft.webLink, '_blank', 'noreferrer')
        return
      }
      await services!.mail.reply(message.id, text)
      if (settings.archiveAfterReply) await services!.mail.archive(message.id)
      else await services!.mail.markRead(message.id)
    }, mode === 'send' && settings.archiveAfterReply),
    draft: async (message, strong, instruction) => {
      const current = settingsRef.current
      const text = await draftReply(anthropic(), strong ? current.strongModel : current.anthropicModel, message, { aboutMe: current.aboutMe, today: new Date().toLocaleDateString('en-CA'), instruction })
      setTriage((cache) => cache[message.id] ? { ...cache, [message.id]: { ...cache[message.id], draft: text } } : cache)
      return text
    },
    snooze: (message, option) => decide(message, 'snooze', async () => {
      await services!.mail.snooze(message.id)
      automationRef.current = { ...automationRef.current, snoozes: [...withoutSnoozes(automationRef.current.snoozes, [message.id]), snoozeRecord(message, snoozeUntil(option))] }
    }),
    keep: (message) => decide(message, 'keep', async () => {
      if (!message.isRead) await services!.mail.markRead(message.id)
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, isRead: true } : item))
      setKept((current) => ({ ...current, [message.id]: new Date().toISOString() }))
    }, false),
    flag: (message) => decide(message, 'flag', async () => {
      await services!.mail.flag(message.id, !message.flagged)
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, flagged: !item.flagged } : item))
    }, false),
    unsubscribe: async (message) => {
      setError(undefined)
      try {
        return await unsubscribeFrom(message.id, message, message.from.address)
      } catch (failure) {
        setError(errorText(failure))
        throw failure
      }
    },
    makeRule: async (input) => {
      const rule = newRule(input, crypto.randomUUID(), new Date().toISOString())
      await updateRules([...automationRef.current.rules, rule])
    },
  }

  async function updateRules(rules: Rule[]): Promise<void> {
    let next: Automation = { ...automationRef.current, rules }
    if (services) next = await pushRules(services, next)
    await persistAutomation(next)
  }

  const cleanupActions: CleanupActions = {
    scan: async () => {
      if (!services) return
      setError(undefined)
      setCleanup({ ...emptyCleanup })
      try {
        const scanned = await services.mail.scanInbox((count) => setCleanup((current) => ({ ...current, scanned: count })))
        scanRef.current = scanned
        const groups = groupBySender(scanned)
        setCleanup({ scanned: scanned.length, total: scanned.length, groups, staleCount: staleIds(scanned, staleDays).length, done: true })
        const jevKey = settingsRef.current.jevApiKey
        if (!jevKey) return
        // One cheap question per sender, on the newest message only, to tell newsletters from people.
        const client = new JevClient(jevKey)
        const candidates = groups.filter((group) => group.count >= 2).slice(0, 80)
        setCleanup((current) => ({ ...current, working: `sorting ${candidates.length} senders` }))
        const kinds = await Promise.all(candidates.map(async (group) => {
          try { return [group.address, await kindOf(client, group.sample)] as const } catch { return [group.address, undefined] as const }
        }))
        const byAddress = new Map(kinds)
        setCleanup((current) => ({ ...current, working: undefined, groups: current.groups.map((group) => {
          const kind = byAddress.get(group.address)
          return kind ? { ...group, kind: kind.category, kindConfidence: kind.confidence } : group
        }) }))
      } catch (failure) {
        setError(errorText(failure))
        setCleanup((current) => ({ ...current, done: true, working: undefined }))
      }
    },
    archiveSender: (group) => clearSender(group, 'archive'),
    deleteSender: (group) => clearSender(group, 'delete'),
    blockSender: async (group, action) => {
      await updateRules([...automationRef.current.rules, newRule({ from: group.address, action }, crypto.randomUUID(), new Date().toISOString())])
      await clearSender(group, action)
    },
    unsubscribe: (group) => unsubscribeFrom(group.sample.id, undefined, group.address),
    archiveStale: async () => {
      if (!services) return
      const ids = staleIds(scanRef.current, staleDays)
      setCleanup((current) => ({ ...current, working: `archiving ${ids.length}` }))
      await services.mail.archiveMany(ids, (done) => setCleanup((current) => ({ ...current, working: `archived ${done} of ${ids.length}` })))
      const gone = new Set(ids)
      scanRef.current = scanRef.current.filter((message) => !gone.has(message.id))
      setCleanup((current) => ({ ...current, working: undefined, total: scanRef.current.length, groups: regroup(current.groups), staleCount: 0 }))
      drop(messages.filter((message) => gone.has(message.id)))
    },
  }

  /** Regroup what is left of the scan, keeping any classifier verdicts already attached to a sender. */
  function regroup(previous: SenderGroup[]): SenderGroup[] {
    const kinds = new Map(previous.map((group) => [group.address, group]))
    return groupBySender(scanRef.current).map((group) => {
      const known = kinds.get(group.address)
      return known?.kind ? { ...group, kind: known.kind, kindConfidence: known.kindConfidence } : group
    })
  }

  const asMessage = (sample: ScanMessage): Message => ({ ...sample, body: '', importance: 'normal', hasAttachments: false, categories: [], webLink: '' })

  async function clearSender(group: SenderGroup, action: 'archive' | 'delete'): Promise<void> {
    if (!services) return
    setCleanup((current) => ({ ...current, working: `${action === 'archive' ? 'archiving' : 'deleting'} ${group.count} from ${group.name}` }))
    try {
      const move = action === 'archive' ? services.mail.archiveMany.bind(services.mail) : services.mail.deleteMany.bind(services.mail)
      await move(group.ids, (done) => setCleanup((current) => ({ ...current, working: `${done} of ${group.count} from ${group.name}` })))
      const gone = new Set(group.ids)
      scanRef.current = scanRef.current.filter((message) => !gone.has(message.id))
      setCleanup((current) => ({ ...current, working: undefined, total: (current.total ?? current.scanned) - group.count, groups: current.groups.filter((item) => item.address !== group.address), staleCount: staleIds(scanRef.current, staleDays).length }))
      drop(messages.filter((message) => gone.has(message.id)))
      await persistAutomation({ ...automationRef.current, decisions: rememberDecision(automationRef.current.decisions, asMessage(group.sample), action, new Date().toISOString()) })
    } finally {
      setCleanup((current) => ({ ...current, working: undefined }))
    }
  }

  const suggestions = useMemo<RuleSuggestion[]>(() => suggestRules(automation.decisions, automation.rules).filter((item) => !dismissed.includes(`${item.from}|${item.action}`)), [automation, dismissed])
  const triaged = useMemo<Triaged[]>(() => rankTriaged(messages.map((message) => ({ message, triage: triage[message.id] }))), [messages, triage])
  const connected = connection === 'connected' && Boolean(services)
  const title = view === 'inbox' ? 'inbox' : view === 'cleanup' ? 'clean up' : view

  function openCleanup(): void {
    setView('cleanup')
    if (!cleanup.done && !cleanup.scanned) void cleanupActions.scan()
  }

  return <div className="main">
    <header className="topbar">
      {view !== 'inbox' && <button className="back icon-button" type="button" aria-label="back to inbox" onClick={() => setView('inbox')}><Icon name="back" /></button>}
      <h1>{title}</h1>
      {view === 'inbox' && <button className={`icon-button${busy ? ' is-spinning' : ''}`} type="button" aria-label="check mail" title="check mail" disabled={!connected || Boolean(busy)} onClick={() => services && void run(services, { settings })}><Icon name="refresh" /></button>}
      <Menu items={[
        ...(view !== 'cleanup' && connected ? [{ label: 'clean up', onSelect: openCleanup }] : []),
        ...(view !== 'rules' ? [{ label: 'rules', onSelect: () => setView('rules') }] : []),
        ...(view !== 'settings' ? [{ label: 'settings', onSelect: () => setView('settings') }] : []),
        { label: 'open outlook', onSelect: () => window.open('https://outlook.live.com/mail/0/', '_blank', 'noreferrer') },
        ...(settings.brainUrl ? [{ label: 'open my brain', onSelect: () => window.open(settings.brainUrl, '_blank', 'noreferrer') }] : []),
      ]} />
    </header>

    <div className="content">
      {view === 'inbox' && <InboxView items={triaged} kept={kept} summary={summary} busy={busy} error={error} connection={connection} hasModel={Boolean(settings.anthropicApiKey)} suggestions={suggestions} snoozes={automation.snoozes} actions={actions}
        onConnect={connect} onSettings={() => setView('settings')} onDismissSuggestion={(item) => setDismissed((current) => [...current, `${item.from}|${item.action}`])} />}
      {view === 'rules' && <RulesView rules={automation.rules} outlookRules={outlookRules} snoozes={automation.snoozes} error={error} onRules={updateRules} />}
      {view === 'cleanup' && <CleanupView state={cleanup} error={error} actions={cleanupActions} onError={setError} />}
      {view === 'settings' && <SettingsView settings={settings} connection={connection} accountName={accountName} busy={Boolean(busy)} error={error} onSettings={setSettings} onConnect={connect} onDisconnect={disconnect} />}
    </div>
  </div>
}
