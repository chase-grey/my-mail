import { describe, expect, it } from 'vitest'
import { dueHeld, idleHoldMs } from './arrivals'
import { message } from './fixtures'
import { needsReading, outlookTriage, readShared, sharedOf, worthSharing, writeShared } from './triage'
import type { Triage } from './types'

const triage = (overrides: Partial<Triage>): Triage => ({ messageId: 'm1', category: 'reply', summary: 'mom asks about sunday dinner', needsReply: true, suggested: 'reply', confidence: 0.92, source: 'model', triagedAt: 'then', ...overrides })

describe('a verdict shared on the message', () => {
  it('comes back whole on another device, which then pays for nothing', () => {
    const written = writeShared(sharedOf(triage({ task: 'call mom', draft: 'never leaves this device' })))
    expect(written).not.toContain('never leaves')
    const verdict = readShared(written)
    expect(verdict).toEqual({ category: 'reply', summary: 'mom asks about sunday dinner', needsReply: true, suggested: 'reply', task: 'call mom', confidence: 0.92 })
    const there = message('m1', 'mom@example.com', 'Dinner?', { verdict })
    const read = outlookTriage(there, 'now')
    expect(read).toMatchObject({ category: 'reply', summary: 'mom asks about sunday dinner', needsReply: true, source: 'outlook' })
    expect(needsReading(there, read, '2026-11-10T00:00:00Z')).toBe(false)
    expect(worthSharing(there, read!)).toBe(false)
  })

  it('ignores anything on the message that is not a verdict of ours', () => {
    expect(readShared(undefined)).toBeUndefined()
    expect(readShared('not json')).toBeUndefined()
    expect(readShared('{"c":"urgent"}')).toBeUndefined()
    expect(readShared('{"c":"promo","a":"explode","p":7}')).toEqual({ category: 'promo', summary: '', needsReply: false, suggested: 'keep', task: undefined, confidence: 1 })
  })

  it('is written only when it says something the message does not', () => {
    const plain = message('m1', 'mom@example.com')
    expect(worthSharing(plain, triage({ source: 'jev', summary: '' }))).toBe(true)
    expect(worthSharing(plain, triage({ source: 'age' }))).toBe(false)
    // Read off the category alone: nothing to add until a summary is.
    const labelled = message('m1', 'mom@example.com', 'x', { categories: ['reply'] })
    const fromCategory = outlookTriage(labelled, 'now')!
    expect(worthSharing(labelled, fromCategory)).toBe(false)
    expect(worthSharing(labelled, { ...fromCategory, summary: 'mom asks about sunday dinner' })).toBe(true)
    // A summary added to a verdict the message already carries is new.
    const carried = message('m1', 'mom@example.com', 'x', { verdict: sharedOf(triage({ summary: '' })) })
    expect(worthSharing(carried, triage({}))).toBe(true)
  })
})

describe('mail held on a device nobody is using', () => {
  it('waits for the other device, and is due at once when this one is picked up', () => {
    const held = new Map([['a', 1_000], ['b', 15_000]])
    expect(dueHeld(held, 16_000, false)).toEqual([])
    expect(dueHeld(held, 1_000 + idleHoldMs, false)).toEqual(['a'])
    expect(dueHeld(held, 16_000, true)).toEqual(['a', 'b'])
    expect(dueHeld(new Map(), 16_000, true)).toEqual([])
  })
})
