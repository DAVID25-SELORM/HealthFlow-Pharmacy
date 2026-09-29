// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync('public/service-worker.js', 'utf8')
const shell = () => new Response('<html>HealthFlow</html>', { headers: { 'Content-Type': 'text/html' } })
const navigate = async (networkResult, cached) => {
  const listeners = {}
  const put = vi.fn()
  let result
  const pending = []
  runInNewContext(source, {
    self: { location: { origin: 'https://healthflowcloud.com' }, addEventListener: (name, fn) => { listeners[name] = fn } },
    fetch: typeof networkResult === 'function' ? networkResult : async () => networkResult,
    caches: { match: async () => cached, open: async () => ({ put }) },
    Response, URL, Set,
  })
  listeners.fetch({
    request: { method: 'GET', mode: 'navigate', url: 'https://healthflowcloud.com/nhis' },
    respondWith: (promise) => { result = promise },
    waitUntil: (promise) => { pending.push(promise) },
  })
  const response = await result
  await Promise.all(pending)
  return { response, put }
}

describe('navigation outage recovery', () => {
  it('serves the healthy cached shell on a 503 without caching the error page', async () => {
    const { response, put } = await navigate(new Response('Unavailable', { status: 503 }), shell())
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('HealthFlow')
    expect(put).not.toHaveBeenCalled()
  })
  it('preserves a 503 if no healthy cached shell exists', async () => {
    const { response, put } = await navigate(new Response('Unavailable', { status: 503 }), new Response('old outage', { status: 503 }))
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('Unavailable')
    expect(put).not.toHaveBeenCalled()
  })
  it('updates the shell only with a successful HTML response', async () => {
    const { response, put } = await navigate(shell())
    expect(response.ok).toBe(true)
    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0][0]).toBe('/index.html')
  })
  it('does not replace the shell with a non-HTML response', async () => {
    const { put } = await navigate(new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
    expect(put).not.toHaveBeenCalled()
  })
  it('uses the healthy shell on a network failure', async () => {
    const { response } = await navigate(async () => { throw new TypeError('Failed to fetch') }, shell())
    expect(response.status).toBe(200)
  })
})
