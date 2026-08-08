import { describe, expect, it, vi } from 'vitest'
import { getRequestFailureDetails, logRequestFailure } from './requestDiagnostics'

describe('requestDiagnostics', () => {
  it('captures operational request context and redacts sensitive response fields', () => {
    const details = getRequestFailureDetails({
      status: 503,
      code: 'WORKER_RESOURCE_LIMIT',
      message: 'Service unavailable',
      body: {
        action: 'get_report_health',
        patientName: 'Sensitive Patient',
        nested: { apiKey: 'secret-value', reason: 'capacity' },
      },
      context: {
        status: 503,
        headers: { get: (name) => name === 'x-request-id' ? 'request-123' : null },
      },
    }, {
      endpoint: '/functions/v1/tier-access',
      method: 'POST',
      organizationId: 'org-1',
      branchId: 'branch-1',
      durationMs: 123.7,
    })

    expect(details).toMatchObject({
      endpoint: '/functions/v1/tier-access',
      method: 'POST',
      status: 503,
      code: 'WORKER_RESOURCE_LIMIT',
      requestId: 'request-123',
      organizationId: 'org-1',
      branchId: 'branch-1',
      durationMs: 124,
    })
    expect(details.response.patientName).toBe('[REDACTED]')
    expect(details.response.nested.apiKey).toBe('[REDACTED]')
    expect(details.response.nested.reason).toBe('capacity')
  })

  it('logs only the sanitized diagnostic object', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const details = logRequestFailure('edge-function:tier-access', {
      message: 'Failed to fetch',
      body: { token: 'private-token' },
    })

    expect(details.response.token).toBe('[REDACTED]')
    expect(errorSpy).toHaveBeenCalledWith(
      '[HealthFlow request] edge-function:tier-access',
      expect.objectContaining({ response: { token: '[REDACTED]' } })
    )
    errorSpy.mockRestore()
  })
})
