# My Mail product specification

My Mail is the personal email client for my personal Outlook account. It exists so the inbox stops being a
chore: rules handle what is predictable, Claude reads what is new, and what reaches me is already
sorted, summarized, and has a draft waiting. It is a sibling of My Brain and the workout tracker, built
the same way and talking to them only through Microsoft.

The 2026-11-02 build is phase 1 of this spec. Later phases are listed at the end.

## principles

1. **Outlook is the truth.** Every state the app writes is a state Outlook can show: a folder, a flag, a
   category, a rule, a draft. Nothing lives only in this app except preferences and caches. If the app
   disappeared tomorrow the mailbox would still be in order.
2. **Rules before the model, the model before me.** Deterministic rules run first and never ask. The
   model reads only what rules did not settle. I see only what the model could not settle, or what needs
   a human by nature: a reply, a decision, a payment.
3. **The model reads; I decide, unless I have said otherwise.** It never sends, never deletes, never
   moves a message a rule did not already name. Auto-archive is opt-in per category behind a confidence
   gate, and anything it touches is listed where I can undo it.
4. **The inbox is a to-handle list, not storage.** Done means out of the inbox. Archive is one gesture
   everywhere. Search finds anything, so nothing needs to stay in view to be found.
5. **A message never becomes a task here.** It becomes a Microsoft To Do task, which My Brain owns and
   plans. My Mail has no task list and never will.
6. **Opened a few times a day for two minutes.** Cold start renders the inbox from cache before any
   network call. There is no daily ritual, no streak, no count on an icon.
7. **Personal data, personal key.** Full message bodies go to Claude on my own Anthropic key. This is my
   mail; there is no customer data here. Work mail never enters this app, on any account. The one
   exception is a chat about a message, which happens in My Brain and runs on the work pc's Claude
   Code when I am at it (see the decisions log).
8. **Nothing runs while closed except what Outlook runs.** Rules that Outlook can express are written
   to Outlook and run on the server all day. Everything else waits for the next open and does not
   pretend otherwise.

## decisions log

