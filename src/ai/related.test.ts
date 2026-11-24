import { describe, expect, it, vi } from 'vitest'
import { message } from '../domain/fixtures'
import type { AnthropicClient } from './anthropicClient'
import { findRelated, parsePicks, parseQueries } from './related'

const client = (...replies: string[]) => {
  const createMessage = vi.fn(async () => ({ id: 'x', content: [{ type: 'text' as const, text: replies.shift() ?? '' }], stop_reason: 'end_turn' }))
  return { createMessage } as unknown as AnthropicClient & { createMessage: typeof createMessage }
}
const hit = (id: string, conversationId: string) => ({ message: message(id, 'a@example.com', id, { conversationId }), inInbox: false, folder: 'Archive' })
const open = message('m1', 'owen@example.com', 'Re: cabin weekend', { conversationId: 'cabin', body: 'I can drive if someone books the place.' })

describe('related mail', () => {
  it('takes one search per line out of numbering, fences, and repeats', () => {
    expect(parseQueries('```\n1. cabin (rental OR deposit)\n- "lake house"\ncabin (rental OR deposit)\n\nfrom:tess cabin\nextra query\n```')).toEqual(['cabin (rental OR deposit)', 'lake house', 'from:tess cabin'])
    expect(parseQueries('')).toEqual([])
  })

  it('reads the picks in order, without repeats or numbers that match nothing', () => {
    expect(parsePicks('3, 1, 3, 9', 4)).toEqual([3, 1])
    expect(parsePicks('none', 4)).toEqual([])
  })

  it('writes searches, runs them, and keeps what the model says is related, never the open conversation', async () => {
    const model = client('cabin rental\nlake house deposit', '2, 1')
    const search = vi.fn(async (query: string) => query === 'cabin rental'
      ? { hits: [hit('own', 'cabin'), hit('a', 'c1'), hit('b', 'c2')] }
      : { hits: [hit('b', 'c2'), hit('c', 'c3')] })
    const steps: string[] = []
    const found = await findRelated(model, 'claude-sonnet-5-5', open, search, '2026-11-24', (step) => steps.push(step))
    expect(search.mock.calls.map(([query]) => query)).toEqual(['cabin rental', 'lake house deposit'])
    expect(found.map((item) => item.message.id)).toEqual(['b', 'a'])
    expect(steps).toEqual(['writing the search', 'searching', 'reading 3 messages'])
    const read = model.createMessage.mock.calls[1] as unknown as [{ messages: { content: string }[] }]
    expect(read[0].messages[0].content).toContain('### message 3')
    expect(read[0].messages[0].content).not.toContain('### message 4')
  })

  it('does not ask the model to read when nothing was found, and survives one search the mailbox refuses', async () => {
    const empty = client('cabin rental')
    await expect(findRelated(empty, 'm', open, async () => ({ hits: [hit('own', 'cabin')] }), '2026-11-24')).resolves.toEqual([])
    expect(empty.createMessage).toHaveBeenCalledTimes(1)

    const partial = client('bad(\ncabin', '1')
    const found = await findRelated(partial, 'm', open, async (query) => { if (query === 'bad(') throw new Error('bad query'); return { hits: [hit('a', 'c1')] } }, '2026-11-24')
    expect(found.map((item) => item.message.id)).toEqual(['a'])
    await expect(findRelated(client('bad('), 'm', open, async () => { throw new Error('bad query') }, '2026-11-24')).rejects.toThrow('bad query')
  })
})
