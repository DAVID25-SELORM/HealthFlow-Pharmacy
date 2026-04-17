import { describe, expect, it } from 'vitest'
import { normalizeSubscriptionTier, resolveTierAccess } from './subscription'

describe('subscription tier helpers', () => {
  it('normalizes tier aliases consistently', () => {
    expect(normalizeSubscriptionTier('professional')).toBe('pro')
    expect(normalizeSubscriptionTier('standard')).toBe('pro')
    expect(normalizeSubscriptionTier('free')).toBe('basic')
    expect(normalizeSubscriptionTier('enterprise')).toBe('enterprise')
  })

  it('grants professional trial access to non-enterprise trial tenants', () => {
    const result = resolveTierAccess(
      {
        status: 'trial',
        subscription_tier: 'basic',
        trial_ends_at: '2026-05-01T00:00:00.000Z',
        subscription_ends_at: null,
      },
      new Date('2026-04-17T00:00:00.000Z')
    )

    expect(result.isTrialActive).toBe(true)
    expect(result.effectiveTier).toBe('pro')
    expect(result.tierLimits.hasReports).toBe(true)
    expect(result.tierLimits.hasClaims).toBe(false)
  })

  it('preserves enterprise access during an active trial', () => {
    const result = resolveTierAccess(
      {
        status: 'trial',
        subscription_tier: 'enterprise',
        trial_ends_at: '2026-05-01T00:00:00.000Z',
        subscription_ends_at: null,
      },
      new Date('2026-04-17T00:00:00.000Z')
    )

    expect(result.isTrialActive).toBe(true)
    expect(result.effectiveTier).toBe('enterprise')
    expect(result.tierLimits.hasClaims).toBe(true)
  })

  it('falls back to basic access when a trial has expired', () => {
    const result = resolveTierAccess(
      {
        status: 'trial',
        subscription_tier: 'trial',
        trial_ends_at: '2026-04-01T00:00:00.000Z',
        subscription_ends_at: null,
      },
      new Date('2026-04-17T00:00:00.000Z')
    )

    expect(result.isTrialActive).toBe(false)
    expect(result.effectiveTier).toBe('basic')
    expect(result.tierLimits.hasReports).toBe(false)
  })
})
