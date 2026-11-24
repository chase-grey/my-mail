import type { Message } from './types'

/** The latest received time among these and what was seen before; the next look for new mail starts there. */
export function newestOf(messages: Message[], seen?: string): string | undefined {
  return messages.reduce<string | undefined>((newest, message) => !newest || message.receivedAt > newest ? message.receivedAt : newest, seen)
}

/** What a look at the mailbox found that the screen does not have: not listed already, and not just sent away. */
export function arrivals(found: Message[], held: Message[], left: ReadonlySet<string>): Message[] {
  const known = new Set(held.map((message) => message.id))
  const fresh: Message[] = []
  for (const message of found) {
    if (known.has(message.id) || left.has(message.id)) continue
    known.add(message.id)
    fresh.push(message)
  }
  return fresh
}

/** How long a device nobody is using leaves new mail unsorted, so the one in use can sort it first. */
export const idleHoldMs = 20_000

/**
 * Mail a device showed without sorting because it was not the one in use, by when it was first seen.
 * It is due once the device is in use again, or once the other device has had its chance.
 */
export function dueHeld(held: ReadonlyMap<string, number>, now: number, inUse: boolean, holdMs = idleHoldMs): string[] {
  return [...held.entries()].filter(([, since]) => inUse || now - since >= holdMs).map(([id]) => id)
}

/** The list with a batch of arrivals put in front, replacing any earlier showing of the same batch. */
export function withArrivals(held: Message[], batch: ReadonlySet<string>, showing: Message[], left: ReadonlySet<string>): Message[] {
  return [...showing.filter((message) => !left.has(message.id)), ...held.filter((message) => !batch.has(message.id))]
}
