/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { forgetMail, keptAfterDisconnect } from './localMail'

function storage(start: Record<string, string>) {
  const held = new Map(Object.entries(start))
  return {
    held,
    get length() { return held.size },
    key: (index: number) => [...held.keys()][index] ?? null,
    removeItem: (key: string) => { held.delete(key) },
  }
}

describe('what a disconnect leaves on the device', () => {
  it('removes everything learned from the mailbox and keeps settings, keys and appearance', () => {
    const device = storage({
      'my-mail.inbox.v1': '[{"subject":"Dinner Sunday?"}]',
      'my-mail.inbox.read.v1': 'true',
      'my-mail.triage.v1': '{"m1":{"summary":"mom asks about sunday dinner"}}',
      'my-mail.kept.v1': '{"m1":"now"}',
      'my-mail.automation.v1': '{"decisions":[{"from":"mom@example.com"}]}',
      'my-mail.searches.v1': '["property tax"]',
      'my-mail.senderKinds.v1': '{"news@daily.example.com":{"kind":"newsletter"}}',
      'my-mail.something-new.v1': '"mail"',
      'my-mail.settings.v1': '{"autoArchive":true}',
      'my-mail.accent': '"custom"',
      'my-mail.install-dismissed': '2026-11-01',
      'my-mail.folder.v1': 'archive',
      'my-brain.settings': '{}',
      'msal.account.keys': '[]',
    })
    const gone = forgetMail(device)
    expect(gone.sort()).toEqual(['my-mail.automation.v1', 'my-mail.inbox.read.v1', 'my-mail.inbox.v1', 'my-mail.kept.v1', 'my-mail.searches.v1', 'my-mail.senderKinds.v1', 'my-mail.something-new.v1', 'my-mail.triage.v1'])
    expect([...device.held.keys()].sort()).toEqual(['msal.account.keys', 'my-brain.settings', 'my-mail.accent', 'my-mail.folder.v1', 'my-mail.install-dismissed', 'my-mail.settings.v1'])
  })

  it('does nothing where there is no storage', () => {
    expect(forgetMail(undefined)).toEqual([])
    expect(forgetMail({ length: 1, key: () => { throw new Error('blocked') }, removeItem: () => {} })).toEqual([])
  })

  it('keeps every key the app stores under its own name, so none is missed', () => {
    const src = join(process.cwd(), 'src')
    const keys = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.|[\\/]dev[\\/]/.test(file) && !file.endsWith('localMail.ts'))
      .flatMap((file) => [...readFileSync(join(src, file), 'utf8').matchAll(/(?:Key|storageKey|localKey) = '([^']+)'/g)].map((match) => match[1]))
    expect(keys).toEqual(expect.arrayContaining(['my-mail.inbox.v1', 'my-mail.automation.v1', 'my-mail.settings.v1']))
    expect(keys.filter((key) => !key.startsWith('my-mail.'))).toEqual([])
    for (const key of keptAfterDisconnect) expect(keys).toContain(key)
  })

  it('forgets the mailbox in the app when it disconnects and when it opens signed out', () => {
    const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8')
    expect(app).toMatch(/if \(signedOut\) forgetMail\(\)/)
    expect(app).toMatch(/signOut\(\)\s+setSignedOut\(true\)/)
    expect(app).toMatch(/if \(!account\) \{[^\n]*setSignedOut\(true\)/)
  })
})
