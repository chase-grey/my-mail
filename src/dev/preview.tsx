import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { MessageActions } from '../App'
import { rankTriaged, type Triaged } from '../domain/triage'
import type { Action, Category, Message } from '../domain/types'
import { InboxView } from '../views/InboxView'
import { RulesView } from '../views/RulesView'
import { SearchView, type SearchActions } from '../views/SearchView'
import { SettingsView } from '../views/SettingsView'
import { Shell, type View } from '../views/Shell'
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
  mail(3, 'Owen Marsh', 'Re: cabin weekend', 'I can drive if someone else books the place. Are we still thinking the second weekend of February?', 'reply', 'reply', 'will drive if someone books; wants the february weekend confirmed', { flagged: true }),
  mail(4, 'Northside Dental', 'Your appointment is confirmed', 'This confirms your cleaning on Tuesday, December 8 at 9:40 am. Reply C to confirm.', 'waiting', 'keep', 'cleaning tuesday dec 8 at 9:40'),
  mail(5, 'Harbor Outfitters', 'Members: 20% off through Sunday', 'Members save 20% on one full-price item and an extra 20% on one outlet item.', 'promo', 'archive', '20% off one item through sunday', {}, 0.72),
  mail(6, 'The Weekly Fold', 'Issue 214: slow mornings', 'This week: a case for doing less before nine, three recipes, and a reader letter.', 'newsletter', 'archive', 'weekly newsletter, issue 214'),
  mail(7, 'Parcel Post', 'Your package was delivered', 'Delivered to front door at 2:14 pm.', 'notification', 'archive', 'package delivered to the front door'),
  mail(8, 'Fernway Market', 'Your receipt', 'Order total $48.12. Thanks for shopping with us.', 'receipt', 'archive', 'receipt for $48.12'),
  mail(9, 'Cloud Storage', 'Storage almost full', 'You have used 92% of your storage.', 'notification', 'archive', 'storage at 92%', {}, 0.81),
  mail(10, 'Juniper Books', 'New this week', 'Staff picks and a signed first edition.', 'promo', 'archive', 'staff picks'),
  mail(11, 'Trail Club', 'January trail report', 'Conditions, closures, and volunteer days.', 'newsletter', 'archive', 'monthly trail report'),
  mail(12, 'Ida Voss', 'Old photos', 'Found these in the attic, thought you would want them.', 'fyi', 'keep', 'sent old photos from the attic', { hasAttachments: true }),
]

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const found = () => seed.slice(0, 4).map((item, index) => ({ message: { ...item.message, receivedAt: hoursAgo(index * 4000 + 30) }, inInbox: index === 0, folder: index === 0 ? undefined : 'Archive' }))
const search: SearchActions = {
  find: async (query, count) => { await wait(400); return query.includes('nothing') ? { hits: [] } : { hits: found(), next: count ? undefined : 'next' } },
  more: async () => { await wait(400); return { hits: seed.slice(4, 8).map((item) => ({ message: item.message, inInbox: false, folder: 'Archive' })) } },
  translate: async () => { await wait(500); return 'treasurer (tax OR installment) received>=2026-01-01' },
  answer: async () => { await wait(700); return 'The second installment is $2,140.00 and is due January 31 [2]. Nothing in these messages says it has been paid [1].' },
}

function Preview() {
  const params = new URLSearchParams(window.location.search)
  const [view, setView] = useState<View>((params.get('view') as View) || 'inbox')
  const [items, setItems] = useState(params.has('empty') ? [] : seed)
  const [kept, setKept] = useState<Record<string, string>>({ m12: 'now' })
  const drop = (ids: string[]) => setItems((current) => current.filter((item) => !ids.includes(item.message.id)))
  const gone = async (message: Message) => { await wait(350); drop([message.id]) }

  const actions: MessageActions = {
    archive: gone,
    isReceipt: () => false,
    archiveAll: async (messages) => { await wait(500); drop(messages.map((message) => message.id)) },
    remove: gone,
    task: gone,
    reply: gone,
    draft: async () => { await wait(600); return 'Five works. I will bring a salad and the chairs.' },
    snooze: gone,
    keep: async (message) => { await wait(200); setKept((current) => ({ ...current, [message.id]: 'now' })) },
    flag: async (message) => setItems((current) => current.map((item) => item.message.id === message.id ? { ...item, message: { ...item.message, flagged: !item.message.flagged } } : item)),
    unsubscribe: async (message) => `unsubscribed from ${message.from.address}`,
    makeRule: async () => wait(200),
    restore: async (message) => { await wait(250); setItems((current) => rankTriaged([...current, ...seed.filter((item) => item.message.id === message.id)])) },
  }

  return <Shell view={view} views={['inbox', 'search', 'cleanup', 'rules', 'settings']} busy={params.has('busy')} canRefresh links={[{ label: 'open outlook', onSelect: () => {} }, { label: 'open my brain', onSelect: () => {} }]} onView={setView} onRefresh={() => setItems(seed)}>
    {view === 'inbox' && <InboxView items={items} kept={kept} summary={{ inbox: items.length, needReply: items.filter((item) => item.triage?.needsReply).length, byRules: 14, autoArchived: 0, returned: 0, withoutModel: 0 }} busy={params.has('busy') ? 'checking mail' : undefined} connection="connected" hasModel
      suggestions={[{ from: 'news@weeklyfold.example.com', action: 'archive', count: 4 }]} snoozes={[]} actions={actions} onConnect={async () => {}} onSettings={() => setView('settings')} onDismissSuggestion={() => {}} />}
    {view === 'search' && <SearchView search={search} actions={actions} hasModel />}
    {view === 'rules' && <RulesView rules={[{ id: 'r1', from: '@harbor.example.com', action: 'archive', enabled: true, createdAt: 'now', hits: 12, outlookId: 'o1' }, { id: 'r2', subject: 'receipt', action: 'read', enabled: true, createdAt: 'now', hits: 3 }]} outlookRules={[]} snoozes={[{ messageId: 's1', until: new Date(Date.now() + 86_400_000).toISOString(), subject: 'Renew passport', from: 'Travel Office' }]} onRules={async () => {}} />}
    {view === 'settings' && <SettingsView settings={defaultSettings} connection="connected" accountName="someone@example.com" busy={false} onSettings={() => {}} onConnect={async () => {}} onDisconnect={async () => {}} />}
  </Shell>
}

createRoot(document.getElementById('root')!).render(<StrictMode><Preview /></StrictMode>)
