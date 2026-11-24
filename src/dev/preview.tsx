import { StrictMode, useState } from 'react'
import { Toast, type ToastState } from '../ui'
import { createRoot } from 'react-dom/client'
import type { MessageActions } from '../App'
import { groupBySender } from '../domain/cleanup'
import { groupInbox, rankTriaged, type Triaged } from '../domain/triage'
import type { MailContent } from '../domain/mailHtml'
import type { Action, Category, Message } from '../domain/types'
import type { ComposeActions, DraftAttachment } from '../data/compose'
import { CleanupView, type CleanupActions } from '../views/CleanupView'
import { Compose, type ComposeRequest } from '../views/Compose'
import { InboxView } from '../views/InboxView'
import { BodySource } from '../views/MailBody'
import { ReceiptsView } from '../views/ReceiptsView'
import { RulesView } from '../views/RulesView'
import { SearchView, type SearchActions } from '../views/SearchView'
import { SettingsView } from '../views/SettingsView'
import { Shell, type View } from '../views/Shell'
import { ThreadContext, type ThreadActions } from '../views/Thread'
import { defaultSettings } from '../settings'
import '../styles.css'

// Made-up mail for looking at the interface without a mailbox. Open /dev/preview.html while `npm run dev` runs.
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

function mail(id: number, name: string, subject: string, body: string, category: Category, suggested: Action, summary: string, extra: Partial<Message> = {}, confidence = 0.92): Triaged {
  const address = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`
  return {
    message: { id: `m${id}`, subject, from: { name, address }, receivedAt: hoursAgo(id * 5), preview: body.slice(0, 90), body, isRead: id % 3 === 0, flagged: false, importance: 'normal', hasAttachments: false, categories: [], webLink: 'https://example.com/', ...extra },
    triage: { messageId: `m${id}`, category, summary, needsReply: category === 'reply', suggested, draft: category === 'reply' ? 'Sounds good, see you then.' : undefined, confidence, source: 'model', triagedAt: hoursAgo(0) },
  }
}

const long = 'Hi,\n\nDoes five work on Sunday? Dad is doing the roast again and wants to know how many to plan for. Bring a salad if you can, and the folding chairs from the garage.\n\nAlso, the photos from the lake finally came back. I put the good ones in the shared album. There is one of the dog mid-jump that you have to see.\n\nLove,\nMom'

const seed: Triaged[] = [
  mail(1, 'Ruth Calder', 'Dinner Sunday?', long, 'reply', 'reply', 'asks if 5pm sunday works, bring a salad and the folding chairs'),
  mail(2, 'Linden County Treasurer', 'Property tax statement', 'Your second installment is due January 31. Amount due: $2,140.00. Pay online or by mail.', 'action', 'task', 'second installment due jan 31, $2,140', { hasAttachments: true }),
  mail(3, 'Owen Marsh', 'Re: cabin weekend', 'I can drive if someone else books the place. Are we still thinking the second weekend of February?', 'reply', 'reply', 'will drive if someone books; wants the february weekend confirmed', { flagged: true, conversationId: 'cabin' }),
  mail(4, 'Northside Dental', 'Your appointment is confirmed', 'This confirms your cleaning on Tuesday, December 8 at 9:40 am. Reply C to confirm.', 'waiting', 'keep', 'cleaning tuesday dec 8 at 9:40'),
  mail(5, 'Harbor Outfitters', 'Members: 20% off through Sunday', 'Members save 20% on one full-price item and an extra 20% on one outlet item.', 'promo', 'archive', '20% off one item through sunday', {}, 0.72),
  mail(6, 'The Weekly Fold', 'Issue 214: slow mornings', 'This week: a case for doing less before nine, three recipes, and a reader letter.', 'newsletter', 'archive', 'weekly newsletter, issue 214'),
  mail(7, 'Parcel Post', 'Your package was delivered', 'Delivered to front door at 2:14 pm.', 'notification', 'archive', 'package delivered to the front door'),
  mail(8, 'Fernway Market', 'Your receipt', 'Order total $48.12. Thanks for shopping with us.', 'receipt', 'archive', 'receipt for $48.12'),
  mail(9, 'Cloud Storage', 'Storage almost full', 'You have used 92% of your storage.', 'notification', 'archive', 'storage at 92%', {}, 0.81),
  mail(10, 'Juniper Books', 'New this week', 'Staff picks and a signed first edition.', 'promo', 'archive', 'staff picks'),
  mail(11, 'Trail Club', 'January trail report', 'Conditions, closures, and volunteer days.', 'newsletter', 'archive', 'monthly trail report'),
  mail(12, 'Ida Voss', 'Old photos', 'Found these in the attic, thought you would want them.', 'fyi', 'keep', 'sent old photos from the attic', { hasAttachments: true }),
  mail(13, 'Tess Arnett', 'Re: cabin weekend', 'I found two places near the lake. One sleeps six and has a wood stove. Sending links tonight.', 'fyi', 'archive', 'found two places near the lake, links tonight', { conversationId: 'cabin' }),
  mail(14, 'Owen Marsh', 'cabin weekend', 'Who is in for a cabin weekend this winter? Thinking February.', 'fyi', 'archive', 'asks who is in for a cabin weekend in february', { conversationId: 'cabin' }),
]

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// What the mailbox would send for an open message: a plain note, a note written in Outlook, a designed mailing, and bare text.
const picture = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="600" height="200" fill="#2f5d50"/><text x="300" y="112" font-family="sans-serif" font-size="36" fill="#fff" text-anchor="middle">Harbor Outfitters</text></svg>')}`
const mailing = `<html><body style="margin:0;background-color:#f2efe9"><table width="600" align="center" cellpadding="0" cellspacing="0" style="background-color:#ffffff;font-family:Georgia,serif"><tr><td><img src="${picture}" width="600" height="200" alt="Harbor Outfitters"></td></tr><tr><td style="padding:28px 36px;color:#222222"><h1 style="margin:0 0 12px;font-size:28px">Members: 20% off through Sunday</h1><p style="font-size:16px;line-height:24px">Members save 20% on one full-price item and an extra 20% on one outlet item. To start a <a href="https://example.com/return" style="color:#2f5d50">return</a>, bring your order number.</p><p><a href="https://example.com/shop" style="display:inline-block;padding:12px 28px;background-color:#2f5d50;color:#ffffff;text-decoration:none;border-radius:4px">shop the sale</a></p></td></tr><tr><td style="padding:16px 36px;background-color:#e7e2d8;color:#666666;font-size:12px">You are receiving this because you are a member. <a href="https://example.com/unsubscribe" style="color:#666666">Unsubscribe</a></td></tr></table></body></html>`
const contents: Record<string, MailContent> = {
  // Sent dark already: darkening it would turn it light, so it is left as it is.
  m6: { html: '<html><body style="margin:0"><table width="100%" cellpadding="0" cellspacing="0" style="background-color:#14161c;font-family:Georgia,serif"><tr><td style="padding:28px 32px;color:#e8e6e0"><h1 style="margin:0 0 12px;font-size:26px;color:#f3c26b">Issue 214: slow mornings</h1><p style="font-size:16px;line-height:24px">This week: a case for doing less before nine, three recipes, and a reader letter. <a href="https://example.com/issue" style="color:#f3c26b">read the issue</a></p></td></tr></table></body></html>', text: '' },
  m1: { html: `<html><body>${long.split('\n\n').map((part) => `<p>${part.replace(/\n/g, '<br>')}</p>`).join('')}<p>The album is <a href="https://example.com/album">here</a>.</p></body></html>`, text: '' },
  m2: { text: 'Your second installment is due January 31.\n\nAmount due: $2,140.00\n\nPay online at https://example.com/pay or by mail.\n\nLinden County Treasurer' },
  m3: { html: '<html><body><div style="font-family:Calibri,sans-serif;font-size:11pt;color:rgb(0,0,0)">I can drive if someone else books the place. Are we still thinking the second weekend of February?</div><div style="font-family:Calibri,sans-serif;font-size:11pt;color:rgb(0,0,0)"><br>The listing is <a href="https://example.com/cabin">here</a>.</div></body></html>', text: '' },
  m5: { html: mailing, text: '' },
}
const readBody = async (message: Message): Promise<MailContent> => {
  await wait(250)
  return contents[message.id] ?? (message.id.startsWith('r') ? { html: mailing.replace('Members: 20% off through Sunday', message.subject), text: '' } : { html: `<html><body><p>${message.body}</p></body></html>`, text: '' })
}

// A conversation reaches past the inbox: the reply I sent is in it too.
const sent: Message = { ...seed[2].message, id: 'sent1', from: { name: 'Sam Calder', address: 'sam@example.com' }, receivedAt: hoursAgo(40), preview: 'I am in. February works, the second weekend is best for me.', body: 'I am in. February works, the second weekend is best for me.', isRead: true, flagged: false }
const elsewhere = (item: Triaged, hours: number, subject: string, folder = 'Archive') => ({ message: { ...item.message, id: `${item.message.id}-${hours}`, conversationId: `${item.message.id}-${hours}`, subject, receivedAt: hoursAgo(hours) }, inInbox: false, folder })
const threads: ThreadActions = {
  thread: async (message) => {
    await wait(300)
    return message.conversationId === 'cabin' ? [...seed.filter((item) => item.message.conversationId === 'cabin').map((item) => item.message), sent].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)) : []
  },
  fromSender: async (message) => {
    await wait(400)
    const item = seed.find((entry) => entry.message.from.address === message.from.address) ?? seed[0]
    return [elsewhere(item, 300, 'Lake photos'), elsewhere(item, 2200, 'Re: your birthday'), elsewhere(item, 9000, 'Recipe you asked for', 'Sent Items')]
  },
  related: async (_message, onStep) => {
    await wait(500); onStep('searching'); await wait(500); onStep('reading 14 messages'); await wait(700)
    return [elsewhere(seed[11], 700, 'Lake house deposit'), elsewhere(seed[1], 5000, 'Cabin rental agreement')]
  },
}

