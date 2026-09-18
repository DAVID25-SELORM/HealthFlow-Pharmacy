import { describe, expect, it } from 'vitest'
import { hasSubscriptionVisibility, subscriptionNotice } from './subscriptionLifecycle'

describe('subscription lifecycle visibility', () => {
  it.each(['admin', 'pharmacist'])('allows %s', (role) => {
    expect(hasSubscriptionVisibility(role)).toBe(true)
  })

  it.each(['cashier', 'assistant', 'technician', 'inventory_officer', 'claims_officer', 'records_officer'])('hides %s', (role) => {
    expect(hasSubscriptionVisibility(role)).toBe(false)
  })

  it('recognizes an assigned admin role without trusting the active role alone', () => {
    expect(hasSubscriptionVisibility('claims_officer', ['admin'])).toBe(true)
    expect(hasSubscriptionVisibility('claims_officer', ['billing'])).toBe(false)
  })

  it('uses calm non-blocking messages for grace and overdue states', () => {
    expect(subscriptionNotice({ state: 'grace', grace_ends_at: '2026-10-01T00:00:00Z' }).message).toContain('operating normally')
    expect(subscriptionNotice({ state: 'overdue' }).message).toContain('Core pharmacy and NHIS operations continue')
    expect(subscriptionNotice({ state: 'active' })).toBeNull()
  })
})
