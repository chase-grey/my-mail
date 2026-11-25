export type AccessTokenProvider = () => Promise<string>

type GraphCollection<T> = {
  value: T[]
  '@odata.nextLink'?: string
}

export class GraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    const reason = graphReason(responseBody)
    super(reason ? `microsoft graph returned ${status}: ${reason}` : `microsoft graph returned ${status}`)
    this.name = 'GraphError'
  }
}

/** Graph says why in `error.message`; without it a 400 cannot be told apart from any other. */
function graphReason(responseBody: string): string | undefined {
  try {
    const message = (JSON.parse(responseBody) as { error?: { message?: unknown } }).error?.message
    return typeof message === 'string' && message.trim() ? message.trim().slice(0, 200) : undefined
  } catch {
    return undefined
  }
}

export class GraphClient {
  constructor(
    private readonly getAccessToken: AccessTokenProvider,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private readonly baseUrl = 'https://graph.microsoft.com/v1.0',
    /** Sent with every request. Mail uses it to ask for ids that survive folder moves. */
    private readonly defaultHeaders: Record<string, string> = {},
  ) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.response(path, init)
    // A send or a delete is answered with no body at all, under more than one status.
    const text = await response.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  async requestText(path: string, init: RequestInit = {}): Promise<string> {
    const response = await this.response(path, init)
    return await response.text()
  }

  private async response(path: string, init: RequestInit): Promise<Response> {
    const url = this.url(path)
    const token = await this.getAccessToken()
    const headers = new Headers(init.headers)
    for (const [name, value] of Object.entries(this.defaultHeaders)) if (!headers.has(name)) headers.set(name, value)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

    const response = await this.fetcher(url, { ...init, headers })
    if (!response.ok) throw new GraphError(response.status, await response.text())
    return response
  }

  async collection<T>(path: string, init: RequestInit = {}): Promise<T[]> {
    const values: T[] = []
    let next: string | undefined = path
    while (next) {
      const page: GraphCollection<T> = await this.request(next, init)
      values.push(...page.value)
      next = page['@odata.nextLink']
    }
    return values
  }

  /**
   * Where a request goes. Every request carries the sign-in token, so a whole address (a next page link Graph handed back)
   * is followed only when it is Graph's own; anything else is refused before the token is fetched.
   */
  private url(path: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
      if (!path.startsWith(`${new URL(this.baseUrl).origin}/`)) throw new Error('refused to send the microsoft sign-in to another address')
      return path
    }
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }
}
