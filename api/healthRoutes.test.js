import { describe, expect, it, vi } from 'vitest'
import claimBridgeHandler from './json-api/bridge'
import hmsHandler from './hms-api/handler'
import vercelConfig from '../vercel.json'

const createResponse = () => {
  const response = {
    body: null,
    headers: {},
    statusCode: 200,
    status: vi.fn((statusCode) => {
      response.statusCode = statusCode
      return response
    }),
    setHeader: vi.fn((name, value) => {
      response.headers[String(name).toLowerCase()] = value
    }),
    json: vi.fn((body) => {
      response.body = body
      return response
    }),
    end: vi.fn(),
  }
  return response
}

describe('production API health routes', () => {
  it.each([
    ['Claim Bridge', claimBridgeHandler, 'healthflow-vercel-claim-bridge'],
    ['HMS API', hmsHandler, 'healthflow-hms-api'],
  ])('returns JSON health for %s without credentials', async (_label, handler, mode) => {
    const request = {
      method: 'GET',
      query: { path: ['health'] },
      headers: { host: 'healthflowcloud.com' },
      url: '/health',
    }
    const response = createResponse()

    await handler(request, response)

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({ ok: true, mode })
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('keeps API and bridge paths out of the SPA fallback', () => {
    const fallback = vercelConfig.rewrites.at(-1)
    const matcher = new RegExp(`^${fallback.source}$`)

    expect(matcher.test('/reports')).toBe(true)
    expect(matcher.test('/api/json-api/health')).toBe(false)
    expect(matcher.test('/api/hms-api/health')).toBe(false)
    expect(matcher.test('/json-api/health')).toBe(false)
    expect(matcher.test('/hms-api/health')).toBe(false)
  })
})
