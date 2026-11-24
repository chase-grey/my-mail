export const defaultModel = 'claude-haiku-5-5'
export const defaultStrongModel = 'claude-sonnet-5-5'
export const modelOptions = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const

export type Settings = {
  anthropicApiKey: string
  /** Reads and summarizes. Haiku; it is the model that runs on every message a rule or Jev did not settle. */
  anthropicModel: string
  /** Drafts on request and, later, search. Used only when a tap asks for it. */
  strongModel: string
  /** TypeSafe Jev. When set, categories come from Jev and the language model reads only what needs me. */
  jevApiKey: string
  /**
   * Whether Jev and Claude sort mail on their own. Unset until I turn it on or the inbox is small enough to start by itself;
   * until then a key only answers what I tap (drafts, search).
   */
  aiSorting?: boolean
  aboutMe: string
  autoArchive: boolean
  archiveAfterReply: boolean
  /** Receipts go to their own folder instead of the archive, and the ones the sorter is sure about go there on their own. */
  fileReceipts: boolean
  /** Write each verdict to the message as an Outlook category so other devices and Outlook rules can use it. */
  writeCategories: boolean
  brainUrl: string
}

export const defaultSettings: Settings = {
  anthropicApiKey: '',
  anthropicModel: defaultModel,
  strongModel: defaultStrongModel,
  jevApiKey: '',
  aboutMe: '',
  autoArchive: false,
  archiveAfterReply: true,
  fileReceipts: true,
  writeCategories: true,
  brainUrl: 'https://chase-grey.github.io/my-brain/',
}

const storageKey = 'my-mail.settings.v1'

/** An inbox this size or smaller is one worth sorting; a bigger one is a backlog to clear first. */
export const manageableInbox = 200

/** Models run on their own only once sorting is on. */
export function aiSorts(settings: Settings): boolean {
  return settings.aiSorting === true && Boolean(settings.anthropicApiKey || settings.jevApiKey)
}

/** Sorting starts by itself the first time the inbox is small enough, unless I have already said yes or no. */
export function aiStartsItself(settings: Settings, inboxCount: number | undefined): boolean {
  return settings.aiSorting === undefined && Boolean(settings.anthropicApiKey || settings.jevApiKey) && inboxCount !== undefined && inboxCount <= manageableInbox
}

const text = (value: unknown, fallback: string) => typeof value === 'string' ? value : fallback
const flag = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback

export function parseSettings(stored: unknown): Settings {
  const value = (stored && typeof stored === 'object' ? stored : {}) as Partial<Record<keyof Settings, unknown>>
  return {
    anthropicApiKey: text(value.anthropicApiKey, '').trim(),
    anthropicModel: text(value.anthropicModel, defaultModel) || defaultModel,
    strongModel: text(value.strongModel, defaultStrongModel) || defaultStrongModel,
    jevApiKey: text(value.jevApiKey, '').trim(),
    aiSorting: typeof value.aiSorting === 'boolean' ? value.aiSorting : undefined,
    aboutMe: text(value.aboutMe, ''),
    autoArchive: flag(value.autoArchive, defaultSettings.autoArchive),
    archiveAfterReply: flag(value.archiveAfterReply, defaultSettings.archiveAfterReply),
    fileReceipts: flag(value.fileReceipts, defaultSettings.fileReceipts),
    writeCategories: flag(value.writeCategories, defaultSettings.writeCategories),
    brainUrl: text(value.brainUrl, defaultSettings.brainUrl),
  }
}

export function loadSettings(): Settings {
  try {
    return parseSettings(JSON.parse(localStorage.getItem(storageKey) ?? '{}'))
  } catch {
    return defaultSettings
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings))
  } catch {
    // Storage can be unavailable; the in-memory settings still work for the session.
  }
}
