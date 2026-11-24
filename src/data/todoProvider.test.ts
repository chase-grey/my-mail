import { describe, expect, it, vi } from 'vitest'
import { message } from '../domain/fixtures'
import { GraphClient, GraphError } from './graphClient'
import { TodoProvider } from './todoProvider'

const lists = () => new Response(JSON.stringify({ value: [{ id: 'other', displayName: 'groceries' }, { id: 'tasks', displayName: 'Tasks', wellknownListName: 'defaultList' }] }), { status: 200 })
const refused = () => new Response(JSON.stringify({ error: { code: 'invalidRequest', message: 'Invalid request' } }), { status: 400 })
const created = () => new Response(JSON.stringify({ id: 'task1' }), { status: 201 })

function provider(...responses: Array<() => Response>) {
  const fetcher = vi.fn(async () => responses.shift()!())
  const todo = new TodoProvider(new GraphClient(async () => 'token', fetcher as unknown as typeof fetch, 'https://graph.example'))
  const sent = (call: number) => JSON.parse((fetcher.mock.calls[call] as unknown as [string, RequestInit])[1].body as string)
  return { todo, fetcher, sent }
}

describe('todo provider', () => {
  it('adds the task to the default list with a link back to the mail', async () => {
    const { todo, fetcher, sent } = provider(lists, created)
    await expect(todo.createTask({ title: 'call back', message: message('a', 'mom@example.com') })).resolves.toEqual({ id: 'task1' })
    expect((fetcher.mock.calls[1] as unknown as [string])[0]).toBe('https://graph.example/me/todo/lists/tasks/tasks')
    expect(sent(1)).toMatchObject({ title: 'call back', linkedResources: [{ applicationName: 'my-mail' }] })
  })

  it('still makes the task when graph refuses the link', async () => {
    const { todo, fetcher, sent } = provider(lists, refused, created)
    await expect(todo.createTask({ title: 'x'.repeat(400), message: message('a', 'mom@example.com') })).resolves.toEqual({ id: 'task1' })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(sent(2).linkedResources).toBeUndefined()
    expect(sent(2).title).toHaveLength(255)
  })

  it('says why graph refused when the plain task fails too', async () => {
    const { todo } = provider(lists, refused, refused)
    const failure = await todo.createTask({ title: 'call back', message: message('a', 'mom@example.com') }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GraphError)
    expect((failure as GraphError).message).toBe('microsoft graph returned 400: Invalid request')
  })
})
