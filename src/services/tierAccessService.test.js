import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStoredActiveRole: vi.fn(() => 'admin'),
  invokeSupabaseFunction: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  invokeSupabaseFunction: mocks.invokeSupabaseFunction,
}))

vi.mock('../utils/activeRole', () => ({
  getStoredActiveRole: mocks.getStoredActiveRole,
}))

import { invokeTierAccess } from './tierAccessService'
import { getProductionMetricsSnapshot, resetProductionMetrics } from './productionMetricsService'

describe('invokeTierAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    resetProductionMetrics()
    mocks.getStoredActiveRole.mockReturnValue('admin')
  })

  it('deduplicates concurrent read-only requests with the same payload', async () => {
    let resolveRequest
    mocks.invokeSupabaseFunction.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      })
    )

    const first = invokeTierAccess({ action: 'get_claims_statistics' })
    const second = invokeTierAccess({ action: 'get_claims_statistics' })

    resolveRequest({ data: { total: 5 }, error: null })

    await expect(first).resolves.toEqual({ total: 5 })
    await expect(second).resolves.toEqual({ total: 5 })
    expect(mocks.invokeSupabaseFunction).toHaveBeenCalledTimes(1)
    expect(mocks.invokeSupabaseFunction).toHaveBeenCalledWith('tier-access', {
      body: { action: 'get_claims_statistics', activeRole: 'admin' },
    })
    const metrics = getProductionMetricsSnapshot()
    expect(metrics.concurrentRequests).toBe(0)
    expect(metrics.tierAccess.find((item) => item.action === 'get_claims_statistics')).toMatchObject({
      count: 1,
      failures: 0,
    })
    expect(metrics.cache.find((item) => item.name === 'tier-access in-flight')).toMatchObject({
      hits: 1,
      misses: 1,
    })
  })

  it('does not deduplicate write requests', async () => {
    mocks.invokeSupabaseFunction.mockResolvedValue({ data: { ok: true }, error: null })

    await Promise.all([
      invokeTierAccess({ action: 'save_nhia_api_settings' }),
      invokeTierAccess({ action: 'save_nhia_api_settings' }),
    ])

    expect(mocks.invokeSupabaseFunction).toHaveBeenCalledTimes(2)
  })

  it('retries an idempotent read after a temporary 503', async () => {
    vi.useFakeTimers()
    mocks.invokeSupabaseFunction
      .mockResolvedValueOnce({ data: null, error: { status: 503, message: 'Service unavailable' } })
      .mockResolvedValueOnce({ data: { total: 7 }, error: null })

    const request = invokeTierAccess({ action: 'get_claims_statistics' })
    await vi.advanceTimersByTimeAsync(500)

    await expect(request).resolves.toEqual({ total: 7 })
    expect(mocks.invokeSupabaseFunction).toHaveBeenCalledTimes(2)
  })

  it('does not retry a write after a temporary 503', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.invokeSupabaseFunction.mockResolvedValue({
      data: null,
      error: { status: 503, message: 'Service unavailable' },
    })

    await expect(invokeTierAccess({ action: 'save_nhia_api_settings' })).rejects.toMatchObject({ status: 503 })
    expect(mocks.invokeSupabaseFunction).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it('retries an idempotent check after a temporary network failure', async () => {
    vi.useFakeTimers()
    mocks.invokeSupabaseFunction
      .mockResolvedValueOnce({ data: null, error: new TypeError('Failed to fetch') })
      .mockResolvedValueOnce({ data: { ready: true }, error: null })

    const request = invokeTierAccess({ action: 'check_organization_readiness' })
    await vi.advanceTimersByTimeAsync(500)

    await expect(request).resolves.toEqual({ ready: true })
    expect(mocks.invokeSupabaseFunction).toHaveBeenCalledTimes(2)
  })
})
