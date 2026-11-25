# project guidance

## ui copy and voice

- Keep interface copy short, direct, and natural. It should sound like the product owner, not like generated marketing or explanatory prose.
- Do not add subtitles, eyebrow text, helper copy, empty-state commentary, or other explanatory text unless it communicates something the user actually needs in that moment.
- Remove filler such as “Do these when their moment fits. They won’t block other suggestions.” Do not explain behavior that is already obvious from the interface.
- Use lowercase text for all interface-authored titles, subtitles, headings, navigation labels, button labels, form labels, options, placeholders, and similar controls.
- Preserve the original casing of user-entered content, proper nouns, acronyms, and data from external systems.
- Prefer familiar, plain labels over clever, polished, motivational, or conversational copy.
- When new copy is necessary and the wording is not obvious, ask the product owner what they would say or offer a few short lowercase options for them to choose from. Use their answer as the voice reference for similar copy.
- Do not block straightforward implementation on a copy interview when an established label or existing product-owner phrasing already provides a clear answer.

## color

The only colors are the theme tokens at the top of `src/styles.css`: the neutrals and the one accent. No red, yellow, amber or green for errors, warnings, delete or success, and no new color tokens. Where something needs emphasis, use the accent or the text color. `src/styles.test.ts` fails on any other color.

The accent itself can be changed: settings has a swatch for the app's color and one for a color of my own, mixed on three sliders or typed as hex, kept on the device (`src/accent.ts`, `AccentPicker`; the pattern is `~/.claude/patterns/custom-accent.md`). Style against `--accent` and `--on-accent` only, never the default's hex, so everything follows it. The picker's own swatches and slider tracks are written in the component, the one place a color sits outside the tokens.

## one inbox

There is no junk folder. Every run moves what Outlook junked into the inbox before reading it (`rescueJunk`), and that mail goes through the same rules and sorting as the rest. Blocking is done with rules. Do not add a junk view, and do not read the inbox without emptying junk first.

An open message in the inbox or search has `archive + rule` (`block`): it archives every conversation from that sender on the list and adds a rule that archives what they send next. One undo brings the mail back and removes the rule. No second rule is made when one already clears the sender. On a phone, mail that needs me keeps it in the menu, where five buttons would not fit.

## inbox layout

The inbox is one list with one extra thing on top: a `needs me` section, its count beside the heading. All other mail follows below it with no heading and no category name. There is no `probably fine` group, no side by side columns, and no summary line of counts above the list; the line under search only says a check is running. That line takes no room when it has nothing to say: on a wide screen the check's status sits beside the `inbox` title, and on a phone the line is gone unless a check is running or it holds `archive all`. Do not leave an empty row between the title and the mail. Nothing else may appear above the list or change its height while mail is being cleared: rules to add are offered on the rules screen, never in the inbox. `rules` in the navigation carries no count; only `inbox` does.

## needs me gets shorter as I work

A check never brings other mail in to take the place of what was cleared. A full check reads the inbox back to the oldest mail already on the list and no further (`depthOf`); it does not read by count. Older mail comes only from the end of the list, which loads the next page by itself (see `loading more`). Mail a model is about to sort waits below needs me until its verdict lands, and joins needs me only if the verdict says so (`pending`). Mail no model will sort (sorting off, a failed call) counts as needs me. A flag or high importance never waits.

## loading more

No list has a `load more` button. Inbox, search and receipts ask for the next page on their own when the scroll gets near the end of the list, or straight away when few rows are left (`NearEnd` in `src/views/NearEnd.tsx`). It measures against whatever scrolls: the page on a phone, the list's own column from 60rem up. Only a failed load leaves a button (`try again`), so a failure is not retried in a loop. A new list that pages uses `NearEnd`; do not add a button that loads the next page.

## buttons on mail

A button never changes what it is, and the actions always come in one order: `reply`, `to do`, `snooze`, `archive`, `archive + rule`, then `reply all`, `forward`, `delete` and `archive everything else` (`mailActs` in `src/views/InboxView.tsx`). Mail with more than one other person on it leads with `reply all` and the plain `reply` joins the rest. Each has an icon. There is no `keep in inbox`, `flag`, `unsubscribe` or `always do this for the sender` on inbox mail.

