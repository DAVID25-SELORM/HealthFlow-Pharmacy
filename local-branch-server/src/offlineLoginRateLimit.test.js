import { describe, expect, it, vi } from 'vitest'
import { createOfflineLoginRateLimiter } from './offlineLoginRateLimit.js'

describe('offline login rate limiter', () => {
  it('audits every request rejected by the dedicated limiter', () => {
    const audit = vi.fn()
    const limiter = createOfflineLoginRateLimiter({
      windowMs: 300000,
      maxRequests: 2,
      auditRateLimited: audit,
      now: () => 1000,
    })
    const response = {
      setHeader: vi.fn(),
      status: vi.fn(() => response),
      json: vi.fn(() => response),
    }
    const request = {
      ip: '192.168.1.20',
      body: { email: 'staff@example.com' },
    }

    limiter(request, response, vi.fn())
    limiter(request, response, vi.fn())
    limiter(request, response, vi.fn())
    limiter(request, response, vi.fn())

    expect(response.status).toHaveBeenCalledTimes(2)
    expect(response.status).toHaveBeenCalledWith(429)
    expect(audit).toHaveBeenCalledTimes(2)
    expect(audit).toHaveBeenCalledWith({
      email: 'staff@example.com',
      ipAddress: '192.168.1.20',
    })
  })
})
