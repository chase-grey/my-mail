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

## one inbox

There is no junk folder. Every run moves what Outlook junked into the inbox before reading it (`rescueJunk`), and that mail goes through the same rules and sorting as the rest. Blocking is done with rules. Do not add a junk view, and do not read the inbox without emptying junk first.

## inbox layout

The inbox is one list with one extra thing on top: a `needs me` section, its count beside the heading. All other mail follows below it with no heading and no category name. There is no `probably fine` group, no side by side columns, and no summary line of counts above the list; the line under search only says a check is running.

## needs me gets shorter as I work

Clearing mail never brings other mail in to take its place. A full check reads the inbox back to the oldest mail already on the list and no further (`depthOf`); it does not read by count. Older mail comes only from the end of the list (`load more`). Mail a model is about to sort waits below needs me until its verdict lands, and joins needs me only if the verdict says so (`pending`). Mail no model will sort (sorting off, a failed call) counts as needs me. A flag or high importance never waits.

## threads

The inbox shows one row per conversation: its newest message, with a count when more of it is in the inbox. The row sits with the mail that needs me when any message in it does, not only the newest. What clears the row (archive, delete, snooze, keep, to do, a sent reply that archives) clears every inbox message in the conversation, and undo brings them all back. A message opened anywhere (inbox, search, receipts) shows its whole conversation from every folder, sent mail included, newest first. Do not go back to one row per message, and do not add a place that opens a message without its conversation.

## reading a message

An open message is shown as it was written: its own markup, links and pictures, in a frame that cannot run scripts (`MailBody`). The text kept on a message in the list is cut down for the model and is only what shows when the real message cannot be fetched. Do not put that text in front of the reader as the message.

In dark mode every message is darkened, whatever colours it was sent with. Each one has a `light mode` switch right above it for the message that cannot be read dark, and `dark mode` to switch back. In light mode mail is shown as sent and there is no switch (`mailLook`). Mail that was sent dark is left as it is. Do not show mail on a white card in dark mode unless that switch was used.

## compose

All mail is written in one screen (`Compose`): new message, reply, reply all, forward. Nothing sends the user to Outlook to finish a message. Do not add a second place that writes or sends mail, and do not add a link out to Outlook for something compose can do. Closing compose keeps what was written as an Outlook draft; only `discard` throws it away.

## new mail

Mail should show up about as fast as it does in Outlook. While the app is on screen it asks for new mail every few seconds (`peek`), and again the moment it comes back to the screen. What arrives is shown as soon as the rules have had their say, before any model sorts it; sorting then relabels it or takes it away. Do not hold fetched mail off screen until sorting finishes, and do not put a wait in front of the look for new mail. The quiet look changes nothing on screen when nothing came, and it stays one small request (`glance`: ids and the junk count, no bodies); full messages are fetched only once it finds something.

## model spend

Mail older than thirty days is never sent to Jev or Claude (`isOld`). It gets a free verdict and waits below needs me with the rest of the inbox; whatever it once asked for, the moment has passed. A verdict a model was paid for is kept: a failed call later in the same run does not throw it away, and what cleanup learns about a sender is remembered. Do not add a model call that runs on every message, on every scan, or on every device without a cheaper source in front of it.

A key on its own starts nothing. Jev and Claude sort mail by themselves only once `sort mail with ai` is on (`aiSorts`): I turn it on, or it turns itself on the first time the inbox is down to 200 or fewer, and a no from me is never overridden. Until then a key answers only what is tapped (a draft, a search). A backlog is cleared first, with rules and clean up, which need no model. Anything new that runs a model without a tap goes behind the same check.

One device pays for a message, not each of them. The whole verdict, summary included, is written onto the message (`setVerdict`) and read back with the mail, so another device shows it without asking a model. A device nobody is using (`document.hasFocus()` is false) shows new mail at once but leaves it unsorted for twenty seconds, then reads it again and sorts only what still has no verdict; picking the device up sorts it straight away. Do not keep part of a verdict on one device only, and do not let an idle device race the one in use.

## committing and deploying

When a task is finished, commit the files you edited by name and push to main without asking. The push deploys the site.

## desktop

- Any screen that lists messages (inbox, search, receipts) uses the list with a reading pane beside it from 60rem up. From 60rem up each conversation in the list is its own card, and the open message is a card beside them, sized to the message rather than stretched across the screen. The card whose message is open is filled solid with the accent colour and lifted; a tint is not enough. Do not go back to rows joined in one box or a reading pane flush to the edges.
- The inbox is saved on the device and shown on open while the mailbox is checked in the background. A check never blanks or blocks the list; the status line and progress bar say it is running.
- A new deploy reaches an open tab or installed window on its own (`src/appUpdate.ts`, the pattern in `~/.claude/patterns/app-update.md`). The app reloads onto it at a quiet moment: off screen, just reopened and not yet touched, or left alone for five minutes. It never reloads over an open sheet, a draft, or a screen that called `holdUpdates`, and it comes back to the screen it left. Until the reload happens, settings wears a dot and its button restarts onto the new build. Do not reload any other way, and do not rely on a manual refresh.
- Check layout changes in `dev/preview.html` at 3438x1440 and 1440x900 as well as the phone. Every screen is in the preview; add new ones to it.

## old mail

Mail older than 30 days (`oldAfterDays` in `src/domain/triage.ts`) asks for nothing. It never counts as needs me, is never read by a model, and a rule never flags it or makes a task of it. Anything new that surfaces mail or acts on it goes through `isOld` first. Chase can still flag or make a task of an old message by hand.
