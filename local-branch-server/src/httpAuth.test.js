import { describe, expect, it, vi } from 'vitest'
import {
  BRANCH_AUTH_COOKIE,
  requireBranchToken,
  requireBranchUserSession,
} from './httpAuth.js'
import { config } from './config.js'

const makeResponse = () => {
  const response = {
    status: vi.fn(() => response),
    json: vi.fn(() => response),
  }
  return response
}

describe('branch HTTP authentication', () => {
  it('accepts the HttpOnly session cookie used by the bundled local app', () => {
    const originalToken = config.branchServerToken
    config.branchServerToken = 'test-branch-token-with-enough-entropy'
    const request = {
      get: vi.fn((name) => name === 'Cookie'
        ? `${BRANCH_AUTH_COOKIE}=${encodeURIComponent(config.branchServerToken)}`
        : ''),
    }
    const response = makeResponse()
    const next = vi.fn()

    try {
      requireBranchToken(request, response, next)
      expect(next).toHaveBeenCalledOnce()
      expect(response.status).not.toHaveBeenCalled()
    } finally {
      config.branchServerToken = originalToken
    }
  })

  it('rejects requests without a valid header or cookie token', () => {
    const request = { get: vi.fn(() => '') }
    const response = makeResponse()

    requireBranchToken(request, response, vi.fn())

    expect(response.status).toHaveBeenCalledWith(401)
  })

  it('rejects a browser-supplied role when no signed staff session exists', () => {
    const request = {
      body: {
        role: 'admin',
        canDeleteNhisClaims: true,
      },
      get: vi.fn(() => ''),
    }
    const response = makeResponse()
    const next = vi.fn()

    requireBranchUserSession(request, response, next)

    expect(response.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})
