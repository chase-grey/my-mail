import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { InteractionRequiredAuthError } from '@azure/msal-browser'
import { AnthropicClient } from './ai/anthropicClient'
import { JevClient, classifyWithJev, kindOf } from './ai/jev'
import { findRelated } from './ai/related'
import { answerFromMail, translateQuery } from './ai/search'
import { draftReply, readMessages, type ReadItem } from './ai/triage'
import { AppFolder } from './data/appFolder'
import { AutomationStore } from './data/automationStore'
import { Composer } from './data/compose'
import { GraphClient, GraphError } from './data/graphClient'
import { MailProvider, inboxPageSize, mailDefaultHeaders } from './data/mailProvider'
import { MailSearch } from './data/mailSearch'
import { MicrosoftAuth, configuredClientId } from './data/microsoftAuth'
import { TodoProvider } from './data/todoProvider'
import { arrivals, depthOf, dueHeld, newestOf, oldestOf, withArrivals } from './domain/arrivals'
import { holdUpdates } from './appUpdate'
import { groupBySender, keepSenderKinds, sendersToAsk, oldMail, type ScanMessage, type SenderGroup, type SenderKinds } from './domain/cleanup'
import { historyTriage, noiseSenders, senderHistoryLine } from './domain/history'
import { compileRule, planRuleSync } from './domain/outlookRules'
import { applyRules, autoRuleSenders, clearsSender, newRule, recordHits, rememberDecision, retiredSenders, suggestRules, type RuleSuggestion } from './domain/rules'
import { dueSnoozes, snoozeRecord, snoozeUntil, withoutSnoozes, type SnoozeOption } from './domain/snooze'
import { ageTriage, autoArchivable, needsReading, oldAfterDays, outlookTriage, pruneTriage, rankTriaged, sharedOf, summarize, unsureBelow, worthSharing, writeShared, type RunSummary, type Triaged } from './domain/triage'
import { emptyAutomation, type Action, type Automation, type Message, type OutlookRule, type Rule, type RuleAction, type Triage } from './domain/types'
import { inboxThreads } from './domain/threads'
import { parseUnsubscribe, unsubscribeMethod } from './domain/unsubscribe'
import { useInstallPrompt } from './installPrompt'
import { aiSorts, aiStartsItself, loadSettings, saveSettings, type Settings } from './settings'
import { Toast, type ToastState } from './ui'
import { CleanupView, type CleanupActions, type CleanupState } from './views/CleanupView'
import { Compose, type ComposeRequest } from './views/Compose'
import { InboxView } from './views/InboxView'
import { BodySource } from './views/MailBody'
import { InstallBanner, InstallStep, hasInstallStep } from './views/InstallOffer'
import { ReceiptsView, type ReceiptActions } from './views/ReceiptsView'
import { RulesView } from './views/RulesView'
import { SearchView, type SearchActions } from './views/SearchView'
import { Shell, resumeView, type ShellLink, type View } from './views/Shell'
import { SettingsView, type ConnectionStatus } from './views/SettingsView'
import { ThreadContext, type ThreadActions } from './views/Thread'
import { brainChatUrl } from './domain/brain'

const triageKey = 'my-mail.triage.v1'
const keptKey = 'my-mail.kept.v1'
const inboxKey = 'my-mail.inbox.v1'
const senderKindsKey = 'my-mail.senderKinds.v1'
/** How much of the inbox is kept on this device to show on the next open, before the mailbox has answered. */
const savedInboxSize = 200

