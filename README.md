# My Mail

Personal inbox triage for my personal Outlook account. Rules first, then the model, then me.

Open it, and it brings back snoozed mail that is due, runs your rules, asks Claude to read
whatever is new, and shows what is left as one card per message: who, subject, a one-line
summary, and the actions. Everything you do here lands in Outlook; nothing lives only in
this app except your rules and snooze times.

Sibling of [`../my-brain`](../my-brain). My Brain shows the inbox count on today and links
here; tasks made here go to Microsoft To Do, where My Brain picks them up as `new to sort`.
Same Microsoft app registration, same one-way feed pattern My Brain uses with the workout
tracker. See **App Topology** in the My Brain spec.

The product specification, including why this is built rather than forked, lives in
[`docs/spec.md`](docs/spec.md). This build is phase 1 of it.

## what it does

- **rules** · from or subject contains, then archive, delete, mark read, flag, or make a task.
  Yours, deterministic, run before anything else. A rule Outlook can express is written to Outlook
  and runs on the server all day, app closed or not; flag and task rules run here on open. Rules
  made in Outlook itself are listed read-only. After you archive or delete the same sender three
  times it offers the rule.
- **sorting** · each new message gets a category: `reply`, `action`, `waiting`, `fyi`, `receipt`,
  `notification`, `newsletter`, `promo`, or `spam`. Cheapest source first: the category Outlook
  already carries from another device, then the sender's history with you, then TypeSafe Jev when a
  key is set, then Claude. The verdict is written back to the message as an Outlook category.
- **reading** · Claude (Haiku, low effort) summarizes only what needs you: replies, actions, flagged
  mail, and anything the sorter was unsure about. Newsletters and promos get Outlook's preview and
  no model at all. Reply drafts are written on request, not ahead of time; `better draft` asks Sonnet.
- **inbox** · two groups. `needs me` has the suggested action first. `probably fine` shows the
  category and how sure the sorter was, leads with archive, and has `archive all`.
- **actions** · archive, to do (creates a To Do task and archives), reply (draft for me, edit, send
  or finish in Outlook), snooze (this evening, tomorrow, this weekend, next week), keep in inbox,
  flag, delete, unsubscribe, always do this for the sender.
- **unsubscribe** · follows the sender's `List-Unsubscribe` header: a one-click POST when offered,
  otherwise a mail sent through Graph, otherwise the page opens. Pair it with a rule to be sure.
- **clean up** · for a backlog. Reads the whole inbox headers-only, groups by sender, marks the ones
  you never open or Jev calls a list as `probably noise`, and clears a sender in one tap with
  `archive all + rule`. Also offers to archive everything read and older than 30 days.
- **auto-archive** · off by default. When on, quiet categories the sorter is at least 85% sure
  about are archived on their own. Flagged or high-importance mail never is. The sender of an
  auto-archived newsletter, promo, or receipt also gets an archive rule in Outlook, so the next one
  never reaches the inbox or a model. No rule is made for a sender you have replied to, kept,
  flagged, snoozed, or made a task from, one with other mail still in the inbox, or one whose
  auto-made rule you deleted.
- **junk** · there is no junk folder. Each open moves whatever Outlook junked into the inbox, where
  rules and sorting treat it like any other mail. Block a sender with a rule.
- **snooze** · moves the message to a `snoozed` folder and brings it back unread when the time
  comes. Snooze times sync through the OneDrive app folder, so phone and PC agree.

Only Outlook-tier rules run while the app is closed. Everything else runs each time it is opened.

## setup

Reuse My Brain's Microsoft Entra app registration (the single-page app that accepts personal
accounts):

1. **Authentication** → add SPA redirect URIs `http://localhost:5174/` and
   `https://chase-grey.github.io/my-mail/`.
2. **API permissions** → add delegated `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite`
   (rules and categories), `Tasks.ReadWrite`, `Files.ReadWrite.AppFolder`. Personal accounts consent
   at first sign-in.
3. Copy `.env.example` to `.env.local` and set `VITE_MICROSOFT_CLIENT_ID` to the same client
   ID My Brain uses. For GitHub Pages, add it as the repo secret `VITE_MICROSOFT_CLIENT_ID`.

Then in the app: `connect microsoft`, and in settings paste an Anthropic API key and write a
few lines about yourself for the reply drafts. A TypeSafe Jev key is optional and makes sorting
nearly free; without it Claude sorts too. Keys stay in this browser's local storage.

## develop

```bash
npm install
npm run dev        # http://localhost:5174
npm test
npm run lint
npm run build
```

Tests cover the rules engine and its Outlook compilation, snooze times, grouping and
auto-archive gates, sender history, body trimming, the Jev and Claude requests and response
parsing, unsubscribe headers, cleanup grouping, the Graph mail mapping, and a render of the inbox.

## deploy

Push to `main`; `.github/workflows/deploy.yml` builds and publishes to GitHub Pages. The first
time, create the repo and enable Pages by hand:

```bash
gh repo create chase-grey/my-mail --public --source . --push
gh secret set VITE_MICROSOFT_CLIENT_ID
gh api -X POST repos/chase-grey/my-mail/pages -f build_type=workflow
```

Install on the phone from https://chase-grey.github.io/my-mail/ the same way as My Brain.

## data

| what | where |
|---|---|
| mail, folders, drafts, sent replies, categories | your mailbox, through Microsoft Graph with immutable ids |
| server-side rules | your mailbox's inbox rules, named `my mail: …` |
| tasks | Microsoft To Do default list |
| app rules, decisions, snooze times | OneDrive app folder `mail/automation.json`, cached in local storage |
| summaries, drafts, kept-in-inbox marks, settings, keys | this browser's local storage only |
