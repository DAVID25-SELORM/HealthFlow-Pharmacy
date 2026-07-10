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
})
