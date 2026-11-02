import { emptyAutomation, type Automation } from '../domain/types'
import type { AppFolder } from './appFolder'

export type StoredAutomation = Automation & { updatedAt: string }

export const automationFile = 'mail/automation.json'
const localKey = 'my-mail.automation.v1'

export function parseAutomation(value: unknown): StoredAutomation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<StoredAutomation>
  const list = <T,>(items: unknown): T[] => Array.isArray(items) ? items as T[] : []
  return {
    rules: list(record.rules),
    decisions: list(record.decisions),
    snoozes: list(record.snoozes),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
}

/** The copy saved most recently wins. Phone and PC each sync the whole file, so the one that changed last is the truth. */
export function newer(local: StoredAutomation | undefined, remote: StoredAutomation | undefined): StoredAutomation {
  if (!local && !remote) return { ...emptyAutomation, updatedAt: '' }
  if (!local) return remote!
  if (!remote) return local
  return remote.updatedAt > local.updatedAt ? remote : local
}

export function loadLocalAutomation(): StoredAutomation | undefined {
  try {
    return parseAutomation(JSON.parse(localStorage.getItem(localKey) ?? 'null'))
  } catch {
    return undefined
  }
}

export function saveLocalAutomation(value: StoredAutomation): void {
  try {
    localStorage.setItem(localKey, JSON.stringify(value))
  } catch {
    // Keep going in memory when storage is unavailable.
  }
}

export class AutomationStore {
  constructor(private readonly folder?: AppFolder) {}

  async load(): Promise<StoredAutomation> {
    const local = loadLocalAutomation()
    const remote = this.folder ? parseAutomation(await this.folder.readJson(automationFile)) : undefined
    const result = newer(local, remote)
    saveLocalAutomation(result)
    return result
  }

  async save(value: Automation, now = new Date().toISOString()): Promise<StoredAutomation> {
    const stored = { ...value, updatedAt: now }
    saveLocalAutomation(stored)
    if (this.folder) await this.folder.writeJson(automationFile, stored)
    return stored
  }
}
