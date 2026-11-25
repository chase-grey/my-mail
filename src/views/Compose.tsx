import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { attachmentLimit, type ComposeActions, type ComposeMode, type Draft, type DraftAttachment } from '../data/compose'
import { fileSize, formatRecipients, parseRecipients, withNames, type Recipient } from '../domain/recipients'
import type { Message } from '../domain/types'
import { Icon } from '../ui'
import './compose.css'

/** What to write: a new message, or an answer to one. `text` starts the body, as a suggested reply does. */
export type ComposeRequest = {
  mode: ComposeMode
  message?: Message
  text?: string
  /** The message being answered is in the inbox, so sending may clear it. */
  onCard?: boolean
  onSent?: () => void
}

export const composeTitle: Record<ComposeMode, string> = { new: 'new message', reply: 'reply', replyAll: 'reply all', forward: 'forward' }

const failed = (error: unknown) => error instanceof Error ? error.message.toLowerCase() : 'something failed'

/**
 * The one place mail is written. Replies and forwards are Outlook drafts from the moment they open, a new message
 * from its first file or save. Closing keeps what was written as a draft; closing an untouched one leaves nothing behind.
 */
export function Compose({ request, actions, contacts, onDraft, onSent, onClose }: {
  request: ComposeRequest
  actions: ComposeActions
  /** People to offer as the address is typed. */
  contacts: Recipient[]
  /** Writes the reply on request. Left out when there is no model or nothing to answer. */
  /** Writes a draft, or improves what is already written when `written` has any text. */
  onDraft?: (strong: boolean, instruction?: string, written?: string) => Promise<string>
  onSent: () => Promise<void> | void
  onClose: (note?: string) => void
}) {
  const { mode } = request
  const dialog = useRef<HTMLDialogElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const toField = useRef<HTMLInputElement>(null)
  const body = useRef<HTMLTextAreaElement>(null)
  const started = useRef<Promise<Draft>>(undefined)
  const uploads = useRef<Promise<void>>(Promise.resolve())
  const touched = useRef(false)
  const [starting, setStarting] = useState(mode !== 'new')
  const [known, setKnown] = useState<Recipient[]>(contacts)
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState('')
  const [text, setText] = useState(request.text ?? '')
  const [files, setFiles] = useState<DraftAttachment[]>([])
  const [uploading, setUploading] = useState<{ key: string; name: string }[]>([])
  const [instruction, setInstruction] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [working, setWorking] = useState<'sending' | 'saving' | 'closing'>()
  const [failure, setFailure] = useState<string>()
  const [over, setOver] = useState(false)

  /** The draft behind this message, made the first time something needs it. */
  function draft(): Promise<Draft> {
    started.current ??= actions.start(mode, request.message?.id).catch((error: unknown) => { started.current = undefined; throw error })
    return started.current
  }

  useEffect(() => {
    dialog.current?.showModal()
    // An answer starts in the body; a message with nobody on it yet starts at who it is for.
    if (mode === 'new') toField.current?.focus()
    else body.current?.focus()
    if (mode === 'new') return
    let live = true
    draft().then((made) => {
      if (!live) return
      setKnown((current) => [...made.to, ...made.cc, ...current])
      setTo(formatRecipients(made.to))
      setCc(formatRecipients(made.cc))
      setShowCc(made.cc.length > 0)
      setSubject(made.subject)
      setFiles(made.attachments)
    }).catch((error: unknown) => { if (live) setFailure(failed(error)) }).finally(() => { if (live) setStarting(false) })
    return () => { live = false }
  }, [])

  // A forward has nobody on it; once the field is live the cursor belongs there.
  useEffect(() => { if (!starting && mode === 'forward' && !touched.current) toField.current?.focus() }, [starting])

  const edit = <T,>(set: (value: T) => void) => (value: T) => { touched.current = true; set(value) }
  const sentTo = parseRecipients(to)
  const copied = parseRecipients(cc)
  const invalid = [...sentTo.invalid, ...copied.invalid]
  const fields = () => ({ to: withNames(sentTo.recipients, known), cc: withNames(copied.recipients, known), subject: subject.trim(), text })
  const busy = Boolean(working)

  function add(list: File[]): void {
    if (!list.length || busy) return
    const total = [...files, ...list].reduce((sum, file) => sum + file.size, 0)
    if (total > attachmentLimit) { setFailure(`attachments are over ${fileSize(attachmentLimit)}`); return }
    setFailure(undefined)
    touched.current = true
    for (const file of list) {
      const key = crypto.randomUUID()
      setUploading((current) => [...current, { key, name: file.name }])
      uploads.current = uploads.current.then(async () => {
        try {
          setFiles(await actions.attach((await draft()).id, file))
        } catch (error) {
          setFailure(failed(error))
        } finally {
          setUploading((current) => current.filter((item) => item.key !== key))
        }
      })
    }
  }

  function remove(file: DraftAttachment): void {
    touched.current = true
    setFiles((current) => current.filter((item) => item.id !== file.id))
    void draft().then((made) => actions.detach(made.id, file.id)).catch((error: unknown) => { setFiles((current) => [...current, file]); setFailure(failed(error)) })
  }

  /** Everything typed and attached, written onto the draft. */
  async function write(): Promise<Draft> {
    const made = await draft()
    await uploads.current
    await actions.save(made, fields())
    return made
  }

  async function send(): Promise<void> {
    if (busy || starting) return
    if (invalid.length) { setFailure(`not an address: ${invalid.join(', ')}`); return }
    if (!sentTo.recipients.length && !copied.recipients.length) return
    setWorking('sending'); setFailure(undefined)
    try {
      await actions.send((await write()).id)
    } catch (error) {
      setFailure(failed(error)); setWorking(undefined)
      return
    }
    // The mail has gone; what follows it (archiving the original) reports its own failure.
    try { await onSent() } catch { /* shown by the screen behind */ }
    onClose('sent')
  }

  async function save(): Promise<void> {
    if (busy) return
    setWorking('saving'); setFailure(undefined)
    try {
      await write()
      onClose('saved to drafts')
    } catch (error) {
      setFailure(failed(error)); setWorking(undefined)
    }
  }

  async function discard(): Promise<void> {
    if (busy) return
    setWorking('closing')
    try {
      if (started.current) await actions.discard((await started.current).id)
    } catch {
      // Nothing was made, or it is already gone.
    }
    onClose()
  }

  /** Closing keeps what was written. A message nobody touched leaves no draft behind. */
  function close(): void {
    if (busy) return
    const written = touched.current || (mode === 'new' && Boolean(to.trim() || subject.trim() || text.trim()))
    void (written ? save() : discard())
  }

  // A new message with nothing written and nothing asked for gives a model nothing to write from.
  const nothingToGoOn = !request.message && !text.trim() && !instruction.trim()
  const draftNow = (strong: boolean) => {
    if (!onDraft) return
    setDrafting(true); setFailure(undefined)
    void onDraft(strong, instruction, text).then(edit(setText)).catch((error: unknown) => setFailure(failed(error))).finally(() => setDrafting(false))
  }

  const onDrop = (event: DragEvent) => { event.preventDefault(); setOver(false); add([...event.dataTransfer.files]) }
  const onPaste = (event: ClipboardEvent) => { if (event.clipboardData.files.length) { event.preventDefault(); add([...event.clipboardData.files]) } }

  return <dialog className={`sheet compose${over ? ' is-over' : ''}`} ref={dialog} aria-label={composeTitle[mode]}
    onCancel={(event) => { event.preventDefault(); close() }} onClick={(event) => { if (event.target === dialog.current) close() }}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setOver(true) } }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
    <form className="compose-body" onSubmit={(event) => { event.preventDefault(); void send() }} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send() } }}>
      <header className="compose-head">
        <h2>{composeTitle[mode]}</h2>
        <button className="icon-button" type="button" aria-label="close" title="close" disabled={busy} onClick={close}><Icon name="close" /></button>
      </header>

      <label className="compose-field">
        <span>to</span>
        <input type="email" multiple list="compose-contacts" autoComplete="off" autoCapitalize="off" spellCheck={false} ref={toField} disabled={starting} value={to} onChange={(event) => edit(setTo)(event.target.value)} />
        {!showCc && <button className="link" type="button" onClick={() => setShowCc(true)}>cc</button>}
      </label>
      {showCc && <label className="compose-field">
        <span>cc</span>
        <input type="email" multiple list="compose-contacts" autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={starting} value={cc} onChange={(event) => edit(setCc)(event.target.value)} />
      </label>}
      <label className="compose-field">
        <span>subject</span>
        <input disabled={starting} value={subject} onChange={(event) => edit(setSubject)(event.target.value)} />
      </label>
      <datalist id="compose-contacts">{[...new Map(known.map((item) => [item.address, item])).values()].map((item) => <option key={item.address} value={item.address}>{item.name}</option>)}</datalist>

      <textarea className="compose-text" aria-label="message" ref={body} value={text} onChange={(event) => edit(setText)(event.target.value)} onPaste={onPaste} />

      {(files.length > 0 || uploading.length > 0) && <ul className="compose-files">
        {files.map((file) => <li key={file.id}>
          <span className="name">{file.name}</span><small>{fileSize(file.size)}</small>
          <button type="button" aria-label={`remove ${file.name}`} title="remove" disabled={busy} onClick={() => remove(file)}><Icon name="close" size={14} /></button>
        </li>)}
        {uploading.map((file) => <li key={file.key} className="is-uploading"><span className="name">{file.name}</span><small>uploading</small></li>)}
      </ul>}

      {onDraft && <div className="compose-model">
        <input aria-label="what to say" value={instruction} placeholder="yes, but push it to 6" onChange={(event) => setInstruction(event.target.value)} />
        <button className="link" type="button" disabled={drafting || nothingToGoOn} onClick={() => draftNow(false)}>{drafting ? 'drafting' : text.trim() ? 'improve' : 'draft for me'}</button>
        <button className="plain" type="button" disabled={drafting || nothingToGoOn} onClick={() => draftNow(true)}>better draft</button>
      </div>}

      {failure && <p className="note is-error" role="alert">{failure}</p>}

      <div className="compose-actions">
        <button className="primary" type="submit" disabled={busy || starting || (!sentTo.recipients.length && !copied.recipients.length)}>{working === 'sending' ? 'sending' : 'send'}</button>
        <button className="secondary" type="button" disabled={busy} onClick={() => picker.current?.click()}>attach</button>
        <button className="plain" type="button" disabled={busy} onClick={() => void save()}>{working === 'saving' ? 'saving' : 'save draft'}</button>
        <button className="plain" type="button" disabled={busy} onClick={() => void discard()}>discard</button>
        <input ref={picker} type="file" multiple hidden onChange={(event) => { add([...(event.target.files ?? [])]); event.target.value = '' }} />
      </div>
    </form>
  </dialog>
}