type Services = { auth: MicrosoftAuth; mail: MailProvider; compose: Composer; search: MailSearch; todo: TodoProvider; store: AutomationStore }
/** `waiting` is mail that stayed and still wants a model, but was not allowed one this time. */
type Sorted = { inbox: Message[]; cache: Record<string, Triage>; byRules: number; autoArchived: number; filed: number; newRules: number; withoutModel: number; waiting: string[] }

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
  return { auth, mail: new MailProvider(graph), compose: new Composer(graph), search: new MailSearch(graph), todo: new TodoProvider(graph), store: new AutomationStore(new AppFolder(graph)) }
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
  /** Archives many at once and answers with the ones that moved. */
  archiveAll: (messages: Message[]) => Promise<Message[]>
  remove: (message: Message) => Promise<void>
  task: (message: Message, title: string) => Promise<void>
  /** Opens compose: a new message, or a reply, reply all, or forward of one. */
  compose: (request: ComposeRequest) => void
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
  /** Adds an archive rule for the sender. Gives back the way to take the rule away again, or nothing when a rule already clears their mail. */
  block: (message: Message) => Promise<(() => Promise<void>) | undefined>
  /** Undo: bring a message that was just archived, deleted, or snoozed back to the inbox. */
  restore: (message: Message) => Promise<void>
  /** Undo for a sweep: many come back in as few round trips as it takes. */
  restoreAll: (messages: Message[]) => Promise<void>
}

