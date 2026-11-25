// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  requireBranchAccess,
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
  it('accepts the server key sent by its own scripts', () => {
    const originalToken = config.branchServerToken
    config.branchServerToken = 'test-branch-token-with-enough-entropy'
    const request = { get: vi.fn((name) => name === 'x-branch-token' ? config.branchServerToken : '') }
    const response = makeResponse()
    const next = vi.fn()

    try {
      requireBranchAccess(request, response, next)
      expect(next).toHaveBeenCalledOnce()
      expect(response.status).not.toHaveBeenCalled()
    } finally {
      config.branchServerToken = originalToken
    }
  })

  it('does not accept the server key from a cookie, which the server no longer hands out', () => {
    const originalToken = config.branchServerToken
    config.branchServerToken = 'test-branch-token-with-enough-entropy'
    const request = {
      get: vi.fn((name) => name === 'Cookie'
        ? `healthflow_branch_session=${config.branchServerToken}`
        : ''),
    }
    const response = makeResponse()
    const next = vi.fn()

    try {
      requireBranchAccess(request, response, next)
      expect(next).not.toHaveBeenCalled()
      expect(response.status).toHaveBeenCalledWith(401)
    } finally {
      config.branchServerToken = originalToken
    }
  })

  it('rejects a request with no key and no registered computer', () => {
    const request = { get: vi.fn(() => '') }
    const response = makeResponse()

    requireBranchAccess(request, response, vi.fn())

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
