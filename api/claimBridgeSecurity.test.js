import { beforeEach, afterEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('CLAIMIT_UPSTREAM_BASE_URL', 'https://upstream.example/approved/api')
  vi.stubEnv('CLAIM_BRIDGE_TOKEN', 'test-bridge-token')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

const call = async (path, token = 'test-bridge-token') => {
  const { default: handler } = await import('./json-api/bridge.js')
  const response = {
    status: vi.fn(function (value) { this.statusCode = value; return this }),
    setHeader: vi.fn(), json: vi.fn(), send: vi.fn(), end: vi.fn(),
  }
  await handler({ method: 'GET', query: { path }, url: '/json-api/claims?limit=2', headers: { 'x-claim-bridge-token': token } }, response)
  return response
}

it.each([['..'], ['%2e%2e'], ['%252e%252e'], ['..\\admin'], ['%2fadmin'], ['x?secret'], ['%zz']])('blocks unsafe path %s before forwarding credentials', async (segment) => {
  const response = await call([segment, 'claims'])
  expect(response.statusCode).toBe(400)
  expect(fetch).not.toHaveBeenCalled()
})
it('preserves valid API paths and query parameters', async () => {
  expect((await call(['claims', 'ABC 123'])).statusCode).toBe(200)
  expect(String(fetch.mock.calls[0][0])).toBe('https://upstream.example/approved/api/claims/ABC%20123?limit=2')
})
it('rejects missing authentication before forwarding', async () => {
  expect((await call(['claims'], '')).statusCode).toBe(401)
  expect(fetch).not.toHaveBeenCalled()
})
