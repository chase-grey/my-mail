import { describe, expect, it, vi } from 'vitest'
import { message } from '../domain/fixtures'
import { JevClient, JevError, classifyWithJev, jevState, kindOf, mailQuestions, triageFromAnswers } from './jev'

const answer = (choice: string, probability: number, extra: Record<string, number> = {}) => ({ type: 'choice' as const, choice, probabilities: { [choice]: probability, ...extra } })

describe('jev', () => {
  it('sends the state and the three mail questions with the key, and returns the answers', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ answers: { kind: answer('promo', 0.91) }, private: 'x' }), { status: 200 }))
    const client = new JevClient('key', fetcher as unknown as typeof fetch)
    const answers = await client.ask(jevState(message('m1', 'deals@shop.example.com', 'Sale', { body: '20% off' })), mailQuestions)
    expect(answers.kind.choice).toBe('promo')
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer key')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('jev-latest')
    expect(Object.keys(body.questions)).toEqual(['kind', 'needs_reply', 'person'])
    expect(body.state).toMatchObject({ subject: 'Sale', body: '20% off' })
    expect(Object.keys(body.questions.kind.criteria)).toHaveLength(9)
  })

  it('turns answers into a verdict whose confidence is jev probability for the chosen kind', () => {
    const promo = triageFromAnswers(message('m1', 'a@example.com'), { kind: answer('promo', 0.88), needs_reply: answer('NO', 0.97, { YES: 0.03 }) }, 'now')
    expect(promo).toMatchObject({ category: 'promo', needsReply: false, suggested: 'archive', confidence: 0.88, source: 'jev', summary: '' })
    const reply = triageFromAnswers(message('m2', 'mom@example.com'), { kind: answer('fyi', 0.5), needs_reply: answer('YES', 0.8, { NO: 0.2 }) }, 'now')
    expect(reply).toMatchObject({ category: 'fyi', needsReply: true, suggested: 'reply' })
    expect(triageFromAnswers(message('m3', 'a@example.com'), { kind: answer('action', 0.7) }, 'now')).toMatchObject({ suggested: 'task' })
    expect(triageFromAnswers(message('m4', 'a@example.com'), { kind: answer('nonsense', 0.7) }, 'now')).toBeUndefined()
    expect(triageFromAnswers(message('m5', 'a@example.com'), {}, 'now')).toBeUndefined()
  })

  it('classifies many messages a few at a time and surfaces http failures', async () => {
    const ask = vi.fn(async (state: Record<string, unknown>) => ({ kind: answer(String(state.subject) === 'hi' ? 'reply' : 'newsletter', 0.9), needs_reply: answer('NO', 0.9) }))
    const results = await classifyWithJev({ ask } as unknown as JevClient, [message('m1', 'a@example.com', 'hi'), message('m2', 'b@example.com', 'news'), message('m3', 'c@example.com', 'news')], () => '', () => 'now')
    expect(ask).toHaveBeenCalledTimes(3)
    expect(results.find((result) => result.messageId === 'm1')).toMatchObject({ category: 'reply', needsReply: true })
    expect(results.filter((result) => result.category === 'newsletter')).toHaveLength(2)
    const failing = new JevClient('key', (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch)
    await expect(failing.ask({}, mailQuestions)).rejects.toBeInstanceOf(JevError)
  })

  it('answers the one kind question for a cleanup sample', async () => {
    const ask = vi.fn(async () => ({ kind: answer('newsletter', 0.77) }))
    expect(await kindOf({ ask } as unknown as JevClient, { from: { name: 'Daily', address: 'news@daily.example.com' }, subject: 'Digest', preview: 'Top stories' })).toEqual({ category: 'newsletter', confidence: 0.77 })
    expect(Object.keys((ask.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1])).toEqual(['kind'])
  })
})
