import { GraphError, type GraphClient } from './graphClient'

function itemPath(path: string): string {
  const clean = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  if (!clean) throw new Error('path cannot be empty')
  return `/me/drive/special/approot:/${clean}:/content`
}

/** JSON files in the OneDrive app folder shared with My Brain. my-mail keeps its files under mail/. */
export class AppFolder {
  constructor(private readonly graph: GraphClient) {}

  async readJson<T>(path: string): Promise<T | undefined> {
    try {
      const text = await this.graph.requestText(itemPath(path), { headers: { Accept: 'application/json' } })
      return JSON.parse(text) as T
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return undefined
      throw error
    }
  }

  /** A 409 means another write to the same file (the other device, another tab) was in flight; it is tried again. */
  async writeJson(path: string, value: unknown, retryDelayMs = 600): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.graph.request(itemPath(path), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: `${JSON.stringify(value, null, 2)}\n`,
        })
        return
      } catch (error) {
        if (!(error instanceof GraphError && error.status === 409) || attempt >= 2) throw error
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)))
      }
    }
  }
}
