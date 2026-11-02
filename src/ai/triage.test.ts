import { describe, expect, it, vi } from 'vitest'
import { message } from '../domain/fixtures'
import type { AnthropicClient, MessagesRequest } from './anthropicClient'
import { batches, buildDraftRequest, buildRequest, draftReply, messagesText, parseResults, readMessages, toolChoiceFor, triageMessages } from './triage'

const context = { aboutMe: 'I am Chase. Short and friendly.', today: '2026-11-02' }
const items = (...list: ReturnType<typeof message>[]) => list.map((item) => ({ message: item }))

describe('ai triage', () => {
  it('numbers messages instead of sending ids, asks for low effort, and forces the tool on haiku only', () => {
    const request = buildRequest('claude-haiku-5-5', items(message('m1', 'mom@example.com', 'dinner?', { body: 'Sunday at 6?' }), message('m2', 'deals@shop.example.com', 'sale')), context)
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'triage_messages' })
    expect(request.output_config).toEqual({ effort: 'low' })
    expect(request.system).toContain('I am Chase')
    const text = (request.messages[0].content as string)
    expect(text).toContain('### message 1')
    expect(text).not.toContain('m1')
    expect(text).toContain('Sunday at 6?')
    expect(text).toContain('### message 2')
    expect(messagesText(items(message('m3', 'a@example.com', 'x', { flagged: true, importance: 'high' })))).toContain('flagged: yes\nimportance: high')
    expect(toolChoiceFor('claude-sonnet-5-5', 'triage_messages')).toEqual({ type: 'auto' })
    expect(buildRequest('claude-sonnet-5-5', items(message('m1', 'a@example.com')), context).messages[0].content).toContain('Call triage_messages once')
  })

  it('tells the model what is already known and never asks for a draft', () => {
    const text = messagesText([{ message: message('m1', 'mom@example.com'), known: { category: 'reply', needsReply: true } }], () => 'history with sender: replied 3')
    expect(text).toContain('known category: reply, needs a reply')
    expect(text).toContain('history with sender: replied 3')
    expect(JSON.stringify(buildRequest('claude-haiku-5-5', items(message('m1', 'a@example.com')), context).tools)).not.toContain('draft')
  })

  it('keeps only verdicts for known numbers, repairs bad fields, and lets a known category win', () => {
    const results = parseResults({ results: [
      { n: 1, category: 'reply', summary: ' mom asks about dinner ', needs_reply: true, suggested: 'reply', confidence: 0.97 },
      { n: 2, category: 'weird', summary: 'x', needs_reply: false, suggested: 'nope', confidence: 7 },
      { n: '1', category: 'spam', summary: 'dup', needs_reply: false, suggested: 'delete', confidence: 1 },
      { n: 9, category: 'fyi', summary: 'not ours', needs_reply: false, suggested: 'keep', confidence: 1 },
      { n: 3, category: 'reply', summary: 'implied reply', needs_reply: false, suggested: 'keep' },
      { n: 4, category: 'reply', summary: 'model disagrees', needs_reply: true, suggested: 'reply', confidence: 0.9 },
    ] }, [{ message: message('m1', 'a@example.com') }, { message: message('m2', 'b@example.com') }, { message: message('m3', 'c@example.com') }, { message: message('m4', 'd@example.com'), known: { category: 'newsletter', needsReply: false } }], 'now')
    expect(results).toHaveLength(4)
    expect(results[0]).toMatchObject({ messageId: 'm1', category: 'reply', summary: 'mom asks about dinner', needsReply: true, suggested: 'reply', confidence: 0.97, source: 'model', triagedAt: 'now' })
    expect(results[1]).toMatchObject({ messageId: 'm2', category: 'fyi', suggested: 'keep', confidence: 1 })
    expect(results[2]).toMatchObject({ messageId: 'm3', needsReply: true, confidence: 0.5 })
    expect(results[3]).toMatchObject({ messageId: 'm4', category: 'newsletter', needsReply: false, summary: 'model disagrees' })
    expect(parseResults(undefined, [], 'now')).toEqual([])
  })

  it('splits into batches and merges the verdicts', async () => {
    const messages = Array.from({ length: 25 }, (_, index) => message(`m${index}`, `p${index}@example.com`))
    expect(batches(messages).map((batch) => batch.length)).toEqual([12, 12, 1])
    const createMessage = vi.fn(async (request: MessagesRequest) => {
      const numbers = [...(request.messages[0].content as string).matchAll(/^### message (\d+)$/gm)].map((match) => Number(match[1]))
      return { id: 'r', stop_reason: 'tool_use', content: [{ type: 'tool_use' as const, id: 't', name: 'triage_messages', input: { results: numbers.map((n) => ({ n, category: 'fyi', summary: String(n), needs_reply: false, suggested: 'archive', confidence: 0.9 })) } }] }
    })
    const results = await triageMessages({ createMessage } as unknown as AnthropicClient, 'model', messages, context, () => 'now')
    expect(createMessage).toHaveBeenCalledTimes(3)
    expect(results.map((result) => result.messageId)).toEqual(messages.map((item) => item.id))
    expect(await readMessages({ createMessage } as unknown as AnthropicClient, 'model', [], context)).toEqual([])
  })

  it('drafts only on request, as plain text, with the instruction when there is one', async () => {
    const request = buildDraftRequest('claude-sonnet-5-5', message('m1', 'mom@example.com', 'Dinner?', { body: 'Sunday at 6?' }), { ...context, instruction: 'yes but 7' })
    expect(request.tools).toBeUndefined()
    expect(request.system).toContain('no signature')
    expect(request.messages[0].content).toContain('What I want to say: yes but 7')
    const createMessage = vi.fn(async () => ({ id: 'r', stop_reason: 'end_turn', content: [{ type: 'text' as const, text: ' 7 works. See you Sunday! ' }] }))
    expect(await draftReply({ createMessage } as unknown as AnthropicClient, 'claude-haiku-5-5', message('m1', 'mom@example.com'), context)).toBe('7 works. See you Sunday!')
  })
})
