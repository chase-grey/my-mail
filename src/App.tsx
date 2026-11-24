import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { InteractionRequiredAuthError } from '@azure/msal-browser'
import { AnthropicClient } from './ai/anthropicClient'
import { JevClient, classifyWithJev, kindOf } from './ai/jev'
import { findRelated } from './ai/related'
import { answerFromMail, translateQuery } from './ai/search'
import { draftReply, readMessages, type ReadItem } from './ai/triage'
import { AppFolder } from './data/appFolder'
import { AutomationStore } from './data/automationStore'
import { GraphClient, GraphError } from './data/graphClient'
import { MailProvider, inboxPageSize, mailDefaultHeaders } from './data/mailProvider'
import { MailSearch } from './data/mailSearch'
import { MicrosoftAuth, configuredClientId } from './data/microsoftAuth'
import { TodoProvider } from './data/todoProvider'
import { arrivals, newestOf, withArrivals } from './domain/arrivals'
import { groupBySender, keepSenderKinds, sendersToAsk, staleIds, type ScanMessage, type SenderGroup, type SenderKinds } from './domain/cleanup'
import { historyTriage, noiseSenders, senderHistoryLine } from './domain/history'
import { compileRule, planRuleSync } from './domain/outlookRules'
import { applyRules, autoRuleSenders, newRule, recordHits, rememberDecision, retiredSenders, suggestRules, type RuleSuggestion } from './domain/rules'
import { dueSnoozes, snoozeRecord, snoozeUntil, withoutSnoozes, type SnoozeOption } from './domain/snooze'
import { ageTriage, autoArchivable, needsReading, outlookTriage, pruneTriage, rankTriaged, summarize, unsureBelow, type RunSummary, type Triaged } from './domain/triage'
import { emptyAutomation, type Action, type Automation, type Message, type OutlookRule, type Rule, type RuleAction, type Triage } from './domain/types'
import { inboxThreads } from './domain/threads'
import { parseUnsubscribe, unsubscribeMethod } from './domain/unsubscribe'
import { useInstallPrompt } from './installPrompt'
import { loadSettings, saveSettings, type Settings } from './settings'
import { CleanupView, type CleanupActions, type CleanupState } from './views/CleanupView'
import { InboxView } from './views/InboxView'
import { BodySource } from './views/MailBody'
import { InstallBanner, InstallStep, hasInstallStep } from './views/InstallOffer'
import { ReceiptsView, type ReceiptActions } from './views/ReceiptsView'
import { RulesView } from './views/RulesView'
import { SearchView, type SearchActions } from './views/SearchView'
import { Shell, resumeView, type ShellLink, type View } from './views/Shell'
import { SettingsView, type ConnectionStatus } from './views/SettingsView'
import { ThreadContext, type ThreadActions } from './views/Thread'

const triageKey = 'my-mail.triage.v1'
const keptKey = 'my-mail.kept.v1'
const inboxKey = 'my-mail.inbox.v1'
const senderKindsKey = 'my-mail.senderKinds.v1'
/** How much of the inbox is kept on this device to show on the next open, before the mailbox has answered. */
const savedInboxSize = 200
const staleDays = 30

type Services = { auth: MicrosoftAuth; mail: MailProvider; search: MailSearch; todo: TodoProvider; store: AutomationStore }
type Sorted = { inbox: Message[]; cache: Record<string, Triage>; byRules: number; autoArchived: number; filed: number; newRules: number; withoutModel: number }

/** The earliest received time in a page, which is where the next page starts. */
function oldestOf(messages: Message[]): string | undefined {
  return messages.reduce<string | undefined>((oldest, message) => !oldest || message.receivedAt < oldest ? message.receivedAt : oldest, undefined)
}

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

/** TypeSafe turns away calls made from a web page. Once one fails that way, Jev is not asked again until the page reloads; Claude sorts instead. */
let jevUnreachable = false
const isNetworkFailure = (failure: unknown) => failure instanceof TypeError

function errorText(error: unknown): string {
  if (error instanceof InteractionRequiredAuthError) return 'reconnect microsoft'
  if (error instanceof GraphError && error.status === 403) return 'reconnect microsoft to allow rules and categories'
  return error instanceof Error ? error.message.toLowerCase() : 'something failed'
}

const notMoved = (count: number) => `${count} did not move`
const resumeAfterMs = 60_000
/** How often an open, visible app asks the mailbox for new mail. Graph cannot push to a page with no server behind it. */
const pollMs = 10_000

async function createServices(clientId: string): Promise<Services> {
  const auth = await MicrosoftAuth.create(clientId)
  const graph = new GraphClient(() => auth.accessToken(), undefined, undefined, mailDefaultHeaders)
  return { auth, mail: new MailProvider(graph), search: new MailSearch(graph), todo: new TodoProvider(graph), store: new AutomationStore(new AppFolder(graph)) }
}

