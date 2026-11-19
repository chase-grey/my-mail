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
  /** Outlook categories on the message. The model's verdict is written here so every device shares it. */
  categories: string[]
  webLink: string
}

export const categories = ['reply', 'action', 'waiting', 'fyi', 'receipt', 'notification', 'newsletter', 'promo', 'spam'] as const
export type Category = typeof categories[number]

export const actions = ['archive', 'delete', 'task', 'reply', 'keep', 'snooze', 'read', 'flag', 'unsubscribe'] as const
export type Action = typeof actions[number]

/** Who decided the category: Claude read it, Jev scored it, Outlook already had it, or the sender's history settled it. */
export type TriageSource = 'model' | 'jev' | 'outlook' | 'history'

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

export const ruleActions = ['archive', 'delete', 'read', 'task', 'flag'] as const
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
  description: string
}

export type Decision = {
  messageId: string
  from: string
  action: Action
  at: string
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
  /** Senders whose auto-made rule I deleted. The sorter does not make them another. */
  noRules?: string[]
}

export const emptyAutomation: Automation = { rules: [], decisions: [], snoozes: [] }
