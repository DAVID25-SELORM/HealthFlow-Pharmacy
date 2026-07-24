import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  evaluateProductionMetricAlerts,
  getProductionMetricsHistory,
  recordCacheEvent,
  recordProductionMetricsSample,
  recordTierAccessEnd,
  resetProductionMetrics,
} from './productionMetricsService'

describe('productionMetricsService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T08:00:00Z'))
    resetProductionMetrics()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps rolling trend history samples', () => {
    recordTierAccessEnd({ action: 'get_report_health', durationMs: 1200, success: true })
    recordProductionMetricsSample({ force: true })

    vi.setSystemTime(new Date('2026-07-10T08:01:00Z'))
    recordTierAccessEnd({ action: 'get_report_health', durationMs: 1800, success: true })
    recordProductionMetricsSample({ force: true })

    const history = getProductionMetricsHistory()
    expect(history.samples).toHaveLength(2)
    expect(history.windows.find((window) => window.label === '24 hours')).toMatchObject({
      sampleCount: 2,
      averageApiLatencyMs: 1350,
    })
  })

  it('raises a latency alert after five high-latency minute samples', () => {
    for (let index = 0; index < 5; index += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 6, 10, 8, index, 0)))
      recordTierAccessEnd({ action: 'get_report_health', durationMs: 6000, success: true })
      recordProductionMetricsSample({ force: true })
    }

    expect(evaluateProductionMetricAlerts()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'latency-5-minutes',
      }),
    ]))
  })

  it('does not raise cache hit alerts until low cache performance is sustained', () => {
    for (let index = 0; index < 49; index += 1) {
      recordCacheEvent('tier-access in-flight', 'miss')
    }

    for (let index = 0; index < 5; index += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 6, 10, 8, index, 0)))
      recordProductionMetricsSample({ force: true })
    }

    expect(evaluateProductionMetricAlerts()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cache-hit-rate' }),
    ]))

    recordCacheEvent('tier-access in-flight', 'miss')
    vi.setSystemTime(new Date('2026-07-10T08:05:00Z'))
    recordProductionMetricsSample({ force: true })

    expect(evaluateProductionMetricAlerts()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'cache-hit-rate',
        severity: 'info',
      }),
    ]))
  })
})
