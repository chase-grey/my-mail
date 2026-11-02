import type { Message } from '../domain/types'
import type { GraphClient } from './graphClient'

type GraphTaskList = { id: string; displayName: string; wellknownListName?: string }

export type NewTask = { title: string; note?: string; message: Message }

/** Tasks go to the default Microsoft To Do list, where My Brain picks them up as "new to sort". */
export class TodoProvider {
  private listId?: string

  constructor(private readonly graph: GraphClient) {}

  async defaultListId(): Promise<string> {
    if (this.listId) return this.listId
    const lists = await this.graph.collection<GraphTaskList>('/me/todo/lists?$select=id,displayName,wellknownListName')
    const list = lists.find((candidate) => candidate.wellknownListName === 'defaultList') ?? lists[0]
    if (!list) throw new Error('microsoft to do has no task list')
    this.listId = list.id
    return list.id
  }

  async createTask(input: NewTask): Promise<{ id: string }> {
    const listId = await this.defaultListId()
    const body = [input.note, `from ${input.message.from.name} <${input.message.from.address}>`, input.message.webLink].filter(Boolean).join('\n\n')
    return await this.graph.request<{ id: string }>(`/me/todo/lists/${encodeURIComponent(listId)}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        body: { content: body, contentType: 'text' },
        linkedResources: [{ webUrl: input.message.webLink, applicationName: 'my-mail', displayName: input.message.subject }],
      }),
    })
  }
}