On a phone every inbox row has `archive` and `to do`, in that order, in the same spot; the verdict only marks one of them, and the open message under a row adds the rest without repeating those two. From 60rem up the rows and the reading pane have no buttons: one bar across the top of the inbox has them, and the wider the bar, the more of the rest come out of the menu, in order (`extrasThatFit`). The bar acts on whatever is filled with the accent colour: the open message, or the rows highlighted with shift and click. There are no tick boxes. `archive all` lives at the end of that bar; with rows highlighted it reads `archive all but these` and leaves them. Do not put a button on a row whose label depends on the message, and do not repeat the bar's buttons over the message.

## threads

The inbox shows one row per conversation: its newest message, with a count when more of it is in the inbox. The row sits with the mail that needs me when any message in it does, not only the newest. What clears the row (archive, delete, snooze, keep, to do, a sent reply that archives) clears every inbox message in the conversation, and undo brings them all back. A message opened anywhere (inbox, search, receipts) shows its whole conversation from every folder, sent mail included, newest first. Do not go back to one row per message, and do not add a place that opens a message without its conversation.

## reading a message

An open message is shown as it was written: its own markup, links and pictures, in a frame that cannot run scripts (`MailBody`). The text kept on a message in the list is cut down for the model and is only what shows when the real message cannot be fetched. Do not put that text in front of the reader as the message.

In dark mode every message is darkened, whatever colours it was sent with. Each one has a `light mode` switch right above it for the message that cannot be read dark, and `dark mode` to switch back. In light mode mail is shown as sent and there is no switch (`mailLook`). Mail that was sent dark is left as it is. Do not show mail on a white card in dark mode unless that switch was used.

## compose

All mail is written in one screen (`Compose`): new message, reply, reply all, forward. Nothing sends the user to Outlook to finish a message. Do not add a second place that writes or sends mail, and do not add a link out to Outlook for something compose can do. Closing compose keeps what was written as an Outlook draft; only `discard` throws it away.

## chat

An open message has a `chat` link beside `find related`, wherever it is opened. It opens My Brain's personal chat about that conversation (`brainChatUrl`), passing the message id and nothing else. There is no chat in this app: do not build one here, and do not put any of a message's text in the link.

## archiving many

The inbox has two ways to archive in bulk, and both go through `sweep` in `src/views/InboxView.tsx`: `archive all` (at the end of the bar from 60rem up, where highlighted rows turn it into `archive all but these`; at the top of the list on a phone), and `archive everything else` among a message's actions. Archiving everything from one sender is `archive + rule`. Each clears whole conversations, leaves mail kept in the inbox alone, and offers undo for everything it moved. A new bulk action goes through `sweep` or `sweepOn`; do not add one that skips undo or touches kept mail.

`archive all`, `archive all but these` and `archive everything else` keep going (`sweepOn`, with `sweepStep` in `src/domain/threads.ts`): once the list is clear they load older mail and archive that too, page after page, until the mailbox has no more. That is how years of mail get cleared in one press. What was highlighted or named stays through every page, and so does mail that arrived after the press. The toast counts what has gone and has `stop`; when the run ends, by itself or by `stop`, one `undo` brings back everything it moved. Pages loaded this way are never sent to a model. Do not make these stop at the loaded list again, and do not let a run go on without `stop` on screen.

## archived mail is read

Nothing sits unread in the archive or the receipts folder. Every way mail is put away marks it read first: a tap, a bulk archive, clean up, a rule run by the app, auto-archive, a sent reply, a task (`file` and `fileMany` in `src/data/mailProvider.ts`), and the rules written to Outlook carry `markAsRead` (`compileRule`). An undo brings back as unread what was unread. Snoozed and deleted mail is left as it was. A new way to archive goes through `archive`, `archiveMany` or the receipts calls, never a bare `move`.

## new mail

Mail should show up about as fast as it does in Outlook. While the app is on screen it asks for new mail every few seconds (`peek`), and again the moment it comes back to the screen. What arrives is shown as soon as the rules have had their say, before any model sorts it; sorting then relabels it or takes it away. Do not hold fetched mail off screen until sorting finishes, and do not put a wait in front of the look for new mail. The quiet look changes nothing on screen when nothing came, and it stays one small request (`glance`: ids and the junk count, no bodies); full messages are fetched only once it finds something.