const found = () => seed.slice(0, 4).map((item, index) => ({ message: { ...item.message, receivedAt: hoursAgo(index * 4000 + 30) }, inInbox: index === 0, folder: index === 0 ? undefined : 'Archive' }))
const search: SearchActions = {
  find: async (query, count) => { await wait(400); return query.includes('nothing') ? { hits: [] } : { hits: found(), next: count ? undefined : 'next' } },
  more: async () => { await wait(400); return { hits: seed.slice(4, 8).map((item) => ({ message: item.message, inInbox: false, folder: 'Archive' })) } },
  translate: async () => { await wait(500); return 'treasurer (tax OR installment) received>=2026-01-01' },
  answer: async () => { await wait(700); return 'The second installment is $2,140.00 and is due January 31 [2]. Nothing in these messages says it has been paid [1].' },
}

// Clean up reads thousands of messages; a few senders with several each is enough to see the screen.
const scanned = seed.flatMap((item, at) => Array.from({ length: (at % 4) * 3 + 1 }, (_, copy) => ({ id: `${item.message.id}-${copy}`, from: item.message.from, subject: item.message.subject, preview: item.message.preview, receivedAt: hoursAgo(at * 30 + copy * 200), isRead: copy > 0, flagged: false })))
const senders = groupBySender(scanned).map((group) => ({ ...group, kind: seed.find((item) => item.message.from.address === group.address)?.triage?.category }))
const cleanupActions: CleanupActions = { scan: async () => {}, archiveSender: () => wait(400), deleteSender: () => wait(400), blockSender: () => wait(400), undoSender: () => wait(400), unsubscribe: async (group) => `unsubscribed from ${group.address}`, archiveStale: () => wait(400) }
const receipts = Array.from({ length: 9 }, (_, at) => ({ ...seed[7].message, id: `r${at}`, from: at % 2 ? seed[7].message.from : { name: 'Harbor Outfitters', address: 'orders@harbor.example.com' }, subject: at % 2 ? 'Your receipt' : `Order ${4100 + at} confirmed`, receivedAt: hoursAgo(at * 190 + 20), body: `Order total $${(48.12 + at * 13.5).toFixed(2)}. Thanks for shopping with us.\n\nItems\n1 x olive oil\n2 x sourdough\n\nPaid with card ending 4417.` }))

