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

/** The list with a batch of arrivals put in front, replacing any earlier showing of the same batch. */
export function withArrivals(held: Message[], batch: ReadonlySet<string>, showing: Message[], left: ReadonlySet<string>): Message[] {
  return [...showing.filter((message) => !left.has(message.id)), ...held.filter((message) => !batch.has(message.id))]
}