const emptyCleanup: CleanupState = { scanned: 0, groups: [], old: { count: 0, unread: 0, flagged: 0 }, done: false }

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
  const [composing, setComposing] = useState<ComposeRequest>()
  const [composeNote, setComposeNote] = useState<ToastState>()
  const [cleanup, setCleanup] = useState<CleanupState>(emptyCleanup)
  const scanRef = useRef<ScanMessage[]>([])
  /** What each sender's clear took away this visit, by address, so undo can put it back. */
  const clearedRef = useRef(new Map<string, { scan: ScanMessage[]; inbox: Message[]; ruleId?: string; action: 'archive' | 'delete' }>())
  /** What the old mail sweep took away this visit, so undo can put it back. */
  const sweptRef = useRef<{ scan: ScanMessage[]; inbox: Message[] }>({ scan: [], inbox: [] })
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
  /** Mail shown but left unsorted because this device was not the one in use, by when it was first seen. */
  const heldRef = useRef(new Map<string, number>())
  /** Mail on screen that a check is sorting right now. With the held mail, it is what waits below needs me for a verdict. */
  const sortingRef = useRef(new Set<string>())
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const syncPending = useCallback(() => {
    const next = new Set([...heldRef.current.keys(), ...sortingRef.current])
    setPending((held) => held.size === next.size && [...next].every((id) => held.has(id)) ? held : next)
  }, [])

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

  /**
   * Rules, verdicts, reading, categories, and auto-archive for one batch of fetched mail. Used for the first load and for every older page.
   * `spend` says which messages may go to Jev or Claude; the rest get only what costs nothing.
   */
  const sortBatch = useCallback(async (current: Services, batch: Message[], startCache: Record<string, Triage>, startAutomation: Automation, settings: Settings, now: string, spend: (message: Message) => boolean, onShow?: (inbox: Message[]) => void): Promise<Sorted> => {
    let inbox = batch
    let automationState = startAutomation
    const hits = applyRules(inbox, automationState.rules, now)
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
    /** Verdicts this batch made or changed; only those are written back to the mailbox. */
    const touched = new Set<string>()
    let withoutModel = 0
    const noise = noiseSenders(automationState.decisions)
    for (const message of inbox) {
      if (cache[message.id]) continue
      const verdict = outlookTriage(message, now) ?? historyTriage(message, noise, now) ?? ageTriage(message, now)
      if (verdict) { cache[message.id] = verdict; touched.add(message.id); withoutModel++ }
    }
    const history = (message: Message) => senderHistoryLine(automationState.decisions, message.from.address)
    const unsorted = inbox.filter((message) => !cache[message.id] && spend(message))
    if (settings.jevApiKey && unsorted.length && !jevUnreachable) {
      setBusy(`sorting ${unsorted.length} new ${unsorted.length === 1 ? 'message' : 'messages'}`)
      try {
        const results = await classifyWithJev(new JevClient(settings.jevApiKey), unsorted, history)
        for (const result of results) { cache[result.messageId] = result; touched.add(result.messageId) }
        withoutModel += results.length
      } catch (failure) {
        if (isNetworkFailure(failure)) jevUnreachable = true
        setError(isNetworkFailure(failure) ? "jev can't be reached from the browser" : errorText(failure))
      }
    }

    // New verdicts go onto the message, whole, so the other device reads them with the mail and pays nothing, and as a category
    // so Outlook can see them. The sure ones go while Claude reads, so a second device looking at the same mail finds them
    // sooner and a failed read does not lose them; what Claude adds is written when it lands.
    const shared = new Map<string, string>()
    const share = async (sureOnly: boolean) => {
      if (!settings.writeCategories) return
      for (const message of inbox) {
        const verdict = cache[message.id]
        if (!verdict || !touched.has(message.id) || !worthSharing(message, verdict)) continue
        if (sureOnly && verdict.confidence < unsureBelow) continue
        const text = writeShared(sharedOf(verdict))
        if (shared.get(message.id) === text) continue
        shared.set(message.id, text)
        try { await current.mail.setVerdict(message.id, message.categories, sharedOf(verdict)) } catch { /* a missing scope only costs the shared verdict */ }
      }
    }
    const sharing = share(true)

    // The language model reads only what needs me, or what nothing else could settle.
    if (settings.anthropicApiKey) {
      const toRead = inbox.filter((message) => spend(message) && needsReading(message, cache[message.id], now))
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
              touched.add(result.messageId)
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

    const canSort = Boolean(settings.anthropicApiKey) || (Boolean(settings.jevApiKey) && !jevUnreachable)
    const wantsModel = (message: Message) => cache[message.id] ? Boolean(settings.anthropicApiKey) && needsReading(message, cache[message.id], now) : canSort
    const waiting = inbox.filter((message) => !spend(message) && wantsModel(message)).map((message) => message.id)
    return { inbox, cache, byRules: removed.size, autoArchived, filed, newRules, withoutModel, waiting }
  }, [persistAutomation, pushRules])

  const run = useCallback(async (current: Services, options: { settings: Settings }) => {
    setBusy('checking mail')
    setError(undefined)
    const now = new Date().toISOString()
    lastRunRef.current = Date.now()
    leftRef.current.clear()
    backRef.current.clear()
    heldRef.current.clear()
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

      // A refresh reads back to the oldest mail already loaded, so older pages and their verdicts are not thrown away,
      // and no further: mail cleared from the list is not replaced with older mail. That comes from the end of the list.
      const since = depthOf(oldestRef.current, messagesRef.current)
      const count = Math.max(inboxPageSize, messagesRef.current.length)
      const [page, total] = await Promise.all([
        since ? current.mail.inboxSince(since, count) : current.mail.inbox(count),
        current.mail.inboxCount().catch(() => undefined),
      ])
      // More new mail than the read holds pushes the oldest off the end; the list then reaches only as far as the read did.
      oldestRef.current = since && !page.more ? since : oldestOf(page.messages)
      // A read by date ends at the depth, not at the end of the inbox; the count says whether older mail lies past it.
      const older = !since || page.more ? page.more : total === undefined ? undefined : total > page.messages.length
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
      // A key on its own starts nothing. Sorting begins when I turn it on, or by itself the first time the inbox is small
      // enough to be worth sorting; a backlog is cleared first.
      const starts = aiStartsItself(options.settings, total)
      const settings = starts ? { ...options.settings, aiSorting: true } : options.settings
      if (starts) setSettings((held) => ({ ...held, aiSorting: true }))
      const sorting = aiSorts(settings)
      const sorted = await sortBatch(current, batch, triageRef.current, automationState, settings, now, () => sorting, (read) => {
        messagesRef.current = settle(read)
        setMessages(messagesRef.current)
        sortingRef.current = new Set(sorting ? read.filter((message) => !triageRef.current[message.id]).map((message) => message.id) : [])
        syncPending()
      })
      const inbox = settle(sorted.inbox)
      const cache = pruneTriage(sorted.cache, inbox)

      triageRef.current = cache
      setTriage(cache)
      messagesRef.current = inbox
      setMessages(inbox)
      setMore((was) => older ?? was)
      setKept((current) => Object.fromEntries(Object.entries(current).filter(([id]) => inbox.some((message) => message.id === id))))
      const counted = summarize(inbox.map((message) => ({ message, triage: cache[message.id] })), { byRules: sorted.byRules, autoArchived: sorted.autoArchived, returned, withoutModel: sorted.withoutModel })
      setSummary({ ...counted, inbox: Math.max(inbox.length, (total ?? 0) - sorted.byRules - sorted.autoArchived), filed: sorted.filed, newRules: sorted.newRules, fromJunk: rescued.length })
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      sortingRef.current = new Set()
      syncPending()
      setBusy(undefined)
    }
  }, [pushRules, sortBatch, syncPending])

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
      // Only the device in use pays to sort new mail the moment it lands. One nobody is using shows it and waits,
      // then reads it again: by then the other device has usually written its verdict onto the message.
      const inUse = document.hasFocus()
      const onScreen = new Set(messagesRef.current.map((message) => message.id))
      for (const id of heldRef.current.keys()) if (!onScreen.has(id)) heldRef.current.delete(id)
      const due = new Set(dueHeld(heldRef.current, Date.now(), inUse))
      let gone: string[] = []
      try {
        // One inbox: junk is emptied before the inbox is read, here as in the full check.
        // The look itself is ids and a count. Mail is read in full only when there is something to read.
        const since = newestSeenRef.current
        const glance = await current.mail.glance(since)
        const news = glance.ids.some((id) => !onScreen.has(id) && !leftRef.current.has(id))
        if (!glance.junk && !news && !due.size) return
        if (glance.junk) rescued = await current.mail.rescueJunk()
        if (due.size) {
          const oldestDue = oldestOf(messagesRef.current.filter((message) => due.has(message.id)))
          const from = since && oldestDue ? (oldestDue < since ? oldestDue : since) : undefined
          const page = from ? await current.mail.inboxSince(from) : await current.mail.inbox()
          found = page.messages
          // Held mail the mailbox no longer lists was put away on the other device.
          if (!page.more) gone = [...due].filter((id) => !found.some((message) => message.id === id))
        } else if (news) {
          found = (since ? await current.mail.inboxSince(since) : await current.mail.inbox()).messages
        }
      } catch {
        // A look that fails says nothing; the next one is seconds away, and a full check reports what is wrong.
        return
      }
      // A full check that started in the meantime reads these itself.
      if (lastRunRef.current !== lastRun || busyRef.current) return
      newestSeenRef.current = newestOf(found, newestSeenRef.current)
      for (const id of due) heldRef.current.delete(id)
      if (gone.length) {
        const away = new Set(gone)
        const here = messagesRef.current.filter((message) => away.has(message.id))
        messagesRef.current = messagesRef.current.filter((message) => !away.has(message.id))
        setMessages(messagesRef.current)
        setSummary((summary) => summary ? { ...summary, inbox: summary.inbox - here.length } : summary)
      }
      const fresh = arrivals([...found, ...rescued], messagesRef.current.filter((message) => !due.has(message.id)), leftRef.current)
      if (!fresh.length) return

      busyRef.current = 'checking mail'
      setBusy('checking mail')
      setError(undefined)
      const batch = new Set(fresh.map((message) => message.id))
      const sorting = aiSorts(options.settings)
      const show = (inbox: Message[]) => {
        messagesRef.current = withArrivals(messagesRef.current, batch, inbox, leftRef.current)
        setMessages(messagesRef.current)
        sortingRef.current = new Set(sorting ? inbox.filter((message) => !triageRef.current[message.id]).map((message) => message.id) : [])
        syncPending()
      }
      try {
        const sorted = await sortBatch(current, fresh, triageRef.current, automationRef.current, options.settings, new Date().toISOString(), (message) => sorting && (inUse || due.has(message.id)), show)
        show(sorted.inbox)
        if (sorting) for (const id of sorted.waiting) heldRef.current.set(id, Date.now())
        const stayed = sorted.inbox.filter((message) => !leftRef.current.has(message.id))
        const stayedIds = new Set(stayed.map((message) => message.id))
        const cache = { ...triageRef.current }
        for (const message of stayed) if (sorted.cache[message.id]) cache[message.id] = sorted.cache[message.id]
        triageRef.current = cache
        setTriage(cache)
        setSummary((summary) => summary ? {
          ...summary,
          // Held mail was counted when it first showed; only its verdict is new.
          inbox: summary.inbox + stayed.filter((message) => !due.has(message.id)).length - fresh.filter((message) => due.has(message.id) && !stayedIds.has(message.id)).length,
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
        sortingRef.current = new Set()
        setBusy(undefined)
      }
    } finally {
      syncPending()
      peekingRef.current = false
    }
  }, [run, sortBatch, syncPending])

  /** The next page of older mail, put through the same sorting as the first. */
  const loadMore = useCallback(async (current: Services, options: { settings: Settings }, spend = true) => {
    const before = oldestRef.current
    if (!before) { setMore(false); return }
    setBusy('loading more')
    setError(undefined)
    try {
      const page = await current.mail.inbox(inboxPageSize, before)
      const have = new Set(messagesRef.current.map((message) => message.id))
      const fresh = page.messages.filter((message) => !have.has(message.id))
      // A page loaded only to be archived is not worth a model's time.
      const sorting = spend && aiSorts(options.settings)
      const sorted = await sortBatch(current, fresh, triageRef.current, automationRef.current, options.settings, new Date().toISOString(), () => sorting)
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

  // Turning sorting on sorts what is already on screen, instead of waiting for the next check.
  const sortingOn = aiSorts(settings)
  const wasSorting = useRef(sortingOn)
  useEffect(() => {
    const turnedOn = sortingOn && !wasSorting.current
    wasSorting.current = sortingOn
    if (turnedOn && services && connection === 'connected' && lastRunRef.current && !busyRef.current) void run(services, { settings: settingsRef.current })
  }, [sortingOn, services, connection, run])

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
      if (!services || !list.length) return []
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
        await persistAutomation({ ...automationRef.current, decisions: moved.reduce((decisions, message) => rememberDecision(decisions, message, 'archive', at, undefined, isReceipt(message)), automationRef.current.decisions) }).catch((failure: unknown) => setError(errorText(failure)))
        return moved
      } catch (failure) {
        setError(errorText(failure))
        return []
      }
    },
    remove: (message) => decide(message, 'delete', () => services!.mail.delete(message.id)),
    task: (message, title) => decide(message, 'task', async () => {
      await services!.todo.createTask({ title: title.trim() || message.subject, note: triageRef.current[message.id]?.summary, message })
      await services!.mail.archive(message.id)
    }),
    compose: (request) => setComposing(request),
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
    block: async (message) => {
      const from = message.from.address.trim().toLowerCase()
      if (!from) throw new Error('this mail has no sender address')
      if (automationRef.current.rules.some((rule) => clearsSender(rule, from))) return undefined
      setError(undefined)
      try {
        const rule = newRule({ from, action: 'archive' }, crypto.randomUUID(), new Date().toISOString())
        await updateRules([...automationRef.current.rules, rule])
        return () => updateRules(automationRef.current.rules.filter((item) => item.id !== rule.id))
      } catch (failure) {
        setError(errorText(failure))
        throw failure
      }
    },
    restore: async (message) => {
      if (!services) throw new Error('connect microsoft first')
      setError(undefined)
      try {
        await services.mail.move(message.id, 'inbox')
        // Archiving marked it read; mail that was unread comes back unread.
        if (!message.isRead) await services.mail.markRead(message.id, false)
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
    restoreAll: async (list) => {
      if (!services || !list.length) return
      setError(undefined)
      // Thousands of moves take minutes; a new build waits for them.
      const release = holdUpdates()
      try {
        const stuck = new Set(await services.mail.moveMany(list.map((message) => message.id), 'inbox'))
        const back = list.filter((message) => !stuck.has(message.id))
        // Archiving marked them read; mail that was unread comes back unread.
        await services.mail.readMany(back.filter((message) => !message.isRead).map((message) => message.id), false)
        const ids = new Set(back.map((message) => message.id))
        for (const message of back) { leftRef.current.delete(message.id); backRef.current.set(message.id, message) }
        const have = new Set(messagesRef.current.map((message) => message.id))
        const returned = back.filter((message) => !have.has(message.id))
        setMessages((current) => [...current, ...returned])
        setSummary((current) => current ? { ...current, inbox: current.inbox + returned.length, needReply: current.needReply + returned.filter((message) => triageRef.current[message.id]?.needsReply).length } : current)
        if (stuck.size) setError(notMoved(stuck.size))
        const state = automationRef.current
        await persistAutomation({ ...state, snoozes: withoutSnoozes(state.snoozes, [...ids]), decisions: state.decisions.filter((decision) => !ids.has(decision.messageId)) })
      } catch (failure) {
        setError(errorText(failure))
        throw failure
      } finally {
        release()
      }
    },
  }

  /** After a reply to mail in the inbox goes out, the original is archived or marked read, and the reply is remembered. */
  async function sent(request: ComposeRequest): Promise<void> {
    const { message } = request
    if (message && request.onCard && request.mode !== 'forward') {
      const archives = settingsRef.current.archiveAfterReply
      await decide(message, 'reply', () => archives ? services!.mail.archive(message.id) : services!.mail.markRead(message.id), archives)
    }
    request.onSent?.()
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
      sweptRef.current = { scan: [], inbox: [] }
      try {
        const scanned = await services.mail.scanInbox((count) => setCleanup((current) => ({ ...current, scanned: count })))
        scanRef.current = scanned
        const groups = groupBySender(scanned)
        const jevKey = settingsRef.current.jevApiKey
        // A sender Jev has already been asked about is not asked again; a scan during a long cleanup costs only its new senders.
        const known = keepSenderKinds(groups, readJson<SenderKinds>(senderKindsKey, {}))
        const candidates = jevKey && aiSorts(settingsRef.current) ? sendersToAsk(groups, known) : []
        const labelled = (list: SenderGroup[], kinds: SenderKinds) => list.map((group) => kinds[group.address] ? { ...group, kind: kinds[group.address].kind, kindConfidence: kinds[group.address].confidence } : group)
        // The lists stay hidden until the senders are sorted, so none of them changes section after it is on screen.
        setCleanup({ scanned: scanned.length, total: scanned.length, groups: labelled(groups, known), old: oldCount(), done: !candidates.length })
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
    markNotNoise: async (group, on) => {
      const others = (automationRef.current.noRules ?? []).filter((address) => address !== group.address)
      await persistAutomation({ ...automationRef.current, noRules: on ? [...others, group.address] : others })
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
        if (taken?.action === 'archive') await services.mail.readMany(taken.scan.filter((message) => !message.isRead).map((message) => message.id), false)
        clearedRef.current.delete(group.address)
        const back = new Set(scanRef.current.map((message) => message.id))
        scanRef.current = [...scanRef.current, ...(taken?.scan ?? []).filter((message) => !back.has(message.id))]
        setCleanup((current) => ({ ...current, working: undefined, total: (current.total ?? current.scanned) + group.count, groups: current.groups.map((item) => item.address === group.address ? { ...item, cleared: undefined, ruled: undefined } : item), old: oldCount() }))
        const inbox = taken?.inbox ?? []
        putBack(inbox)
        await persistAutomation({ ...automationRef.current, decisions: automationRef.current.decisions.filter((decision) => decision.messageId !== group.sample.id) })
      } finally {
        setCleanup((current) => ({ ...current, working: undefined }))
      }
    },
    unsubscribe: (group) => unsubscribeFrom(group.sample.id, undefined, group.address),
    archiveOld: async () => {
      if (!services) return
      const ids = oldMail(scanRef.current, oldAfterDays).ids
      if (!ids.length) return
      setError(undefined)
      setCleanup((current) => ({ ...current, working: `archiving ${ids.length}` }))
      // Thousands of moves take minutes; a new build waits for them.
      const release = holdUpdates()
      let stuck: string[]
      try {
        stuck = await services.mail.archiveMany(ids, (done) => setCleanup((current) => ({ ...current, working: `archived ${done} of ${ids.length}` })))
      } catch (failure) {
        setCleanup((current) => ({ ...current, working: undefined }))
        setError(errorText(failure))
        return
      } finally {
        release()
      }
      const kept = new Set(stuck)
      const gone = new Set(ids.filter((id) => !kept.has(id)))
      const here = messagesRef.current.filter((message) => gone.has(message.id))
      sweptRef.current = { scan: [...sweptRef.current.scan, ...scanRef.current.filter((message) => gone.has(message.id))], inbox: [...sweptRef.current.inbox, ...here] }
      scanRef.current = scanRef.current.filter((message) => !gone.has(message.id))
      setCleanup((current) => ({ ...current, working: undefined, total: scanRef.current.length, groups: settle(current.groups), old: oldCount(), swept: sweptRef.current.scan.length || undefined }))
      drop(here)
      if (stuck.length) setError(notMoved(stuck.length))
    },
    undoOld: async () => {
      if (!services) return
      const taken = sweptRef.current
      if (!taken.scan.length) return
      setError(undefined)
      setCleanup((current) => ({ ...current, working: `bringing back ${taken.scan.length}` }))
      const release = holdUpdates()
      let stuck: string[]
      try {
        stuck = await services.mail.moveMany(taken.scan.map((message) => message.id), 'inbox', (done) => setCleanup((current) => ({ ...current, working: `brought back ${done} of ${taken.scan.length}` })))
      } catch (failure) {
        setCleanup((current) => ({ ...current, working: undefined }))
        setError(errorText(failure))
        return
      } finally {
        release()
      }
      const kept = new Set(stuck)
      await services.mail.readMany(taken.scan.filter((message) => !message.isRead && !kept.has(message.id)).map((message) => message.id), false).catch((failure: unknown) => setError(errorText(failure)))
      const have = new Set(scanRef.current.map((message) => message.id))
      scanRef.current = [...scanRef.current, ...taken.scan.filter((message) => !kept.has(message.id) && !have.has(message.id))]
      sweptRef.current = { scan: taken.scan.filter((message) => kept.has(message.id)), inbox: taken.inbox.filter((message) => kept.has(message.id)) }
      setCleanup((current) => ({ ...current, working: undefined, total: scanRef.current.length, groups: settle(current.groups), old: oldCount(), swept: sweptRef.current.scan.length || undefined }))
      putBack(taken.inbox.filter((message) => !kept.has(message.id)))
      if (stuck.length) setError(notMoved(stuck.length))
    },
  }

  function oldCount(): CleanupState['old'] {
    const old = oldMail(scanRef.current, oldAfterDays)
    return { count: old.ids.length, unread: old.unread, flagged: old.flagged }
  }

  /** Mail a bulk undo returned to the inbox goes back on the list and the counts, and the next read leaves it there. */
  function putBack(inbox: Message[]): void {
    if (!inbox.length) return
    for (const message of inbox) { leftRef.current.delete(message.id); backRef.current.set(message.id, message) }
    setMessages((current) => [...current, ...inbox.filter((message) => !current.some((item) => item.id === message.id))])
    setSummary((current) => current ? { ...current, inbox: current.inbox + inbox.length, needReply: current.needReply + inbox.filter((message) => triageRef.current[message.id]?.needsReply).length } : current)
  }

  /** The sender list after a sweep or its undo: rows keep their place, a sender with nothing left goes, cleared rows keep their undo. */
  function settle(previous: SenderGroup[]): SenderGroup[] {
    const now = new Map(regroup(previous).map((group) => [group.address, group]))
    const seen = new Set(previous.map((group) => group.address))
    return [
      ...previous.flatMap((group) => group.cleared ? [group] : now.has(group.address) ? [now.get(group.address)!] : []),
      ...[...now.values()].filter((group) => !seen.has(group.address)),
    ]
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
        setCleanup((current) => ({ ...current, total: (current.total ?? current.scanned) - moved.size, groups: current.groups.map((item) => item.address === group.address && rest ? { ...rest, kind: item.kind, kindConfidence: item.kindConfidence } : item), old: oldCount() }))
        drop(messages.filter((message) => moved.has(message.id)))
        throw new Error(notMoved(stuck.length))
      }
      const gone = new Set(group.ids)
      clearedRef.current.set(group.address, { scan: scanRef.current.filter((message) => gone.has(message.id)), inbox: messagesRef.current.filter((message) => gone.has(message.id)), ruleId, action })
      scanRef.current = scanRef.current.filter((message) => !gone.has(message.id))
      setCleanup((current) => ({ ...current, working: undefined, total: (current.total ?? current.scanned) - group.count, groups: current.groups.map((item) => item.address === group.address ? { ...item, cleared: action, ruled: Boolean(ruleId) } : item), old: oldCount() }))
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
    forward: (message) => setComposing({ mode: 'forward', message }),
  }

  const suggestions = useMemo<RuleSuggestion[]>(() => suggestRules(automation.decisions, automation.rules, automation.noRules).filter((item) => !dismissed.includes(`${item.from}|${item.action}`)), [automation, dismissed])
  const triaged = useMemo<Triaged[]>(() => rankTriaged(messages.map((message) => ({ message, triage: triage[message.id], pending: pending.has(message.id) }))), [messages, triage, pending])
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
    chat: settings.brainUrl.trim() ? (message) => { window.open(brainChatUrl(settings.brainUrl, message.id), '_blank', 'noreferrer') } : undefined,
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
    ...(settings.brainUrl ? [{ label: 'open my brain', onSelect: () => window.open(settings.brainUrl, '_blank', 'noreferrer') }] : []),
    ...(install.canPrompt ? [{ label: 'install app', onSelect: () => void install.install() }] : []),
  ]

  return <BodySource value={connected ? readBody : undefined}><ThreadContext value={connected ? threadActions : undefined}><Shell view={view} views={connected ? ['inbox', 'search', 'receipts', 'cleanup', 'rules', 'settings'] : ['inbox', 'rules', 'settings']} counts={connected ? { inbox: needsMe, rules: suggestions.length } : undefined} busy={Boolean(busy)} status={connected ? busy : undefined} canRefresh={connected && !busy} links={links} onView={go} onRefresh={() => services && void run(services, { settings })} onCompose={connected ? () => setComposing({ mode: 'new' }) : undefined}>
    {view === 'inbox' && installFirst && <InstallStep install={install} onSkip={() => setInstallSkipped(true)} />}
    {view === 'inbox' && connected && <InstallBanner install={install} />}
    {view === 'inbox' && !installFirst && <InboxView items={triaged} kept={kept} summary={summary} busy={busy} error={error} connection={connection} archiveAfterReply={settings.archiveAfterReply} snoozes={automation.snoozes} actions={actions} more={more} onMore={(sweeping) => services ? loadMore(services, { settings }, !sweeping) : undefined}
      onConnect={connect} />}
    {view === 'search' && connected && <SearchView search={searchActions} actions={actions} hasModel={Boolean(settings.anthropicApiKey)} senders={senders} subjects={subjects} />}
    {view === 'receipts' && connected && <ReceiptsView actions={receiptActions} />}
    {view === 'rules' && <RulesView rules={automation.rules} outlookRules={outlookRules} snoozes={automation.snoozes} suggestions={suggestions} error={error} onRules={updateRules} onDismissSuggestion={(item) => setDismissed((current) => [...current, `${item.from}|${item.action}`])} />}
    {view === 'cleanup' && <CleanupView state={{ ...cleanup, notNoise: automation.noRules }} error={error} actions={cleanupActions} onError={setError} />}
    {view === 'settings' && <SettingsView settings={settings} connection={connection} accountName={accountName} busy={Boolean(busy)} error={error} onSettings={setSettings} onConnect={connect} onDisconnect={disconnect} />}
    {composing && services && <Compose key={`${composing.mode}:${composing.message?.id ?? ''}`} request={composing} actions={services.compose} contacts={senders}
      onDraft={settings.anthropicApiKey && composing.message && composing.mode !== 'forward' ? (strong, instruction) => actions.draft(composing.message!, strong, instruction) : undefined}
      onSent={() => sent(composing)} onClose={(note) => { setComposing(undefined); if (note) setComposeNote({ key: Date.now(), text: note }) }} />}
    <Toast toast={composeNote} onDone={() => setComposeNote(undefined)} />
  </Shell></ThreadContext></BodySource>
}
