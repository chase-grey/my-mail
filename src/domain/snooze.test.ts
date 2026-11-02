import { describe, expect, it } from 'vitest'
import { dueSnoozes, snoozeRecord, snoozeUntil, withoutSnoozes } from './snooze'
import { message } from './fixtures'

// Monday 2026-11-02, 10:30 local
const monday = new Date(2026, 10, 2, 10, 30)
const local = (value: Date) => `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()} ${value.getHours()}:${String(value.getMinutes()).padStart(2, '0')}`

describe('snooze', () => {
  it('picks the next sensible return time', () => {
    expect(local(snoozeUntil('this evening', monday))).toBe('2026-11-2 18:00')
    expect(local(snoozeUntil('this evening', new Date(2026, 10, 2, 19, 0)))).toBe('2026-11-3 18:00')
    expect(local(snoozeUntil('tomorrow', monday))).toBe('2026-11-3 8:00')
    expect(local(snoozeUntil('this weekend', monday))).toBe('2026-11-7 9:00')
    expect(local(snoozeUntil('this weekend', new Date(2026, 10, 7, 12, 0)))).toBe('2026-11-14 9:00')
    expect(local(snoozeUntil('next week', monday))).toBe('2026-11-9 8:00')
    expect(local(snoozeUntil('next week', new Date(2026, 10, 8, 12, 0)))).toBe('2026-11-9 8:00')
  })

  it('returns the snoozes whose time has come', () => {
    const early = snoozeRecord(message('m1', 'a@example.com'), new Date(2026, 10, 2, 8, 0))
    const late = snoozeRecord(message('m2', 'b@example.com'), new Date(2026, 10, 3, 8, 0))
    expect(dueSnoozes([early, late], monday).map((item) => item.messageId)).toEqual(['m1'])
    expect(withoutSnoozes([early, late], ['m1']).map((item) => item.messageId)).toEqual(['m2'])
  })
})