| decision | choice | rationale |
|---|---|---|
| **Fork an existing client or build** | **Build.** Same stack as My Brain. *Resolved 2026-11-04.* | See [why not fork](#why-not-fork). The plumbing a fork would save (IMAP, SMTP, MIME, sync) is exactly what Microsoft Graph already does. The open-source AI clients need a server, a database, and hosted OAuth secrets, which breaks the static-site, no-server rule every sibling app follows. The hard parts here are the UI and the model loop, and a fork gives us neither. |
| **Transport** | **Microsoft Graph only.** No IMAP, no SMTP, no EWS. | One REST API does list, search, send, move, flag, categories, rules, attachments, drafts, and delta sync for outlook.com. Immutable ids survive folder moves. EWS is being shut down in 2027 anyway. |
| **Hosting** | **Static PWA on GitHub Pages**, GitHub Actions on push to `main`. | Same as both siblings. Phone-installable, no store, no server to keep alive. |
| **Where rules run** | **Two tiers.** A rule whose conditions and actions Outlook can express is written to Outlook as a server-side rule and runs while the app is closed. A rule that needs the model's category, or an action Outlook lacks (flag, task), stays in the app. The list shows both as one list with a `runs in outlook` or `runs here` tag. *Resolved 2026-11-04.* | Phase 1 kept every rule in the app, so a newsletter that arrives at 3am sits unread until I open the app. Outlook rules fix that for the bulk of the volume with no server of ours. Rules I make in Outlook directly appear in the list too, read-only, so there is one place to see what is happening to my mail. |
| **Where verdicts live** | **Outlook categories on the message.** The model's category is written as a category (`reply`, `action`, `waiting`, `fyi`, `receipt`, `notification`, `newsletter`, `promo`). Summary and draft stay in a local cache keyed by message id. *Resolved 2026-11-04; default on, with a setting.* | A category on the message is visible in every Outlook client, survives the cache being cleared, and means the phone and the PC agree on what has been read by the model without a sync file. It also lets Outlook-tier rules act on model output later (a rule on a category runs on the server). Phase 1 kept verdicts in local storage only, which meant each device paid to read everything twice. |
| **Search** | **Graph `$search` with KQL, typed or translated.** Plain words pass through. A sentence is translated by the model into KQL and shown as an editable query. An `ask` mode reads the top results and answers with links. *Resolved 2026-11-04.* | outlook.com supports KQL on messages (`from:`, `subject:`, `received>=`, `hasattachments:true`, body words) and returns up to 250 relevance-ranked results. That covers "find" by itself. The model adds the two things search engines cannot do: understanding "the electrician's invoice from last spring" and reading the results to answer a question. |
| **Theme** | **My Brain's neutral tokens with a teal accent.** Brain is violet, Mail is teal. No warning or error colors. | The apps should feel like one family on the phone's home screen and still be told apart at a glance. Teal reads as "handled, calm", which is the feeling this app is for. |
| **HTML mail** | **Rendered in a sandboxed iframe after sanitizing.** Remote images load for people (anyone I have replied to or who is in contacts) and on tap for everyone else. | Tracking pixels are most of what remote images are in a personal inbox. Blocking by default for strangers costs nothing for mail from people. |
| **Compose** | **Full compose: new, reply, reply all, forward, attachments.** Drafts are Outlook drafts. | Phase 1 was reply-only because the point was triage. A client that cannot start a thread sends me back to Outlook for the easy case, which is the wrong direction. Drafts in Outlook mean anything started here can be finished on any device. |
| **Threads** | **One row per conversation in the inbox, and the whole conversation in the message view.** Acting on the row acts on every inbox message in it. Under the conversation: `more from` the sender, and `find related`, where a model writes the searches and keeps what is about the same matter. | One card per message was tried first and read as mail not being grouped. A conversation is one thing to handle. |
| **Notifications** | **None.** Outlook mobile stays installed and does the alerting. | A PWA on GitHub Pages would need a push server to notify. Outlook already does it well, and principle 6 says no badge anyway. |
| **Unsubscribe** | **Honor `List-Unsubscribe`.** A `mailto:` target is sent through Graph without leaving the app; an `https:` target opens in a new tab. Offered alongside the archive rule for senders I keep archiving unread. | One tap that stops the mail beats a rule that hides it. |
| **Accounts** | **One: the personal Outlook account.** | Work mail stays in work Outlook; see My Brain's work boundary. There is no account switcher to build or secure. |
| **Background work** | **No server in this phase.** Documented options if wanted later: a GitHub Actions cron holding a refresh token as a secret, or a scheduled job on the home PC. | Outlook-tier rules cover the common case. A server adds a token to protect for a benefit that is mostly "the summaries are already there when I open it". |
| **Model** | **`claude-haiku-5-5` at low effort for reading, `claude-sonnet-5-5` for ask, search translation, and `better draft`.** Both settable. | Reading is frequent and simple; a stronger model for the handful of times a day I ask it a question or want a careful reply is worth it. Haiku 5.5 thinks by default, so effort is pinned low on the classification call. |
| **Sorting before reading** | **TypeSafe Jev categorizes every message; Claude reads only what needs me.** *Resolved 2026-11-04.* | Jev is a yes/no model: a state and up to eight labeled questions in, calibrated probabilities out, at 1/2,400 of Haiku's input price with free output. Three quarters of a personal inbox is lists and notices that need a category and nothing else. Jev's probability is the auto-archive gate, which is what a gate should run on. Without a Jev key Claude sorts too, so the app degrades, not breaks. |
| **Nothing speculative** | **No draft is written until a tap asks for it. No summary is written for mail in `probably fine`.** *Resolved 2026-11-04.* | Output tokens cost five times input, and most drafts were never opened. A summary of a newsletter nobody reads is waste twice over. |
| **Unsubscribe** | **Honor `List-Unsubscribe` in the quietest form offered: a one-click POST (RFC 8058), else a mail through Graph, else the page.** Always offered beside a rule, never instead of one. *Resolved 2026-11-04.* | One tap that stops the mail beats a rule that hides it, but senders do not all honor it, so the rule is the guarantee. A browser-automation unsubscriber (Playwright) is not possible from a static site and not worth a server: the header covers the senders who will honor anything. |
| **Backlog** | **A `clean up` screen that reads the inbox headers-only, groups by sender, and clears a sender in one tap with a rule attached.** *Resolved 2026-11-04.* | Inbox zero from thousands is a per-sender problem, not a per-message one. Twenty senders are most of the volume. Jev reads one sample per sender to tell lists from people for a fraction of a cent. |
| **Receipts** | **Their own `receipts` folder, with the `receipt` category kept on the message.** Archiving a receipt files it there. A receipt the sorter is sure about is filed on its own, whether or not auto-archive is on, and its sender gets a `move to receipts` rule in Outlook. A `receipts` screen lists the folder. On by default, with a setting. *Resolved 2026-11-19.* | I go back over receipts, so they need one place to look, in this app and in Outlook on any device. A folder is one tap in every Outlook client; a category inside the archive needs a filter each time. The Outlook rule moves the next one on arrival, so it never sits in the inbox or notifies. |
| **Junk** | **There is no junk folder. Every open moves whatever Outlook put in Junk Email into the inbox, where it is sorted like any other mail.** Blocking a sender is a rule, made here. *Resolved 2026-11-24.* | Real mail was landing in junk and being missed. A personal account cannot switch Outlook's junk filter off, and Outlook's own rules never see junked mail, so the app brings it back on open and runs the rules itself. Until the app is opened, junked mail still waits in Outlook's junk folder and Outlook mobile does not notify for it. |
| **Chat about a message** | **A `chat` link on every open message hands the conversation to My Brain's personal chat.** Only the message id goes in the link; My Brain reads the conversation from the mailbox itself. At the work pc that chat runs on work Claude Code, as a bare model with no tools or files; anywhere else it runs on my personal key. *Resolved 2026-11-25.* | The chat that knows my tasks, notes and memory already exists in My Brain, so a second one here would know less. Sending only the id keeps mail out of links and history. |

## why not fork

The question was whether an open-source email client would save the plumbing of sending and
receiving mail. It would, if we were doing that plumbing. We are not. Microsoft Graph gives one HTTPS
API for everything a mail client does against an outlook.com mailbox: listing and delta sync, full
bodies as text or HTML, send and reply, move and delete, flags and categories, folders, attachments,
drafts, server-side rules, and KQL search. There is no IMAP, SMTP, or MIME anywhere in this app.

The forks that would be relevant are the AI clients, and each needs a backend:

- **Inbox Zero** (open source, Gmail and Outlook) requires Node, PostgreSQL, and Redis, and runs its
  automation on a server holding OAuth refresh tokens. Its iOS app is not open source.
- **Zero / Mail0** (MIT, Gmail, Microsoft, and IMAP drivers) is a Next.js app with a server and a
  database, at a v0.1 release as of mid 2025.
- **Roundcube, Thunderbird, Mailspring** are IMAP clients. Pointing them at outlook.com IMAP would
  give up categories, server-side rules, immutable ids, and To Do, which are the integration.

Forking any of them means a hosted server with my mailbox token on it, a stack that is not the
siblings' stack, and a UI that is someone else's. What is actually hard here is the triage UI, the
rules model, and the Claude loop, and none of those come with a fork.

What we do borrow: a sanitizer for HTML mail (DOMPurify), MSAL for auth, and the Anthropic client
already in My Brain. The whole app is under two thousand lines as of phase 1 and will stay small.

Sources: [Inbox Zero](https://github.com/elie222/inbox-zero),
[Mail0 alternatives compared](https://aiemaily.com/blog/zero-mail0-alternatives-open-source),
[open-source email clients](https://aiemaily.com/blog/best-open-source-email-client).

## what it is not

- Not a work mail client. No work account can be added.
- Not a task list. Tasks go to To Do and are planned in My Brain.
- Not a calendar. Invitations can be accepted or declined from a message; the calendar lives in Outlook
  and My Brain.
- Not a notifier. No badges, no push.
- Not an archive browser. Folders other than inbox, receipts, archive, snoozed, drafts, and sent are
  reachable through search, not navigation.

## screens

### inbox

The home screen and the cold-start screen. Everything that still needs me, grouped and ranked.

```
┌──────────────────────────────────────────┐
│ my mail                          ⟳   …   │
│ ┌──────────────────────────────────────┐ │
│ │ search or ask                        │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ needs me 2                               │
│ ┌──────────────────────────────────────┐ │
│ │ Mom                      yesterday   │ │
│ │ Dinner Sunday?                       │ │
│ │ asks if 5pm sunday works, bring a    │ │
│ │ salad                       needs a  │ │
│ │                             reply    │ │
│ │ [reply] archive  to do  snooze  …    │ │
│ └──────────────────────────────────────┘ │
│ ┌──────────────────────────────────────┐ │
│ │ Dane County Treasurer          tue   │ │
│ │ Property tax statement               │ │
│ │ second installment due jan 31, $2140 │ │
│ │ [to do] archive  reply  snooze  …    │ │
│ └──────────────────────────────────────┘ │
│                                          │
│                                          │
│ ┌──────────────────────────────────────┐ │
│ │ REI                              mon │ │
│ │ Members: 20% off through sunday      │ │
│ │ promo · 72% sure                     │ │
│ │ [archive] keep  always archive rei   │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ ▸ 14 handled by rules this open          │
│ ▸ 3 snoozed                              │
│ ▸ 1 kept in inbox                        │
└──────────────────────────────────────────┘
```

- **search or ask** at the top. One field. See [search](#search).
- **no summary line.** The line under search says only that a check is running.
- **needs me**, with its count beside the heading: reply, action, and waiting categories, plus anything flagged or marked important by
  the sender, plus anything the model was under 60% sure about in any category. Ranked by category
  (reply, action, waiting) then newest. Mail older than 30 days is never here, whatever flag,
  importance, or category it carries, and a rule never flags it or makes a task of it.
- **everything else**, below needs me with no heading of its own: fyi, receipt, notification, newsletter, promo that auto-archive did not take
  (either because auto-archive is off for that category or confidence was under the gate). Each card
  shows the category and the confidence, and leads with archive.
- **handled by rules this open**: collapsed list of what rules and auto-archive did since the last
  open, each row with an undo. Stays for seven days.
- **snoozed** and **kept in inbox** collapsed below.

Each card: sender display name, received time, subject, the model's one-line summary (or the preview
when there is no key), a category chip when the category is not obvious from the group, and an action
row with the suggested action first and visually heavier. Tapping the body opens the message. The `…`
menu holds the rest: flag, delete, unsubscribe when the header exists, always do
this for the sender, make a rule.

Archiving many: `archive all` at the top of the list clears every row except mail kept in the inbox.
A message's menu has `archive everything else` and `archive all from sender`. Each shows an undo that
brings back everything it moved.

Phone gestures: swipe right archives, swipe left snoozes. Both show a five-second undo. PC keys on a
focused card: `e` archive, `r` reply, `t` to do, `s` snooze, `k` keep, `#` delete, `j`/`k` move,
`enter` open, `/` search, `u` undo.

### message

```
┌──────────────────────────────────────────┐
│ ‹ inbox                     reply  …     │
│                                          │
│ Dinner Sunday?                           │
│ asks if 5pm sunday works, bring a salad  │
│                                          │
│ Mom <mom@example.com>       sun 4:12 pm  │
│ to me                                    │
│ ┌──────────────────────────────────────┐ │
│ │ Hi honey, does 5 work on Sunday?...  │ │
│ │                                      │ │
│ │ ▸ show quoted text                   │ │
│ └──────────────────────────────────────┘ │
│ 📎 recipe.pdf · 212 kb                   │
│                                          │
│ ▸ 2 earlier in this conversation         │
│                                          │
│ draft                                    │
│ ┌──────────────────────────────────────┐ │
│ │ 5 works. I'll bring a salad. See you │ │
│ │ Sunday!                              │ │
│ └──────────────────────────────────────┘ │
│ [send and archive]  edit  better draft   │
│                                          │
│ archive  to do  snooze  flag  delete     │
└──────────────────────────────────────────┘
```

- Subject, then the summary in muted text when the model has read it.
- Sender with address, time, recipients (me, or the list when there are several).
- Body in a sandboxed iframe sized to content. Quoted history collapsed. Remote images per the
  [HTML mail](#decisions-log) decision, with a `load images` link when blocked. Links open in a new tab.
- Attachments as rows: name and size, tap to download; images show a thumbnail.
- Earlier messages in the conversation collapsed below, newest first when opened.
- Meeting invitations get `accept`, `tentative`, `decline` in place of the draft block.
- The **draft** block appears when the model thinks a reply is owed. `send and archive` sends it as a
  reply (reply all when the original had several recipients and the model says so). `edit` opens it in
  compose. `better draft` asks the stronger model with the whole thread.
- Action row at the bottom, same actions and keys as the card.

### compose

New message, reply, reply all, forward. To, cc (hidden until tapped), subject, body as plain text with
the signature appended, attachments from the device. `send` and `save draft`. Drafts are Outlook
drafts: closing compose without sending saves one. A reply to a message that is on a card archives the
original after sending when `archive after reply` is on.

*Built 2026-11-24*, without the signature and `tighten`. One screen writes all mail: `new message` in the
rail and the top bar (`c`), `reply` on the card, `reply all` and `forward` in its `…` menu and in search,
`forward` on a receipt. A reply or forward is an Outlook draft from the moment it opens, so Outlook
addresses and quotes it; a new message becomes one at its first file or save. Files come from the
picker, a drop, or a paste, up to 25 mb a message; a forward keeps the original's files. Closing keeps
what was written as a draft and `discard` deletes it; an answer nobody touched leaves no draft behind.
A forward never archives the original. Drafts cannot be reopened in the app yet.

The model helps in two places: `draft for me` with a one-line instruction ("say yes but push to 6"),
and `tighten` on selected text. Both show the result as a replacement I can undo.

### search

The field on the inbox. Two behaviors from one box:

- **Find.** Words and KQL pass straight to Graph: `from:mom`, `subject:tax received>=2026-01-01`,
  `hasattachments:true invoice`. Results list in relevance order with sender, subject, date, folder.
  Tap opens the message with the same actions.
- **Ask.** A sentence ("what was the total on the electrician's invoice last spring", "did the
  landlord ever confirm the lease dates") goes to the model, which writes a KQL query, runs it, reads
  the top ten bodies, and answers in a paragraph with links to the messages it used. The KQL it wrote
  shows above the answer as an editable chip, so a wrong translation is one tap from fixed.

The app decides which by shape: a KQL operator or a single term is a find; a sentence or a question
mark is an ask. A toggle under the field overrides it. Recent searches sit under the field when it is
empty. Search covers all folders; results show the folder when it is not inbox.

### senders

Who sends me mail and what I do with it. Behind `…`.

```
┌──────────────────────────────────────────┐
│ ‹ senders                   last 30 days │
│                                          │
│ news@daily.example.com      31 · 0 read  │
│   archive all  ·  unsubscribe            │
│ REI                         12 · 2 read  │
│   archive all                            │
│ Mom                          9 · 9 read  │
│ Dane County Treasurer        2 · 2 read  │
└──────────────────────────────────────────┘
```

One row per sender, ranked by volume, with how many I opened. Senders I archived or deleted without
reading get the one-tap rule and, when the header exists, unsubscribe. This is where the rule
suggestions come from; the inbox shows none of them; they are offered on the rules screen.

### clean up

For a backlog. Behind `…`.

```
┌──────────────────────────────────────────┐
│ ‹ clean up    2,840 in inbox · 212 senders│
│                                          │
│ old and already read                     │
│  1,120 read messages older than 30 days  │
│                        [archive them]    │
│                                          │
│ probably noise                1,604 msgs │
│ Daily Digest           newsletter        │
│   340 messages · 338 unread              │
│                    [archive all + rule] …│
│ REI                    promo             │
│   96 messages · 90 unread                │
│                    [archive all + rule] …│
│                                          │
│ everyone else               180 senders  │
│ Mom                                      │
│   41 messages · 2 flagged                │
│                     archive all + rule  …│
│ ▸ show all 180                           │
└──────────────────────────────────────────┘
```

Reads the inbox headers-only in pages of 500 (no bodies, up to 20,000 messages), groups by
sender, and asks Jev one `kind` question about each sender's newest message. A sender is `probably
noise` when Jev calls the sample a list or notice at 70% or more, or when I have opened under 30%
of what they sent. Flagged mail keeps a sender out of that group, and so does `not noise` in the
row's menu: the sender is kept in `noRules`, is never suggested again here or as a rule in the
inbox, and the sorter makes it no rule. Each row: `archive all + rule`
first, then archive all, unsubscribe, open latest, delete all + rule, delete all. Moves go through
Graph's batch endpoint twenty at a time with progress in the status line. The inbox refreshes from
what is left.

### receipts

Behind `…`. The `receipts` folder newest first: sender, date, subject, preview. A row opens to the
text with `move to inbox`. `move receipts from archive` brings in archived mail
that carries the `receipt` category, for receipts sorted before the folder existed.

### rules

```
┌──────────────────────────────────────────┐
│ ‹ rules                            + add │
│                                          │
│ anyone @daily.example.com → archive      │
│ runs in outlook · 31 this month          │
│                                          │
│ subject contains "statement" → flag      │
│ runs here · 2 this month                 │
│                                          │
│ newsletter (model) → archive, mark read  │
│ runs here · 48 this month                │
│                                          │
│ Outlook: "Bank alerts" → move to Money   │
│ made in outlook · read-only here         │
│                                          │
│ ▸ 3 suggested                            │
└──────────────────────────────────────────┘
```

A rule is conditions (all must match) and actions (all run). Conditions: from address, anyone at a
domain, sender name contains, subject contains, body contains, has attachment, high importance, sent
only to me, model category. Actions: archive, move to receipts, move to folder, delete, mark read, flag, add category,
make a To Do task, stop processing. First matching rule wins unless it says continue; the list is
ordered and can be reordered.

A rule with no model-category condition and an archive, move to receipts, delete, or mark-read action is **compiled to an Outlook rule**
named `my mail: <description>`, and its Outlook id is kept. Editing it here rewrites the Outlook rule.
Editing or deleting it in Outlook is read back on the next open and wins. Rules made directly in
Outlook are listed read-only with a link to Outlook settings. Rules that cannot be compiled run in the
app on open, after Outlook has had its turn.

Hit counts come from the app for app-tier rules and from a tally on each open for Outlook-tier rules
(messages that arrived in a rule's target folder from a matching sender since the last open).

**Suggestions** come from three places: the same sender archived or deleted three times, the senders
view, and the model, which may propose one rule per batch when it sees a clear pattern. A suggestion
is one line with `make it` and `not this one`; declined suggestions are not offered again for that
sender.

### settings

- microsoft: connected account, `disconnect`.
- ai: Anthropic key, Jev key, `sort mail with ai`, reading model, better-drafts model, about me (a
  few lines for reply voice). Sorting is off when a key is first added. It turns itself on the first
  time the inbox holds 200 or fewer, or when I turn it on; turned off by me, it stays off. Later: `use my sent mail as voice samples`.
- mail: write categories to outlook, auto-archive, move receipts to their own folder, archive
  after reply.
- reading: load remote images for people only / always / never; signature.
- links: my brain url.

## look

Phone first, installable, one column up to 60rem. From 60rem the inbox becomes two panes: cards on
the left, the open message on the right, and the keyboard shortcuts come alive. Above 90rem the panes
get a fixed max width and center.

Tokens, in the same shape as My Brain so components can move between them:

| token | light | dark | use |
|---|---|---|---|
| `--bg` | `#f6f6f4` | `#101114` | page |
| `--surface` | `#ffffff` | `#17181c` | cards |
| `--surface-2` | `#f0f0ee` | `#1f2026` | pressed, chips, collapsed groups |
| `--border` | `#e2e2df` | `#2a2b32` | hairlines |
| `--text` | `#1a1a1a` | `#ececea` | text |
| `--muted` | `#6b6b68` | `#9a9a98` | summaries, times, counts |
| `--accent` | `#1f6f5f` | `#5fc2a8` | suggested action, links, focus |
| `--on-accent` | `#ffffff` | `#0f0f14` | text on accent |

There are no warning or error colors. Categories do not get their own colors. A summary is
muted whatever the mail is; the section it sits in and its suggested action say what it needs.
Errors and delete are plain text.

Type is the system stack at 16px, headings 600 weight, no display face. Radius 12px on cards, pills
for chips and the switch. Cards are flat on `--surface` with a hairline border, no shadows. Spacing in
0.25rem steps; cards stack at 0.9rem. Icons are 1.5px-stroke outlines, inline SVG, no icon font.

Copy follows the My Brain rules: lowercase for everything the app authors, original casing for
anything from the mailbox, no helper sentences under controls, plain labels over clever ones. The app's
own voice appears in exactly two places: the summary line and the model's one-liners, and both are
written as if I wrote them in a text to myself.

The icon is a white envelope outline with no background, matching the brain and the tracker on the home screen.
It is generated by `npm run icons`; the manifest lists PNGs because Chrome on Android installs only from those.

## pipeline on open

1. **Paint from cache.** The last rendered inbox, summaries, and groups appear before any request.
2. **Silent auth.** MSAL token from cache; on failure, a `connect microsoft` card replaces the list.
3. **Return snoozes.** Messages in `snoozed` whose time has passed move back to inbox, unread.
   **Empty junk.** Everything in Junk Email moves to the inbox, up to 200 a run, and is sorted in this
   run with the rest.
4. **Delta sync.** Inbox changes since the stored delta link. First run reads the latest 50.
5. **Read Outlook rules.** List message rules, reconcile with the app's rule list (renames, deletes,
   new ones made in Outlook), tally hits.
6. **App-tier rules** on new messages, first match wins. Actions are performed, the message leaves the
   working set if archived, deleted, or moved, and a `handled` row is recorded.
7. **Sort** each message with no verdict yet, cheapest source first: the category Outlook already
   carries (written by this app on another device), the sender's history (three unread archives
   settles it), then Jev with `kind`, `needs_reply`, and `person` on the trimmed body plus a
   one-line sender history. Confidence is Jev's probability for the chosen kind.
8. **Read** with Claude only what needs me (reply, action, waiting, flagged, important) or what the
   sorter put under 60%: batches of twelve, numbered, trimmed bodies, known category passed in, low
   effort, summary and task title back, no draft. Then write each new verdict to the message as a
   category. Then **auto-archive** where enabled: quiet category, confidence at or above the gate,
   not flagged, not high importance. A sure receipt goes to the `receipts` folder instead of the
   archive, and goes even when auto-archive is off; its sender's rule is `move to receipts`.
   Recorded as `handled` with undo. The sender of an auto-archived
   newsletter, promo, or receipt then gets an `archive from <address>` rule marked `auto`, written to
   Outlook like any other, unless a rule already names them, I have replied to, kept, flagged,
   snoozed, or made a task from their mail, other mail of theirs stayed in the inbox, or I deleted
   the rule made for them before (kept as `noRules` in `automation.json`). Notifications get no rule.
9. **Render** needs me, the rest of the inbox below it, handled, snoozed, kept. Refresh button repeats from step 3.

Budget: step 1 under 300ms; steps 2 to 6 under two seconds on a phone; the model fills in as batches
return. A failure in any step after 2 shows one line at the top and leaves the rest working.

## the model

Two models with different jobs. **Jev** answers the same three questions about every message and
never writes a word. **Claude** reads what Jev could not settle or what needs me, one tool call per
batch of twelve, `triage_messages`, returning per message number: category, one-line summary,
`needsReply`, suggested action, task title, confidence 0 to 1. Responses are checked: unknown
numbers dropped, duplicates removed, fields repaired, confidence clamped, a known category kept.

What it is given: sender, recipients, subject, received time, importance, flag, whether the sender is
a contact or someone I have replied to, the sender history line, the first 4,000 characters of the
text body, and the `List-Unsubscribe` presence. Attachments by name only.

What it is for, in order of value:

- **Categorize and summarize** so the inbox reads in one pass.
- **Draft replies** in my voice, from about-me and optional sent-mail samples, when I tap `draft
  for me` on a reply. Never ahead of time, never for newsletters or notifications.
- **Translate and answer** in search.
- **Suggest rules** when it sees a pattern I have not named.
- **Suggest unsubscribe** when a sender's history is all unread archives.
- **Digest**: when more than fifteen messages arrived since the last open, a two-sentence "since
  yesterday" line above the groups.

What it is never allowed to do: send, delete, move outside the auto-archive gate, create a task, or
change a rule. Every one of those is a tap by me.

See [model budget](#model-budget) for what each step costs and why the order is what it is.

## model budget

Tokens, not dollars, are the thing to minimize: the dollar cost of a personal inbox is cents a day
on any plan, and the environmental cost tracks tokens times model size. The pipeline is ordered so
each message is settled by the cheapest thing that can settle it, and nothing is generated that
nobody asked for.

| step | what runs | per message, roughly |
|---|---|---|
| Outlook rule | nothing of ours | 0 tokens |
| Outlook category from another device | nothing | 0 |
| sender history (three unread archives) | nothing | 0 |
| Jev `kind`, `needs_reply`, `person` | ~450 input tokens, free output | ~2 thousandths of a cent |
| Claude reads (needs me, or Jev unsure) | ~400 in, ~60 out on Haiku at low effort | ~1/20 cent |
| Claude drafts (on request) | ~500 in, ~150 out | ~1/10 cent, Sonnet 20x that |

What this buys on a fifty-message day with a typical mix: about forty messages never reach a
language model, ten are read, and two or three are drafted. Phase 1 read and drafted all fifty.

Rules the budget follows:

- The body a model sees is trimmed first: quoted history, mailing footers, and raw links stripped,
  then capped at 1,500 characters.
- Messages are numbered 1 to 12 in a batch; immutable ids never cross the wire to a model.
- Reading runs at `effort: low`. Haiku 5.5 thinks by default and a category does not need it.
- A verdict is written once, onto the message, so a second device pays nothing to sort or to read:
  the category as an Outlook category, and the whole verdict (summary, needs reply, suggestion, task,
  confidence) in a named extended property read back with the mail. Sure verdicts are written while
  Claude reads, not after, and again when the summary lands. A mailbox that refuses the property falls
  back to the category alone.
- Only the device in use sorts new mail as it lands. One that is on screen but not in use shows the
  mail, waits twenty seconds, reads it again, and sorts only what still has no verdict.
- No model runs on its own until sorting is on. That covers Jev and Claude in the inbox and Jev in
  clean up. Drafts and search run on a tap either way.
- Mail older than thirty days is never sent to Jev or Claude. It gets an `fyi` verdict from its age,
  sits below needs me with the rest, is never auto-archived, and is not written to Outlook as a category.
- A failed Claude call keeps Jev's verdicts and the batches already read.
- Cleanup remembers what Jev said about a sender on this device and asks only about new senders.
- Prompt caching is not used: the shared prefix is under Haiku's minimum cacheable size.
- The Batch API is not used: it is asynchronous and this app runs while open. It would fit a
  phase 4 worker.
- Sonnet rejects a forced tool call, so any call that may run on Sonnet uses `tool_choice: auto`
  with the tool named in the prompt.

## integration

**Outlook.** Folders, flags, categories, drafts, sent mail, and Outlook-tier rules are all plain
Outlook state. The `snoozed` folder is an ordinary folder. Categories are created in the master list
on first run with no color. Outlook mobile keeps notifying. Nothing here breaks if I use Outlook for a
week instead.

**My Brain.** Reads inbox unread and flagged counts with `Mail.Read` and shows one `email` row on
today that opens this app. It never touches a message. Tasks made here arrive in My Brain's `new to
sort` through To Do: title is the subject (editable before adding), body is the summary and the
Outlook link, `linkedResources` carries the message id, and an optional due date. The message is
archived on add.

**Scopes** on the shared registration, requested by this app only: `Mail.ReadWrite`, `Mail.Send`,
`MailboxSettings.ReadWrite` (rules and master categories), `Tasks.ReadWrite`, `Files.ReadWrite.AppFolder`,
`Contacts.Read` (who counts as a person). Adding a scope makes the next silent sign-in fail once with
a reconnect prompt.

## data

| what | where |
|---|---|
| messages, folders, flags, categories, drafts, sent mail | the mailbox, through Graph with immutable ids |
| Outlook-tier rules | the mailbox's message rules, named `my mail: …` |
| app-tier rules, snooze times, declined suggestions, decisions | OneDrive app folder `mail/automation.json`, cached locally, latest `updatedAt` wins |
| tasks | Microsoft To Do default list |
| summaries, drafts, confidence, handled list, delta link, kept marks, sent-mail voice samples | this browser's local storage, per device, prunable at any time |
| settings and keys | this browser's local storage |

Nothing in the app folder or local storage is needed to understand the mailbox from Outlook.

## phases

**Phase 1, built 2026-11-02.** Triage cards with summaries and suggested actions, app-tier rules with
suggestions after three archives, snooze with a `snoozed` folder, reply with an editable draft, To Do
handoff, auto-archive gate, OneDrive sync of rules and snoozes, PWA shell, My Brain email row.

**Phase 2a, built 2026-11-04.** Outlook-tier rules and read-back of Outlook's own rules. Categories
written to the message as the verdict store. Jev sorting ahead of Claude, sender-history verdicts,
trimmed bodies, numbered batches, low effort, drafts on request with `better draft` on Sonnet. The
`needs me` and `probably fine` groups with `archive all`. Unsubscribe from the header. The `clean up`
screen with per-sender bulk actions and the stale sweep.

**Old mail sweep, 2026-11-24.** The stale sweep took only read mail, so an unread backlog never
qualified. `old mail` on clean up now archives everything older than thirty days in one press, read
or not, leaves flagged mail, and can be undone until the next scan.

**Phase 2b, next.** Message view with sanitized HTML, attachments, conversation history, and
invitations. Delta sync and paint-from-cache. Handled list with undo. Swipe on phone, two panes and
keys on PC. Find with KQL. `Contacts.Read` and the people rule for images and auto-archive.

**Phase 3.** Ask mode and search translation. Full compose with attachments and Outlook drafts. Senders
view. Unsubscribe. Sent-mail voice samples and `better draft`. Digest line. Model rule suggestions.

**Phase 4, if wanted.** A scheduled worker so summaries are ready before the app opens. Only worth it
if phase 2's Outlook rules leave enough unread volume to matter.

## open choices

Defaults are set so nothing blocks; change any of these in a sentence.

- **Categories written to Outlook** default on. They show as plain tags in Outlook. Off keeps verdicts
  local only.
- **Auto-archive** default off. The expected first move is on after a week of watching the
  `probably fine` group and its confidence chips.
- **Jev in the browser.** The key is sent from the page like the Anthropic key. TypeSafe refuses
  cross-origin requests (checked 2026-11-24: the preflight answers `Disallowed CORS origin`), so Jev
  does not run from the site today. The first failed call says so once and Claude sorts until the
  page reloads. Making Jev work needs a tiny proxy or TypeSafe allowing the site's origin.
- **Images** default to people only.
- **Sent-mail voice samples** default off until tried once.
- **Name** stays `my mail`.
