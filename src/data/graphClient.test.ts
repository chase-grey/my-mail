import { describe, expect, it, vi } from 'vitest'
import { GraphClient } from './graphClient'

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const graphs = 'https://graph.microsoft.com/v1.0'

describe('where the sign-in token is sent', () => {
  it('sends paths and graph\'s own next page links with the token', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => answer({ value: [] }))
    const graph = new GraphClient(async () => 'token', fetcher as unknown as typeof fetch)
    await graph.request('/me/todo/lists')
    await graph.request(`${graphs}/me/todo/lists?$skip=50`)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${graphs}/me/todo/lists`, `${graphs}/me/todo/lists?$skip=50`])
    expect(new Headers(fetcher.mock.calls[1][1]!.headers).get('Authorization')).toBe('Bearer token')
  })

  it('refuses any other address before the token is even fetched', async () => {
    const fetcher = vi.fn(async () => answer({}))
    const token = vi.fn(async () => 'token')
    const graph = new GraphClient(token, fetcher as unknown as typeof fetch)
    const elsewhere = [
      'https://evil.example/v1.0/me',
      'https://graph.microsoft.com.evil.example/v1.0/me',
      'https://graph.microsoft.com@evil.example/v1.0/me',
      'https://graph.microsoft.com:8443/v1.0/me',
      'http://graph.microsoft.com/v1.0/me',
      'HTTPS://evil.example/',
      '//evil.example/v1.0/me',
    ]
    for (const url of elsewhere) {
      await expect(graph.request(url)).rejects.toThrow(/refused/)
      await expect(graph.requestText(url)).rejects.toThrow(/refused/)
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(token).not.toHaveBeenCalled()
  })

  it('stops following pages when a next link points somewhere else', async () => {
    const fetcher = vi.fn(async (_url: string) => answer({ value: [1], '@odata.nextLink': 'https://evil.example/next' }))
    const graph = new GraphClient(async () => 'token', fetcher as unknown as typeof fetch)
    await expect(graph.collection('/me/todo/lists')).rejects.toThrow(/refused/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
