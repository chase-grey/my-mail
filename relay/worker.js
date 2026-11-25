// A relay so the site can reach TypeSafe Jev, which refuses calls made from a web page.
// It holds no key: the page sends its own, and this passes one kind of request to one address.
// It keeps nothing and logs nothing.

const upstream = 'https://api.typesafe.ai/v1/systemone'
const allowedOrigins = new Set(['https://chase-grey.github.io', 'http://localhost:5174'])
const maxBodyLength = 200_000

const plain = (status, text, headers = {}) => new Response(text, { status, headers })

export async function relay(request, send = fetch) {
  const origin = request.headers.get('origin') ?? ''
  if (!allowedOrigins.has(origin)) return plain(403, 'not allowed')
  const cors = { 'access-control-allow-origin': origin, vary: 'origin' }
  if (new URL(request.url).pathname !== '/') return plain(404, 'not found', cors)

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '86400' },
    })
  }
  if (request.method !== 'POST') return plain(405, 'post only', cors)

  const authorization = request.headers.get('authorization')
  if (!authorization) return plain(401, 'no key', cors)
  const body = await request.text()
  if (body.length > maxBodyLength) return plain(413, 'too large', cors)

  const answer = await send(upstream, { method: 'POST', headers: { 'content-type': 'application/json', authorization }, body })
  return new Response(answer.body, { status: answer.status, headers: { ...cors, 'content-type': answer.headers.get('content-type') ?? 'application/json' } })
}

export default { fetch: (request) => relay(request) }
