import type { Message } from '../domain/types'
import { GraphError, type GraphClient } from './graphClient'

type GraphTaskList = { id: string; displayName: string; wellknownListName?: string }

/** To Do refuses a longer title. */
const titleLimit = 255

export type NewTask = { title: string; note?: string; message: Message }

/** Tasks go to the default Microsoft To Do list, where My Brain picks them up as "new to sort". */
export class TodoProvider {
  private listId?: string

  constructor(private readonly graph: GraphClient) {}

  async defaultListId(): Promise<string> {
    if (this.listId) return this.listId
    const lists = await this.graph.collection<GraphTaskList>('/me/todo/lists')
    const list = lists.find((candidate) => candidate.wellknownListName === 'defaultList') ?? lists[0]
    if (!list) throw new Error('microsoft to do has no task list')
    this.listId = list.id
    return list.id
  }

  async createTask(input: NewTask): Promise<{ id: string }> {
    const listId = await this.defaultListId()
    const body = [input.note, `from ${input.message.from.name} <${input.message.from.address}>`, input.message.webLink].filter(Boolean).join('\n\n')
    const task = { title: input.title.slice(0, titleLimit), body: { content: body, contentType: 'text' } }
    const linked = input.message.webLink
      ? { ...task, linkedResources: [{ webUrl: input.message.webLink, applicationName: 'my-mail', displayName: input.message.subject.slice(0, titleLimit) }] }
      : task
    const post = (payload: object) => this.graph.request<{ id: string }>(`/me/todo/lists/${encodeURIComponent(listId)}/tasks`, { method: 'POST', body: JSON.stringify(payload) })
    try {
      return await post(linked)
    } catch (failure) {
      // The link back to the mail is also in the note, so a task Graph refuses with it is still worth making without.
      if (linked === task || !(failure instanceof GraphError) || failure.status !== 400) throw failure
      return await post(task)
    }
  }
}
