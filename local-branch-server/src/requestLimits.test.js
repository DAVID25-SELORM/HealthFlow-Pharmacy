import { describe, expect, it } from 'vitest'
import {
  BRANCH_JSON_BODY_LIMIT,
  getBranchRequestErrorResponse,
} from './requestLimits.js'

describe('branch request limits', () => {
  it('provides transport headroom for a 3 MB Base64 attachment and claim metadata', () => {
    expect(BRANCH_JSON_BODY_LIMIT).toBe('10mb')
  })

  it('returns actionable JSON for oversized requests', () => {
    expect(getBranchRequestErrorResponse({
      status: 413,
      type: 'entity.too.large',
    })).toEqual({
      status: 413,
      body: {
        error: 'The request is too large for the local branch server. Prescription attachments must be 3 MB or smaller.',
        code: 'REQUEST_TOO_LARGE',
      },
    })
  })

  it('returns actionable messages for validation and integration errors', () => {
    expect(getBranchRequestErrorResponse({
      status: 400,
      message: 'CLAIM-it local bridge is not reachable at http://localhost:31719/json-api.',
    })).toEqual({
      status: 400,
      body: {
        error: 'CLAIM-it local bridge is not reachable at http://localhost:31719/json-api.',
      },
    })
  })

  it('preserves the generic response for unrelated server errors', () => {
    expect(getBranchRequestErrorResponse({ status: 500 })).toEqual({
      status: 500,
      body: {
        error: 'Request failed.',
      },
    })
  })
})
