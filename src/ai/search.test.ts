import { describe, expect, it, vi } from 'vitest'
import { message } from '../domain/fixtures'
import type { AnthropicClient } from './anthropicClient'
import { answerFromMail, cleanQuery, hitsText, translateQuery } from './search'

const client = (text: string) => ({ createMessage: vi.fn(async () => ({ id: 'x', content: [{ type: 'text' as const, text }], stop_reason: 'end_turn' })) })

describe('search with a model', () => {
  it('takes the query out of fences, labels, and wrapping quotes', () => {
    expect(cleanQuery('```kql\nfrom:ruth dinner\n```')).toBe('from:ruth dinner')
    expect(cleanQuery('Query: `electrician (invoice OR bill)`')).toBe('electrician (invoice OR bill)')
    expect(cleanQuery('"lease dates"')).toBe('lease dates')
    expect(cleanQuery('subject:"property tax" treasurer')).toBe('subject:"property tax" treasurer')
  })

  it('translates a sentence and refuses an empty result', async () => {
    const good = client('electrician (invoice OR bill) received>=2026-03-01')
    await expect(translateQuery(good as unknown as AnthropicClient, 'claude-sonnet-5-5', 'the electrician invoice from spring', '2026-11-19')).resolves.toBe('electrician (invoice OR bill) received>=2026-03-01')
    const request = good.createMessage.mock.calls[0] as unknown as [{ system: string; messages: { content: string }[] }]
    expect(request[0].system).toContain('Today is 2026-11-19.')
    expect(request[0].messages[0].content).toBe('the electrician invoice from spring')
    await expect(translateQuery(client('  ') as unknown as AnthropicClient, 'm', 'q', 't')).rejects.toThrow('could not write a search')
  })

  it('numbers the messages it hands over and returns the answer', async () => {
    const hits = [
      { message: message('m1', 'sparks@example.com', 'Invoice 114', { body: 'Total due: $480.' }), inInbox: false, folder: 'Archive' },
      { message: message('m2', 'sparks@example.com', 'Thanks', { preview: 'Paid, thank you.' }), inInbox: true },
    ]
    const text = hitsText(hits)
    expect(text).toContain('### message 1\nfrom: sparks <sparks@example.com>')
    expect(text).toContain('folder: Archive\nsubject: Invoice 114\n\nTotal due: $480.')
    expect(text).toContain('### message 2')
    expect(text).toContain('subject: Thanks\n\nPaid, thank you.')
    const model = client('It was $480 [1].')
    await expect(answerFromMail(model as unknown as AnthropicClient, 'm', 'what was the total', hits, { aboutMe: '', today: '2026-11-19' })).resolves.toBe('It was $480 [1].')
  })
})