/** Write what Outlook can run to Outlook, and read back what was changed or made there. */
async function syncOutlookRules(mail: MailProvider, rules: Rule[]): Promise<{ rules: Rule[]; foreign: OutlookRule[]; changed: boolean }> {
  const outlook = await mail.rules()
  const plan = planRuleSync(rules, outlook)
  let next = rules.filter((rule) => !plan.dropped.includes(rule.id))
  let changed = plan.dropped.length > 0
  if (plan.create.length || plan.update.length) {
    const folder = (rule: Rule) => rule.action === 'receipts' ? mail.receiptsFolder() : mail.archiveFolderId()
    for (const rule of plan.create) {
      const id = await mail.createRule(compileRule(rule, await folder(rule), next.indexOf(rule) + 1))
      next = next.map((item) => item.id === rule.id ? { ...item, outlookId: id } : item)
      changed = true
    }
    for (const rule of plan.update) await mail.updateRule(rule.outlookId!, compileRule(rule, await folder(rule), next.indexOf(rule) + 1))
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
  /** Archiving this message sends it to the receipts folder. */
  isReceipt: (message: Message) => boolean
  keep: (message: Message) => Promise<void>
  flag: (message: Message) => Promise<void>
  /** Follows the sender's List-Unsubscribe header. Returns a short note on what happened. */
  unsubscribe: (message: Message) => Promise<string>
  makeRule: (input: { from?: string; subject?: string; action: RuleAction }) => Promise<void>
  /** Undo: bring a message that was just archived, deleted, or snoozed back to the inbox. */
  restore: (message: Message) => Promise<void>
}

const emptyCleanup: CleanupState = { scanned: 0, groups: [], staleCount: 0, done: false }

export default function App() {
  const [view, setView] = useState<View>(() => resumeView() ?? 'inbox')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [services, setServices] = useState<Services>()
  const [connection, setConnection] = useState<ConnectionStatus>(configuredClientId() ? 'disconnected' : 'unconfigured')
  const [accountName, setAccountName] = useState<string>()
  const [messages, setMessages] = useState<Message[]>(() => readJson(inboxKey, []))
  const [more, setMore] = useState(false)
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
  /** What each sender's clear took away this visit, by address, so undo can put it back. */
  const clearedRef = useRef(new Map<string, { scan: ScanMessage[]; inbox: Message[]; ruleId?: string }>())
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const oldestRef = useRef<string | undefined>(undefined)
  const started = useRef(false)
  const automationRef = useRef(automation)
  automationRef.current = automation
  const triageRef = useRef(triage)
  triageRef.current = triage
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const busyRef = useRef(busy)
  busyRef.current = busy
  const lastRunRef = useRef(0)
  /** The received time of the latest mail any read has seen; a look for new mail asks for what came after it. */
  const newestSeenRef = useRef<string | undefined>(undefined)
  const peekingRef = useRef(false)
  /** What left the inbox, and what came back, while a check was reading the mailbox. The check's answer predates both. */
  const leftRef = useRef(new Set<string>())
  const backRef = useRef(new Map<string, Message>())

  useEffect(() => saveSettings(settings), [settings])
  useEffect(() => writeJson(triageKey, triage), [triage])
  useEffect(() => writeJson(keptKey, kept), [kept])
  useEffect(() => writeJson(inboxKey, messages.slice(0, savedInboxSize)), [messages])

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
      return synced.changed ? { ...state, rules: synced.rules, noRules: retiredSenders(state.rules, synced.rules, state.noRules) } : state
    } catch (failure) {
      setError(errorText(failure))
      return state
    }
  }, [])

  /** Rules, verdicts, reading, categories, and auto-archive for one batch of fetched mail. Used for the first load and for every older page. */
  const sortBatch = useCallback(async (current: Services, batch: Message[], startCache: Record<string, Triage>, startAutomation: Automation, settings: Settings, now: string, onShow?: (inbox: Message[]) => void): Promise<Sorted> => {
    let inbox = batch
    let automationState = startAutomation
    const hits = applyRules(inbox, automationState.rules)
    // Mail goes on screen as soon as it is known to be staying past the rules, which cost nothing to work out. Sorting follows.
    const removed = new Set(hits.filter((hit) => hit.rule.action !== 'read' && hit.rule.action !== 'flag').map((hit) => hit.message.id))
    onShow?.(inbox.filter((message) => !removed.has(message.id)))
    for (const hit of hits) {
      if (hit.rule.action === 'archive') await current.mail.archive(hit.message.id)
      else if (hit.rule.action === 'receipts') await current.mail.fileReceipt(hit.message.id)
      else if (hit.rule.action === 'delete') await current.mail.delete(hit.message.id)
      else if (hit.rule.action === 'read') await current.mail.markRead(hit.message.id)
      else if (hit.rule.action === 'flag') await current.mail.flag(hit.message.id)
      else if (hit.rule.action === 'task') { await current.todo.createTask({ title: hit.message.subject, message: hit.message }); await current.mail.archive(hit.message.id) }
    }
    inbox = inbox.filter((message) => !removed.has(message.id)).map((message) => {
      const hit = hits.find((item) => item.message.id === message.id)
      if (!hit) return message
      return hit.rule.action === 'read' ? { ...message, isRead: true } : { ...message, flagged: true }
    })
    if (hits.length) automationState = { ...automationState, rules: recordHits(automationState.rules, hits) }
    if (automationState !== automationRef.current) await persistAutomation(automationState, current)

    // Verdicts, cheapest source first: this device's cache, the category Outlook already carries, the sender's history,
    // the message's age, then Jev. Mail too old to need anything never reaches a model.
    let cache = { ...startCache }
    const before = new Set(Object.keys(cache))
    let withoutModel = 0
    const noise = noiseSenders(automationState.decisions)
    for (const message of inbox) {
      if (cache[message.id]) continue
      const verdict = outlookTriage(message, now) ?? historyTriage(message, noise, now) ?? ageTriage(message, now)
      if (verdict) { cache[message.id] = verdict; withoutModel++ }
    }
    const history = (message: Message) => senderHistoryLine(automationState.decisions, message.from.address)
    const unsorted = inbox.filter((message) => !cache[message.id])
    if (settings.jevApiKey && unsorted.length && !jevUnreachable) {
      setBusy(`sorting ${unsorted.length} new ${unsorted.length === 1 ? 'message' : 'messages'}`)
      try {
        const results = await classifyWithJev(new JevClient(settings.jevApiKey), unsorted, history)
        for (const result of results) cache[result.messageId] = result
        withoutModel += results.length
      } catch (failure) {
        if (isNetworkFailure(failure)) jevUnreachable = true
        setError(isNetworkFailure(failure) ? "jev can't be reached from the browser" : errorText(failure))
      }
    }

    // New verdicts go onto the message as a category so the other device, and Outlook, can see them. The sure ones go
    // while Claude reads, so a second device looking at the same mail finds them sooner and a failed read does not lose them.
    const shared = new Set<string>()
    const share = async (sureOnly: boolean) => {
      if (!settings.writeCategories) return
      for (const message of inbox) {
        const verdict = cache[message.id]
        if (!verdict || before.has(message.id) || shared.has(message.id) || verdict.source === 'outlook' || verdict.source === 'age' || message.categories.includes(verdict.category)) continue
        if (sureOnly && verdict.confidence < unsureBelow) continue
        shared.add(message.id)
        try { await current.mail.setVerdict(message.id, message.categories, verdict.category) } catch { /* a missing scope only costs the shared category */ }
      }
    }
    const sharing = share(true)

    // The language model reads only what needs me, or what nothing else could settle.
    if (settings.anthropicApiKey) {
      const toRead = inbox.filter((message) => needsReading(message, cache[message.id], now))
      if (toRead.length) {
        setBusy(`reading ${toRead.length} ${toRead.length === 1 ? 'message' : 'messages'}`)
        const items: ReadItem[] = toRead.map((message) => {
          const prior = cache[message.id]
          return { message, known: prior && prior.confidence >= unsureBelow ? { category: prior.category, needsReply: prior.needsReply } : undefined }
        })
        // A read that fails keeps what the cheaper sources and the earlier batches settled; throwing here would have Jev asked again next run.
        try {
          await readMessages(new AnthropicClient(settings.anthropicApiKey), settings.anthropicModel, items, { aboutMe: settings.aboutMe, today: new Date().toLocaleDateString('en-CA'), history }, undefined, (results) => {
            for (const result of results) {
              const prior = cache[result.messageId]
              cache[result.messageId] = prior && prior.confidence >= unsureBelow ? { ...result, source: prior.source, confidence: prior.confidence } : result
            }
          })
        } catch (failure) {
          setError(errorText(failure))
        }
      }
    }
    await sharing
    await share(false)

    let autoArchived = 0
    let filed = 0
    let newRules = 0
    {
      // Receipts the sorter is sure about go to their folder whether or not auto-archive is on.
      const verdicts = cache
      const toReceipts = (message: Message) => settings.fileReceipts && verdicts[message.id]?.category === 'receipt'
      const quiet = inbox.filter((message) => verdicts[message.id] && autoArchivable(message, verdicts[message.id]) && (settings.autoArchive || toReceipts(message)))
      if (quiet.length) {
        const receipts = quiet.filter(toReceipts)
        const receiptSenders = new Set(receipts.map((message) => message.from.address.trim().toLowerCase()))
        // What Outlook refused to move stays on screen; saying it left would hide mail that is still in the inbox.
        const stuck = new Set([
          ...await current.mail.fileReceipts(receipts.map((message) => message.id)),
          ...await current.mail.archiveMany(quiet.filter((message) => !toReceipts(message)).map((message) => message.id)),
        ])
        const moved = quiet.filter((message) => !stuck.has(message.id))
        if (stuck.size) setError(notMoved(stuck.size))
        autoArchived = moved.length
        filed = receipts.filter((message) => !stuck.has(message.id)).length
        const gone = new Set(moved.map((message) => message.id))
        const sure = moved.map((message) => ({ message, triage: cache[message.id] }))
        inbox = inbox.filter((message) => !gone.has(message.id))
        cache = Object.fromEntries(Object.entries(cache).filter(([id]) => !gone.has(id)))

        // A sender the sorter just cleared gets a rule, so Outlook archives the next one on arrival without a model.
        const state = automationRef.current
        const senders = autoRuleSenders(sure, state, [...messagesRef.current.filter((message) => !gone.has(message.id)), ...inbox])
        if (senders.length) {
          const made = senders.map((from) => newRule({ from, action: receiptSenders.has(from) ? 'receipts' : 'archive', auto: true }, crypto.randomUUID(), now))
          await persistAutomation(await pushRules(current, { ...state, rules: [...state.rules, ...made] }), current)
          newRules = made.length
        }
      }
    }

    return { inbox, cache, byRules: removed.size, autoArchived, filed, newRules, withoutModel }
  }, [persistAutomation, pushRules])

  const run = useCallback(async (current: Services, options: { settings: Settings }) => {
    setBusy('checking mail')
    setError(undefined)
    const now = new Date().toISOString()
    lastRunRef.current = Date.now()
    leftRef.current.clear()
    backRef.current.clear()
    try {
      // The other device may have added rules or snoozes since this one last looked. Working from an old copy
      // would take its rules back out of Outlook, so the shared file is read again before anything is synced.
      try {
        const loaded = await current.store.load()
        automationRef.current = loaded
        setAutomation(loaded)
      } catch (failure) {
        setError(errorText(failure))
      }
      let automationState = automationRef.current
      // Snoozed mail whose time has come returns first, so the inbox read below already includes it.
      const due = dueSnoozes(automationState.snoozes)
      let returned = 0
      for (const snooze of due) if (await current.mail.unsnooze(snooze.messageId)) returned++
      if (due.length) automationState = { ...automationState, snoozes: withoutSnoozes(automationState.snoozes, due.map((item) => item.messageId)) }

      // There is one inbox: whatever Outlook's junk filter took comes back before the inbox is read.
      let rescued: Message[] = []
      try {
        rescued = await current.mail.rescueJunk()
      } catch (failure) {
        setError(errorText(failure))
      }

      // A refresh reads as deep as was already loaded, so older pages and their verdicts are not thrown away.
      const [page, total] = await Promise.all([
        current.mail.inbox(Math.max(inboxPageSize, messagesRef.current.length)),
        current.mail.inboxCount().catch(() => undefined),
      ])
      oldestRef.current = oldestOf(page.messages)
      newestSeenRef.current = newestOf(page.messages, newestSeenRef.current)
      // Rescued mail is sorted this run even when it is older than the page, or the inbox read has not caught up with the move.
      const inPage = new Set(page.messages.map((message) => message.id))
      const batch = [...page.messages, ...rescued.filter((message) => !inPage.has(message.id))]

      // Outlook has had its turn on anything that arrived while the app was closed; rules run here too for what it missed,
      // and they are the only rules junked mail ever meets.
      automationState = await pushRules(current, automationState)
      // The list stayed usable while this ran. What was cleared from it in the meantime stays cleared, and what was undone stays back.
      const settle = (read: Message[]) => {
        const ids = new Set(read.map((message) => message.id))
        return [...read.filter((message) => !leftRef.current.has(message.id)), ...[...backRef.current.values()].filter((message) => !ids.has(message.id))]
      }
      const sorted = await sortBatch(current, batch, triageRef.current, automationState, options.settings, now, (read) => {
        messagesRef.current = settle(read)
        setMessages(messagesRef.current)
      })
      const inbox = settle(sorted.inbox)
      const cache = pruneTriage(sorted.cache, inbox)

      triageRef.current = cache
      setTriage(cache)
      messagesRef.current = inbox
      setMessages(inbox)
      setMore(page.more)
      setKept((current) => Object.fromEntries(Object.entries(current).filter(([id]) => inbox.some((message) => message.id === id))))
      const counted = summarize(inbox.map((message) => ({ message, triage: cache[message.id] })), { byRules: sorted.byRules, autoArchived: sorted.autoArchived, returned, withoutModel: sorted.withoutModel })
      setSummary({ ...counted, inbox: Math.max(inbox.length, (total ?? 0) - sorted.byRules - sorted.autoArchived), filed: sorted.filed, newRules: sorted.newRules, fromJunk: rescued.length })
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(undefined)
    }
  }, [pushRules, sortBatch])

  /**
   * A quiet look for mail that arrived since the last read. Nothing on screen changes unless something came,
   * and what came is shown before it is sorted.
   */
  const peek = useCallback(async (current: Services, options: { settings: Settings }) => {
    if (peekingRef.current || busyRef.current || !lastRunRef.current) return
    // A snooze coming due needs the full check, which is what brings it back.
    if (dueSnoozes(automationRef.current.snoozes).length) { await run(current, options); return }
    peekingRef.current = true
    const lastRun = lastRunRef.current
    try {
      let rescued: Message[] = []
      let found: Message[] = []
      try {
        // One inbox: junk is emptied before the inbox is read, here as in the full check.
        // The look itself is ids and a count. Mail is read in full only when there is something to read.
        const since = newestSeenRef.current
        const glance = await current.mail.glance(since)
        const held = new Set(messagesRef.current.map((message) => message.id))
        const news = glance.ids.some((id) => !held.has(id) && !leftRef.current.has(id))
        if (!glance.junk && !news) return
        if (glance.junk) rescued = await current.mail.rescueJunk()
        if (news) found = (since ? await current.mail.inboxSince(since) : await current.mail.inbox()).messages
      } catch {
        // A look that fails says nothing; the next one is seconds away, and a full check reports what is wrong.
        return
      }
      // A full check that started in the meantime reads these itself.
      if (lastRunRef.current !== lastRun || busyRef.current) return
      newestSeenRef.current = newestOf(found, newestSeenRef.current)
      const fresh = arrivals([...found, ...rescued], messagesRef.current, leftRef.current)
      if (!fresh.length) return

      busyRef.current = 'checking mail'
      setBusy('checking mail')
      setError(undefined)
      const batch = new Set(fresh.map((message) => message.id))
      const show = (inbox: Message[]) => {
        messagesRef.current = withArrivals(messagesRef.current, batch, inbox, leftRef.current)
        setMessages(messagesRef.current)
      }
      try {
        const sorted = await sortBatch(current, fresh, triageRef.current, automationRef.current, options.settings, new Date().toISOString(), show)
        show(sorted.inbox)
        const stayed = sorted.inbox.filter((message) => !leftRef.current.has(message.id))
        const cache = { ...triageRef.current }
        for (const message of stayed) if (sorted.cache[message.id]) cache[message.id] = sorted.cache[message.id]
        triageRef.current = cache
        setTriage(cache)
        setSummary((summary) => summary ? {
          ...summary,
          inbox: summary.inbox + stayed.length,
          needReply: summary.needReply + stayed.filter((message) => cache[message.id]?.needsReply).length,
          byRules: summary.byRules + sorted.byRules,
          autoArchived: summary.autoArchived + sorted.autoArchived,
          filed: (summary.filed ?? 0) + sorted.filed,
          newRules: (summary.newRules ?? 0) + sorted.newRules,
          withoutModel: summary.withoutModel + sorted.withoutModel,
          fromJunk: (summary.fromJunk ?? 0) + rescued.length,
        } : summary)
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        setBusy(undefined)
      }
    } finally {
      peekingRef.current = false
    }
  }, [run, sortBatch])

  /** The next page of older mail, put through the same sorting as the first. */
  const loadMore = useCallback(async (current: Services, options: { settings: Settings }) => {
    const before = oldestRef.current
    if (!before) return
    setBusy('loading more')
    setError(undefined)
    try {
      const page = await current.mail.inbox(inboxPageSize, before)
      const have = new Set(messagesRef.current.map((message) => message.id))
      const fresh = page.messages.filter((message) => !have.has(message.id))
      const sorted = await sortBatch(current, fresh, triageRef.current, automationRef.current, options.settings, new Date().toISOString())
      oldestRef.current = oldestOf(page.messages) ?? before

      triageRef.current = sorted.cache
      setTriage(sorted.cache)
      messagesRef.current = [...messagesRef.current, ...sorted.inbox]
      setMessages(messagesRef.current)
      // A page of nothing new means the date window did not move; stop instead of asking again.
      setMore(page.more && fresh.length > 0)
      setSummary((summary) => summary ? {
        ...summary,
        inbox: summary.inbox - sorted.byRules - sorted.autoArchived,
        needReply: summary.needReply + sorted.inbox.filter((message) => sorted.cache[message.id]?.needsReply).length,
        byRules: summary.byRules + sorted.byRules,
        autoArchived: summary.autoArchived + sorted.autoArchived,
        filed: (summary.filed ?? 0) + sorted.filed,
        newRules: (summary.newRules ?? 0) + sorted.newRules,
        withoutModel: summary.withoutModel + sorted.withoutModel,
      } : summary)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(undefined)
    }
  }, [sortBatch])

  useEffect(() => {
    const clientId = configuredClientId()
    if (!clientId || started.current) return
    started.current = true
    void createServices(clientId).then(async (created) => {
      setServices(created)
      const account = created.auth.account()
      if (!account) { setMessages([]); return }
      setAccountName(account.username)
      setConnection('connected')
      await run(created, { settings: loadSettings() })
    }).catch((failure: unknown) => setError(errorText(failure)))
  }, [run])

  // New mail is looked for every few seconds while the app is on screen, and the moment it comes back to the screen.
  // After a minute away the return is a full check, which also catches what was archived or read elsewhere.
  useEffect(() => {
    if (!services || connection !== 'connected') return
    const look = (full: boolean) => {
      if (document.visibilityState !== 'visible' || busyRef.current) return
      const options = { settings: settingsRef.current }
      if (full && Date.now() - lastRunRef.current >= resumeAfterMs) void run(services, options)
      else void peek(services, options)
    }
    const back = () => look(true)
    const timer = setInterval(() => look(false), pollMs)
    document.addEventListener('visibilitychange', back)
    window.addEventListener('focus', back)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', back)
      window.removeEventListener('focus', back)
    }
  }, [services, connection, run, peek])

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
      setMore(false)
      setSummary(undefined)
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  function drop(removedMessages: Message[]): void {
    const gone = new Set(removedMessages.map((message) => message.id))
    // Search acts on mail that may not be in the loaded inbox; only what was here comes off the counts.
    const here = messagesRef.current.filter((message) => gone.has(message.id))
    for (const id of gone) { leftRef.current.add(id); backRef.current.delete(id) }
    setMessages((current) => current.filter((item) => !gone.has(item.id)))
    setSummary((current) => current ? { ...current, inbox: current.inbox - here.length, needReply: current.needReply - here.filter((message) => triageRef.current[message.id]?.needsReply).length } : current)
  }

  /** A receipt leaves the inbox for the receipts folder, not the archive. */
  function isReceipt(message: Message): boolean {
    if (!settingsRef.current.fileReceipts) return false
    const verdict = triageRef.current[message.id]
    return verdict ? verdict.category === 'receipt' : message.categories.includes('receipt')
  }

  async function decide(message: Message, action: Action, work: () => Promise<void>, removes = true): Promise<void> {
    if (!services) throw new Error('connect microsoft first')
    setError(undefined)
    try {
      await work()
      if (removes) drop([message])
      await persistAutomation({ ...automationRef.current, decisions: rememberDecision(automationRef.current.decisions, message, action, new Date().toISOString(), undefined, action === 'archive' && isReceipt(message)) })
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
    archive: (message) => decide(message, 'archive', () => isReceipt(message) ? services!.mail.fileReceipt(message.id) : services!.mail.archive(message.id)),
    isReceipt,
    archiveAll: async (list) => {
      if (!services || !list.length) return
      setError(undefined)
      try {
        const stuck = new Set([
          ...await services.mail.fileReceipts(list.filter(isReceipt).map((message) => message.id)),
          ...await services.mail.archiveMany(list.filter((message) => !isReceipt(message)).map((message) => message.id)),
        ])
        const moved = list.filter((message) => !stuck.has(message.id))
        drop(moved)
        if (stuck.size) setError(notMoved(stuck.size))
        const at = new Date().toISOString()
        await persistAutomation({ ...automationRef.current, decisions: moved.reduce((decisions, message) => rememberDecision(decisions, message, 'archive', at, undefined, isReceipt(message)), automationRef.current.decisions) })
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
    restore: async (message) => {
      if (!services) throw new Error('connect microsoft first')
      setError(undefined)
      try {
        await services.mail.move(message.id, 'inbox')
        leftRef.current.delete(message.id)
        backRef.current.set(message.id, message)
        setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message])
        setSummary((current) => current ? { ...current, inbox: current.inbox + 1, needReply: current.needReply + (triageRef.current[message.id]?.needsReply ? 1 : 0) } : current)
        const state = automationRef.current
        await persistAutomation({ ...state, snoozes: withoutSnoozes(state.snoozes, [message.id]), decisions: state.decisions.filter((decision) => decision.messageId !== message.id) })
      } catch (failure) {
        setError(errorText(failure))
        throw failure
      }
    },
  }

  async function updateRules(rules: Rule[]): Promise<void> {
    let next: Automation = { ...automationRef.current, rules, noRules: retiredSenders(automationRef.current.rules, rules, automationRef.current.noRules) }
    if (services) next = await pushRules(services, next)
    await persistAutomation(next)
  }

  const cleanupActions: CleanupActions = {
    scan: async () => {
      if (!services) return
      setError(undefined)
      setCleanup({ ...emptyCleanup })
      clearedRef.current.clear()
      try {
        const scanned = await services.mail.scanInbox((count) => setCleanup((current) => ({ ...current, scanned: count })))
        scanRef.current = scanned
        const groups = groupBySender(scanned)
        const jevKey = settingsRef.current.jevApiKey
        // A sender Jev has already been asked about is not asked again; a scan during a long cleanup costs only its new senders.
        const known = keepSenderKinds(groups, readJson<SenderKinds>(senderKindsKey, {}))
        const candidates = jevKey ? sendersToAsk(groups, known) : []
        const labelled = (list: SenderGroup[], kinds: SenderKinds) => list.map((group) => kinds[group.address] ? { ...group, kind: kinds[group.address].kind, kindConfidence: kinds[group.address].confidence } : group)
        // The lists stay hidden until the senders are sorted, so none of them changes section after it is on screen.
        setCleanup({ scanned: scanned.length, total: scanned.length, groups: labelled(groups, known), staleCount: staleIds(scanned, staleDays).length, done: !candidates.length })
        writeJson(senderKindsKey, known)
        if (!candidates.length) return
        // One cheap question per sender, on the newest message only, to tell newsletters from people.
        const client = new JevClient(jevKey)
        setCleanup((current) => ({ ...current, working: `sorting ${candidates.length} senders` }))
        const asked = await Promise.all(candidates.map(async (group) => {
          try { return [group.address, await kindOf(client, group.sample)] as const } catch { return [group.address, undefined] as const }
        }))
        const kinds: SenderKinds = { ...known }
        for (const [address, kind] of asked) if (kind) kinds[address] = { kind: kind.category, confidence: kind.confidence }
        writeJson(senderKindsKey, kinds)
        setCleanup((current) => ({ ...current, done: true, working: undefined, groups: labelled(current.groups, kinds) }))
      } catch (failure) {
        setError(errorText(failure))
        setCleanup((current) => ({ ...current, done: true, working: undefined }))
      }
    },
    archiveSender: (group) => clearSender(group, 'archive'),
    deleteSender: (group) => clearSender(group, 'delete'),
    blockSender: async (group, action) => {
      const rule = newRule({ from: group.address, action }, crypto.randomUUID(), new Date().toISOString())
      await updateRules([...automationRef.current.rules, rule])
      try {
        await clearSender(group, action, rule.id)
      } catch (failure) {
        // The mail did not move, so the row keeps its buttons; the rule should not outlive it.
        await updateRules(automationRef.current.rules.filter((item) => item.id !== rule.id))
        throw failure
      }
    },
    undoSender: async (group) => {
      if (!services) return
      const taken = clearedRef.current.get(group.address)
      if (taken?.ruleId) await updateRules(automationRef.current.rules.filter((item) => item.id !== taken.ruleId))
      setCleanup((current) => ({ ...current, working: `bringing back ${group.count} from ${group.name}` }))
      try {
        const stuck = await services.mail.moveMany(group.ids, 'inbox', (done) => setCleanup((current) => ({ ...current, working: `${done} of ${group.count} from ${group.name}` })))
        if (stuck.length) throw new Error(notMoved(stuck.length))
        clearedRef.current.delete(group.address)
        const back = new Set(scanRef.current.map((message) => message.id))
        scanRef.current = [...scanRef.current, ...(taken?.scan ?? []).filter((message) => !back.has(message.id))]
        setCleanup((current) => ({ ...current, working: undefined, total: (current.total ?? current.scanned) + group.count, groups: current.groups.map((item) => item.address === group.address ? { ...item, cleared: undefined } : item), staleCount: staleIds(scanRef.current, staleDays).length }))
        const inbox = taken?.inbox ?? []
        if (inbox.length) {
          setMessages((current) => [...current, ...inbox.filter((message) => !current.some((item) => item.id === message.id))])
          setSummary((current) => current ? { ...current, inbox: current.inbox + inbox.length, needReply: current.needReply + inbox.filter((message) => triageRef.current[message.id]?.needsReply).length } : current)
        }
        await persistAutomation({ ...automationRef.current, decisions: automationRef.current.decisions.filter((decision) => decision.messageId !== group.sample.id) })
      } finally {
        setCleanup((current) => ({ ...current, working: undefined }))
      }
    },
    unsubscribe: (group) => unsubscribeFrom(group.sample.id, undefined, group.address),
    archiveStale: async () => {
      if (!services) return
      const ids = staleIds(scanRef.current, staleDays)
      setCleanup((current) => ({ ...current, working: `archiving ${ids.length}` }))
      let stuck: string[]
      try {
        stuck = await services.mail.archiveMany(ids, (done) => setCleanup((current) => ({ ...current, working: `archived ${done} of ${ids.length}` })))
      } catch (failure) {
        setCleanup((current) => ({ ...current, working: undefined }))
        setError(errorText(failure))
        return
      }
      const kept = new Set(stuck)
      const gone = new Set(ids.filter((id) => !kept.has(id)))
      scanRef.current = scanRef.current.filter((message) => !gone.has(message.id))
      setCleanup((current) => ({ ...current, working: undefined, total: scanRef.current.length, groups: regroup(current.groups), staleCount: stuck.length }))
      drop(messages.filter((message) => gone.has(message.id)))
      if (stuck.length) setError(notMoved(stuck.length))
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

  async function clearSender(group: SenderGroup, action: 'archive' | 'delete', ruleId?: string): Promise<void> {
    if (!services) return
    setCleanup((current) => ({ ...current, working: `${action === 'archive' ? 'archiving' : 'deleting'} ${group.count} from ${group.name}` }))
    try {
      const move = action === 'archive' ? services.mail.archiveMany.bind(services.mail) : services.mail.deleteMany.bind(services.mail)
      const stuck = await move(group.ids, (done) => setCleanup((current) => ({ ...current, working: `${done} of ${group.count} from ${group.name}` })))
      if (stuck.length) {
        // Some stayed in the inbox: the row keeps its buttons and shrinks to what is left, so another press finishes it.
        const kept = new Set(stuck)
        const moved = new Set(group.ids.filter((id) => !kept.has(id)))
        scanRef.current = scanRef.current.filter((message) => !moved.has(message.id))
        const rest = groupBySender(scanRef.current.filter((message) => kept.has(message.id)))[0]
        setCleanup((current) => ({ ...current, total: (current.total ?? current.scanned) - moved.size, groups: current.groups.map((item) => item.address === group.address && rest ? { ...rest, kind: item.kind, kindConfidence: item.kindConfidence } : item), staleCount: staleIds(scanRef.current, staleDays).length }))
        drop(messages.filter((message) => moved.has(message.id)))
        throw new Error(notMoved(stuck.length))
      }
      const gone = new Set(group.ids)
      clearedRef.current.set(group.address, { scan: scanRef.current.filter((message) => gone.has(message.id)), inbox: messagesRef.current.filter((message) => gone.has(message.id)), ruleId })
      scanRef.current = scanRef.current.filter((message) => !gone.has(message.id))
      setCleanup((current) => ({ ...current, working: undefined, total: (current.total ?? current.scanned) - group.count, groups: current.groups.map((item) => item.address === group.address ? { ...item, cleared: action } : item), staleCount: staleIds(scanRef.current, staleDays).length }))
      drop(messages.filter((message) => gone.has(message.id)))
      await persistAutomation({ ...automationRef.current, decisions: rememberDecision(automationRef.current.decisions, asMessage(group.sample), action, new Date().toISOString()) })
    } finally {
      setCleanup((current) => ({ ...current, working: undefined }))
    }
  }

  const receiptActions: ReceiptActions = {
    load: (before) => services!.mail.receipts(inboxPageSize, before),
    fromArchive: async (onProgress) => {
      const ids = await services!.mail.archivedReceipts()
      const stuck = await services!.mail.fileReceipts(ids, onProgress)
      return ids.length - stuck.length
    },
    toInbox: (message) => actions.restore(message),
  }

  const suggestions = useMemo<RuleSuggestion[]>(() => suggestRules(automation.decisions, automation.rules).filter((item) => !dismissed.includes(`${item.from}|${item.action}`)), [automation, dismissed])
  const triaged = useMemo<Triaged[]>(() => rankTriaged(messages.map((message) => ({ message, triage: triage[message.id] }))), [messages, triage])
  const connected = connection === 'connected' && Boolean(services)
  const install = useInstallPrompt()
  const [installSkipped, setInstallSkipped] = useState(false)
  // One thing to do at a time: the install while there is one to do, and connecting only after it.
  // It waits for the saved sign-in to be looked for, so a tab that is already connected never sees it.
  const installFirst = !connected && Boolean(services) && !busy && hasInstallStep(install, installSkipped)
  // Counted the way the inbox shows it: one for each conversation that needs me.
  const needsMe = useMemo(() => inboxThreads(triaged).filter((item) => item.needsMe && !kept[item.message.id]).length, [triaged, kept])
  const senders = useMemo(() => messages.map((message) => message.from), [messages])
  const subjects = useMemo(() => messages.map((message) => message.subject), [messages])
  const searchActions: SearchActions = {
    find: (query, count) => services!.search.search(query, count),
    more: (next) => services!.search.more(next),
    senders: (word) => services!.search.senders(word),
    subjects: (text) => services!.search.subjects(text),
    translate: (question) => translateQuery(anthropic(), settingsRef.current.strongModel, question, new Date().toLocaleDateString('en-CA')),
    answer: (question, hits) => answerFromMail(anthropic(), settingsRef.current.strongModel, question, hits, { aboutMe: settingsRef.current.aboutMe, today: new Date().toLocaleDateString('en-CA') }),
  }

  const threadActions: ThreadActions = {
    thread: (message) => message.conversationId ? services!.mail.conversation(message.conversationId) : Promise.resolve([]),
    fromSender: async (message) => (await services!.search.search(`from:${message.from.address}`)).hits,
    related: settings.anthropicApiKey ? (message, onStep) => findRelated(anthropic(), settingsRef.current.strongModel, message, (query, count) => services!.search.search(query, count), new Date().toLocaleDateString('en-CA'), onStep) : undefined,
  }

  // `/` opens search from anywhere outside a text field.
  useEffect(() => {
    if (!connected) return
    const listen = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      if ((event.target as HTMLElement).closest?.('input, textarea, select, dialog')) return
      event.preventDefault()
      setView('search')
    }
    window.addEventListener('keydown', listen)
    return () => window.removeEventListener('keydown', listen)
  }, [connected])

  function go(next: View): void {
    setView(next)
    if (next === 'cleanup' && !cleanup.done && !cleanup.scanned) void cleanupActions.scan()
  }

  const readBody = useMemo(() => services && ((message: Message) => services.mail.content(message.id)), [services])

  const links: ShellLink[] = [
    { label: 'open outlook', onSelect: () => window.open('https://outlook.live.com/mail/0/', '_blank', 'noreferrer') },
    ...(settings.brainUrl ? [{ label: 'open my brain', onSelect: () => window.open(settings.brainUrl, '_blank', 'noreferrer') }] : []),
    ...(install.canPrompt ? [{ label: 'install app', onSelect: () => void install.install() }] : []),
  ]

  return <BodySource value={connected ? readBody : undefined}><ThreadContext value={connected ? threadActions : undefined}><Shell view={view} views={connected ? ['inbox', 'search', 'receipts', 'cleanup', 'rules', 'settings'] : ['inbox', 'rules', 'settings']} counts={connected ? { inbox: needsMe } : undefined} busy={Boolean(busy)} canRefresh={connected && !busy} links={links} onView={go} onRefresh={() => services && void run(services, { settings })}>
    {view === 'inbox' && installFirst && <InstallStep install={install} onSkip={() => setInstallSkipped(true)} />}
    {view === 'inbox' && connected && <InstallBanner install={install} />}
    {view === 'inbox' && !installFirst && <InboxView items={triaged} kept={kept} summary={summary} busy={busy} error={error} connection={connection} hasModel={Boolean(settings.anthropicApiKey)} archiveAfterReply={settings.archiveAfterReply} suggestions={suggestions} snoozes={automation.snoozes} actions={actions} more={more} onMore={() => services && void loadMore(services, { settings })}
      onConnect={connect} onDismissSuggestion={(item) => setDismissed((current) => [...current, `${item.from}|${item.action}`])} />}
    {view === 'search' && connected && <SearchView search={searchActions} actions={actions} hasModel={Boolean(settings.anthropicApiKey)} senders={senders} subjects={subjects} />}
    {view === 'receipts' && connected && <ReceiptsView actions={receiptActions} />}
    {view === 'rules' && <RulesView rules={automation.rules} outlookRules={outlookRules} snoozes={automation.snoozes} error={error} onRules={updateRules} />}
    {view === 'cleanup' && <CleanupView state={cleanup} error={error} actions={cleanupActions} onError={setError} />}
    {view === 'settings' && <SettingsView settings={settings} connection={connection} accountName={accountName} busy={Boolean(busy)} error={error} onSettings={setSettings} onConnect={connect} onDisconnect={disconnect} />}
  </Shell></ThreadContext></BodySource>
}
