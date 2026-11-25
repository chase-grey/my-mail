export type Message = {
  /** Immutable Graph id, stable across folder moves. */
  id: string
  conversationId?: string
  subject: string
  from: { name: string; address: string }
  receivedAt: string
  preview: string
  body: string
  isRead: boolean
  flagged: boolean
  importance: 'low' | 'normal' | 'high'
  hasAttachments: boolean
  /** How many people it was sent to, to and cc together. More than one makes it group mail. */
  recipients?: number
  /** Who it was written to. Only mail read from a folder carries it; sent mail and drafts are listed by it. */
  to?: { name: string; address: string }[]
  /** Outlook categories on the message. The model's verdict is written here so every device shares it. */
  categories: string[]
  /** The whole verdict, when a device has written one onto the message. Every device reads it with the mail, so none pays to sort or read it again. */
  verdict?: SharedVerdict
  webLink: string
}

/** The part of a verdict that travels on the message itself. Drafts stay on the device that asked for them. */
export type SharedVerdict = {
  category: Category
  summary: string
  needsReply: boolean
  suggested: Action
  task?: string
  confidence: number
}

export const categories = ['reply', 'action', 'waiting', 'fyi', 'receipt', 'notification', 'newsletter', 'promo', 'spam'] as const
export type Category = typeof categories[number]

export const actions = ['archive', 'delete', 'task', 'reply', 'keep', 'snooze', 'read', 'flag', 'unsubscribe'] as const
export type Action = typeof actions[number]

/** Who decided the category: Claude read it, Jev scored it, Outlook already had it, the sender's history settled it, it carries a code and stays, or it was too old to spend a model on. */
export type TriageSource = 'model' | 'jev' | 'outlook' | 'history' | 'code' | 'age'

export type Triage = {
  messageId: string
  category: Category
  /** Empty when no language model has read the message; the card shows Outlook's preview instead. */
  summary: string
  needsReply: boolean
  suggested: Action
  draft?: string
  task?: string
  confidence: number
  source: TriageSource
  triagedAt: string
}

export const ruleActions = ['archive', 'receipts', 'delete', 'read', 'task', 'flag'] as const
export type RuleAction = typeof ruleActions[number]

export type Rule = {
  id: string
  from?: string
  subject?: string
  action: RuleAction
  enabled: boolean
  createdAt: string
  hits: number
  /** Made by the sorter after it auto-archived this sender, not by me. */
  auto?: boolean
  /** Set when the rule has been written to Outlook and runs on the server while the app is closed. */
  outlookId?: string
}

/** A rule that lives in Outlook. Ours carry the app's name prefix; the rest were made in Outlook and are read-only here. */
export type OutlookRule = {
  id: string
  displayName: string
  isEnabled: boolean
  sequence: number
  /** The rule marks what it catches as read. */
  marksRead: boolean
  /** The rule has the exception that leaves mail with a sign-in code in the inbox. */
  sparesCodes: boolean
  description: string
}

export type Decision = {
  messageId: string
  from: string
  action: Action
  at: string
  /** The archive went to the receipts folder. Three of these suggest a receipts rule for the sender, not an archive rule. */
  receipt?: boolean
  /** The message had not been opened when the decision was made. Three unread archives from a sender settle the next one without a model. */
  unread?: boolean
}

export type Snooze = {
  messageId: string
  until: string
  subject: string
  from: string
}

export type Automation = {
  rules: Rule[]
  decisions: Decision[]
  snoozes: Snooze[]
  /** Senders I marked not noise in clean up, or whose auto-made rule I deleted. Nothing makes or suggests them a rule. */
  noRules?: string[]
}

export const emptyAutomation: Automation = { rules: [], decisions: [], snoozes: [] }
