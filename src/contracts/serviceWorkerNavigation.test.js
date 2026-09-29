// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

const source = readFileSync('public/service-worker.js', 'utf8')
const navigate = async (response, cached, cacheFailure = false) => {
  const handlers = {}
  const put = vi.fn().mockImplementation(async () => { if (cacheFailure) throw new Error('Cache unavailable') })
  runInNewContext(source, {
    self: { location: { origin: 'https://healthflowcloud.com' }, addEventListener: (name, handler) => { handlers[name] = handler } },
    URL, Response,
    fetch: async () => response,
    caches: { open: async () => ({ put }), match: async () => cached },
  })
  let result
  handlers.fetch({ request: { url: 'https://healthflowcloud.com/nhis', method: 'GET', mode: 'navigate' }, respondWith: (value) => { result = value } })
  return { response: await result, put }
}

it('serves the cached shell during a server outage without caching the error page', async () => {
  const cached = new Response('<html>App</html>', { headers: { 'Content-Type': 'text/html' } })
  const result = await navigate(new Response('Unavailable', { status: 503 }), cached)
  expect(result.response).toBe(cached)
  expect(result.put).not.toHaveBeenCalled()
})

it('preserves the server error when there is no usable cached shell', async () => {
  const unavailable = new Response('Unavailable', { status: 503 })
  const result = await navigate(unavailable, new Response('Old error', { status: 503 }))
  expect(result.response).toBe(unavailable)
  expect(result.put).not.toHaveBeenCalled()
})

it('returns a successful navigation even when writing the cache fails', async () => {
  const response = new Response('<html>App</html>', { headers: { 'Content-Type': 'text/html' } })
  const result = await navigate(response, undefined, true)
  expect(result.response).toBe(response)
  expect(result.put).toHaveBeenCalledOnce()
})
