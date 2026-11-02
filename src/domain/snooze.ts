import type { Message, Snooze } from './types'

export const snoozeOptions = ['this evening', 'tomorrow', 'this weekend', 'next week'] as const
export type SnoozeOption = typeof snoozeOptions[number]

function at(base: Date, hour: number): Date {
  const value = new Date(base)
  value.setHours(hour, 0, 0, 0)
  return value
}

function plusDays(base: Date, days: number): Date {
  const value = new Date(base)
  value.setDate(value.getDate() + days)
  return value
}

/** When a snoozed message comes back, as a local Date. */
export function snoozeUntil(option: SnoozeOption, now = new Date()): Date {
  switch (option) {
    case 'this evening': {
      const evening = at(now, 18)
      return evening > now ? evening : at(plusDays(now, 1), 18)
    }
    case 'tomorrow':
      return at(plusDays(now, 1), 8)
    case 'this weekend': {
      const untilSaturday = (6 - now.getDay() + 7) % 7 || 7
      return at(plusDays(now, untilSaturday), 9)
    }
    case 'next week': {
      const untilMonday = (8 - now.getDay()) % 7 || 7
      return at(plusDays(now, untilMonday), 8)
    }
  }
}

export function snoozeRecord(message: Message, until: Date): Snooze {
  return { messageId: message.id, until: until.toISOString(), subject: message.subject, from: message.from.address }
}

export function dueSnoozes(snoozes: Snooze[], now = new Date()): Snooze[] {
  const cutoff = now.toISOString()
  return snoozes.filter((snooze) => snooze.until <= cutoff)
}

export function withoutSnoozes(snoozes: Snooze[], ids: string[]): Snooze[] {
  const gone = new Set(ids)
  return snoozes.filter((snooze) => !gone.has(snooze.messageId))
}

export function describeSnooze(snooze: Snooze): string {
  const until = new Date(snooze.until)
  return until.toLocaleString(undefined, { weekday: 'short', hour: 'numeric' }).toLowerCase()
}