// Compose against a made-up mailbox: a reply comes back addressed, a forward brings the original's file.
let attached: DraftAttachment[] = []
const composeActions: ComposeActions = {
  start: async (mode, id) => {
    await wait(400)
    const from = seed.find((item) => item.message.id === id)?.message
    attached = mode === 'forward' ? [{ id: 'a0', name: 'statement-2026.pdf', size: 184_000 }] : []
    return {
      id: 'draft',
      to: mode === 'new' || mode === 'forward' || !from ? [] : [from.from],
      cc: mode === 'replyAll' ? [{ name: 'Tess Arnett', address: 'tess.arnett@example.com' }] : [],
      subject: from ? `${mode === 'forward' ? 'FW' : 'RE'}: ${from.subject}` : '',
      quoted: { contentType: 'html', content: '<body>earlier</body>' },
      attachments: attached,
    }
  },
  attach: async (_id, file) => { await wait(900); attached = [...attached, { id: crypto.randomUUID(), name: file.name, size: file.size }]; return attached },
  detach: async (_id, attachment) => { await wait(200); attached = attached.filter((item) => item.id !== attachment) },
  save: () => wait(400),
  send: () => wait(700),
  discard: () => wait(100),
}

function Preview() {
  const params = new URLSearchParams(window.location.search)
  const [view, setView] = useState<View>((params.get('view') as View) || 'inbox')
  const [items, setItems] = useState(params.has('empty') ? [] : seed)
  const [kept, setKept] = useState<Record<string, string>>({ m12: 'now' })
  const asked = params.get('compose') as ComposeRequest['mode'] | null
  const [composing, setComposing] = useState<ComposeRequest | undefined>(asked ? { mode: asked, message: asked === 'new' ? undefined : seed[2].message, text: asked === 'reply' ? 'Sounds good, see you then.' : '' } : undefined)
  const [note, setNote] = useState<ToastState>()
  const drop = (ids: string[]) => setItems((current) => current.filter((item) => !ids.includes(item.message.id)))
  const gone = async (message: Message) => { await wait(350); drop([message.id]) }

  const actions: MessageActions = {
    archive: gone,
    isReceipt: () => false,
    archiveAll: async (messages) => { await wait(500); drop(messages.map((message) => message.id)) },
    remove: gone,
    task: gone,
    compose: (request) => setComposing(request),
    draft: async () => { await wait(600); return 'Five works. I will bring a salad and the chairs.' },
    snooze: gone,
    keep: async (message) => { await wait(200); setKept((current) => ({ ...current, [message.id]: 'now' })) },
    flag: async (message) => setItems((current) => current.map((item) => item.message.id === message.id ? { ...item, message: { ...item.message, flagged: !item.message.flagged } } : item)),
    unsubscribe: async (message) => `unsubscribed from ${message.from.address}`,
    makeRule: async () => wait(200),
    restore: async (message) => { await wait(250); setItems((current) => rankTriaged([...current, ...seed.filter((item) => item.message.id === message.id)])) },
  }

  return <BodySource value={readBody}><ThreadContext value={threads}><Shell view={view} views={['inbox', 'search', 'receipts', 'cleanup', 'rules', 'settings']} counts={{ inbox: groupInbox(items.filter((item) => !kept[item.message.id])).needsMe.length }} busy={params.has('busy')} canRefresh links={[{ label: 'open my brain', onSelect: () => {} }]} onView={setView} onRefresh={() => setItems(seed)} onCompose={() => setComposing({ mode: 'new' })}>
    {view === 'inbox' && <InboxView items={items} kept={kept} summary={{ inbox: items.length, needReply: items.filter((item) => item.triage?.needsReply).length, byRules: 14, autoArchived: 0, returned: 0, withoutModel: 0 }} busy={params.has('busy') ? 'checking mail' : undefined} connection="connected"
      suggestions={[{ from: 'news@weeklyfold.example.com', action: 'archive', count: 4 }]} snoozes={[]} actions={actions} onConnect={async () => {}} onDismissSuggestion={() => {}} />}
    {view === 'search' && <SearchView search={search} actions={actions} hasModel senders={seed.map((item) => item.message.from)} subjects={seed.map((item) => item.message.subject)} />}
    {view === 'receipts' && <ReceiptsView actions={{ load: async () => { await wait(300); return { messages: receipts, more: true } }, fromArchive: async () => { await wait(600); return 3 }, toInbox: () => wait(300), forward: (message) => setComposing({ mode: 'forward', message }) }} />}
    {view === 'cleanup' && <CleanupView state={{ scanned: scanned.length, total: scanned.length, groups: senders, staleCount: 6, done: true }} actions={cleanupActions} onError={() => {}} />}
    {view === 'rules' && <RulesView rules={[{ id: 'r1', from: '@harbor.example.com', action: 'archive', enabled: true, createdAt: 'now', hits: 12, outlookId: 'o1' }, { id: 'r2', subject: 'receipt', action: 'read', enabled: true, createdAt: 'now', hits: 3 }]} outlookRules={[]} snoozes={[{ messageId: 's1', until: new Date(Date.now() + 86_400_000).toISOString(), subject: 'Renew passport', from: 'Travel Office' }]} onRules={async () => {}} />}
    {view === 'settings' && <SettingsView settings={defaultSettings} connection="connected" accountName="someone@example.com" busy={false} onSettings={() => {}} onConnect={async () => {}} onDisconnect={async () => {}} />}
    {composing && <Compose key={`${composing.mode}:${composing.message?.id ?? ''}`} request={composing} actions={composeActions} contacts={seed.map((item) => item.message.from)}
      onDraft={composing.message && composing.mode !== 'forward' ? actions.draft.bind(undefined, composing.message) : undefined}
      onSent={() => composing.onSent?.()} onClose={(text) => { setComposing(undefined); if (text) setNote({ key: Date.now(), text }) }} />}
    <Toast toast={note} onDone={() => setNote(undefined)} />
  </Shell></ThreadContext></BodySource>
}

createRoot(document.getElementById('root')!).render(<StrictMode><Preview /></StrictMode>)
