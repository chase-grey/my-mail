import type { SearchPage } from '../domain/search'
import type { GraphClient } from './graphClient'
import { fromGraph, messageSelect } from './mailProvider'

type GraphHit = Parameters<typeof fromGraph>[0] & { parentFolderId?: string }
type GraphFolder = { id: string; displayName: string }
type Folders = { inbox: string; names: Map<string, string> }

export const searchSelect = `${messageSelect},parentFolderId`
export const searchPageSize = 25

/** Graph takes the whole search, operators and all, inside one pair of double quotes. */
export function searchParam(query: string): string {
  return `"${query.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Search across the whole mailbox, with the folder each message sits in. */
export class MailSearch {
  private folderIndex?: Promise<Folders>

  constructor(private readonly graph: GraphClient) {}

  /**
   * Mail in every folder that matches the words or KQL given.
   * Graph does not allow a sort or a filter beside a search, so the order is its own: newest first.
   */
  search(query: string, count = searchPageSize): Promise<SearchPage> {
    return this.page(`/me/messages?${new URLSearchParams({ '$search': searchParam(query), '$top': String(count), '$select': searchSelect })}`)
  }

  /** The page after the one `search` returned. */
  more(next: string): Promise<SearchPage> {
    return this.page(next)
  }

  private async page(path: string): Promise<SearchPage> {
    const [page, folders] = await Promise.all([this.graph.request<{ value: GraphHit[]; '@odata.nextLink'?: string }>(path), this.folders()])
    const hits = page.value.map((message) => {
      const inInbox = message.parentFolderId === folders.inbox
      return { message: fromGraph(message), inInbox, folder: inInbox ? undefined : folders.names.get(message.parentFolderId ?? '') }
    })
    return { hits, next: page['@odata.nextLink'] }
  }

  /** Top-level folder names by id, read once. A message in a nested folder shows no folder name. */
  private folders(): Promise<Folders> {
    this.folderIndex ??= Promise.all([
      this.graph.request<GraphFolder>('/me/mailFolders/inbox?$select=id'),
      this.graph.request<{ value: GraphFolder[] }>('/me/mailFolders?$top=100&$select=id,displayName'),
    ]).then(([inbox, all]) => ({ inbox: inbox.id, names: new Map(all.value.map((folder) => [folder.id, folder.displayName])) }))
      .catch((error: unknown) => { this.folderIndex = undefined; throw error })
    return this.folderIndex
  }
}
