import { describe, expect, it } from 'vitest'
import { relay } from './worker.js'

const site = 'https://chase-grey.github.io'
const ask = (init = {}, url = 'https://relay.example/') => new Request(url, { method: 'POST', headers: { origin: site, authorization: 'Bearer k', 'content-type': 'application/json' }, body: '{"state":{}}', ...init })
const never = () => { throw new Error('reached typesafe') }

describe('jev relay', () => {
  it('passes a post from the site to typesafe with the page\'s key and hands the answer back', async () => {
    const calls = []
    const response = await relay(ask(), async (url, init) => { calls.push({ url, init }); return new Response('{"answers":{}}', { status: 200, headers: { 'content-type': 'application/json' } }) })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(calls[0].init.headers.authorization).toBe('Bearer k')
    expect(calls[0].init.body).toBe('{"state":{}}')
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(site)
    expect(await response.text()).toBe('{"answers":{}}')
  })

  it('hands back typesafe\'s refusal as it came', async () => {
    const response = await relay(ask(), async () => new Response('{"detail":"bad key"}', { status: 403, headers: { 'content-type': 'application/json' } }))
    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBe(site)
  })

  it('answers the browser\'s preflight for the site', async () => {
    const response = await relay(new Request('https://relay.example/', { method: 'OPTIONS', headers: { origin: site } }), never)
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization')
  })

  it('turns away every other page, and a caller that names none', async () => {
    expect((await relay(ask({ headers: { origin: 'https://elsewhere.example', authorization: 'Bearer k' } }), never)).status).toBe(403)
    expect((await relay(ask({ headers: { authorization: 'Bearer k' } }), never)).status).toBe(403)
  })

  it('does nothing but the one job', async () => {
    expect((await relay(new Request('https://relay.example/', { headers: { origin: site } }), never)).status).toBe(405)
    expect((await relay(ask({}, 'https://relay.example/other'), never)).status).toBe(404)
    expect((await relay(ask({ headers: { origin: site } }), never)).status).toBe(401)
    expect((await relay(ask({ body: 'x'.repeat(200_001) }), never)).status).toBe(413)
  })
})