## model spend

Mail older than thirty days is never sent to Jev or Claude (`isOld`). It gets a free verdict and waits below needs me with the rest of the inbox; whatever it once asked for, the moment has passed. A verdict a model was paid for is kept: a failed call later in the same run does not throw it away, and what cleanup learns about a sender is remembered. Do not add a model call that runs on every message, on every scan, or on every device without a cheaper source in front of it.

A key on its own starts nothing. Jev and Claude sort mail by themselves only once `sort mail with ai` is on (`aiSorts`): I turn it on, or it turns itself on the first time the inbox is down to 200 or fewer, and a no from me is never overridden. Until then a key answers only what is tapped (a draft, a search). A backlog is cleared first, with rules and clean up, which need no model. Anything new that runs a model without a tap goes behind the same check.

One device pays for a message, not each of them. The whole verdict, summary included, is written onto the message (`setVerdict`) and read back with the mail, so another device shows it without asking a model. A device nobody is using (`document.hasFocus()` is false) shows new mail at once but leaves it unsorted for twenty seconds, then reads it again and sorts only what still has no verdict; picking the device up sorts it straight away. Do not keep part of a verdict on one device only, and do not let an idle device race the one in use.

## errors

An error is written in settings and nowhere else in the app, at the top of the settings screen; settings wears the dot while there is one. The inbox, rules and clean up never show a background failure. What stays where it happened is the answer to something just tapped on that screen: a send that failed in compose, a search that failed, the connect button before there is a mailbox. Jev being out of reach is a standing fact of some networks (Epic's blocks the relay), so settings says it and there is no dot.

## jev out of reach

With a Jev key, sorting is Jev's. When Jev cannot be reached, mail it would have sorted stays unsorted until a device that can reach it opens the inbox; Claude is not used in its place (`claudeReads`). Claude still reads what already has a verdict and needs me.

## committing and deploying

When a task is finished, commit the files you edited by name and push to main without asking. The push deploys the site.

## desktop

- Any screen that lists messages (inbox, search, receipts) uses the list with a reading pane beside it from 60rem up. From 60rem up each conversation in the list is its own card, and the open message is a card beside them, sized to the message rather than stretched across the screen. The card whose message is open is filled solid with the accent colour and lifted; a tint is not enough. Do not go back to rows joined in one box or a reading pane flush to the edges.
- The inbox is saved on the device and shown on open while the mailbox is checked in the background. A check never blanks or blocks the list; the status line and the spinning check mail button say it is running. There is no loading bar; do not add one.
- A new deploy reaches an open tab or installed window on its own (`src/appUpdate.ts`, the pattern in `~/.claude/patterns/app-update.md`). The app reloads onto it at a quiet moment: off screen, just reopened and not yet touched, or left alone for five minutes. It never reloads over an open sheet, a draft, or a screen that called `holdUpdates`, and it comes back to the screen it left. Until the reload happens, settings wears a dot and its button restarts onto the new build. Do not reload any other way, and do not rely on a manual refresh.
- Check layout changes in `dev/preview.html` at 3438x1440 and 1440x900 as well as the phone. Every screen is in the preview; add new ones to it.

## not noise

A sender I mark `not noise` in clean up is kept in `noRules` in `automation.json`, on every device. Nothing suggests that sender for a rule again: clean up lists it with everyone else (`likelyNoise`), the inbox offers no rule for it (`suggestRules`), and the sorter makes it none (`autoRuleSenders`). Anything new that suggests or makes a rule for a sender checks `noRules` first.

## old mail

Mail older than 30 days (`oldAfterDays` in `src/domain/triage.ts`) asks for nothing. It never counts as needs me, is never read by a model, and a rule never flags it or makes a task of it. Anything new that surfaces mail or acts on it goes through `isOld` first. Chase can still flag or make a task of an old message by hand.

Clean up archives all of it in one press (`old mail`, `oldMail` in `src/domain/cleanup.ts`): read or unread, everything past the cutoff except what is flagged, with an undo that lasts until the next scan. Do not narrow that sweep to read mail; a backlog is mostly unread.
