import { describe, expect, it } from 'vitest'
import {
  canCorrectNhisClaimStatus,
  canPrivilegedCorrectNhisClaim,
} from './nhisPrivilegedCorrection'

describe('privileged NHIS correction access', () => {
  it('recognizes an Admin or Claims Officer from either active or assigned roles', () => {
    expect(canPrivilegedCorrectNhisClaim({ activeRole: 'claims_officer' })).toBe(true)
    expect(canPrivilegedCorrectNhisClaim({ activeRole: 'assistant', assignedRoles: ['claims_officer'] })).toBe(true)
    expect(canPrivilegedCorrectNhisClaim({ activeRole: 'billing', assignedRoles: ['admin'] })).toBe(true)
    expect(canPrivilegedCorrectNhisClaim({ activeRole: 'assistant', assignedRoles: ['billing'] })).toBe(false)
  })

  it('allows corrections across internal workflow states but protects final external states', () => {
    ;['draft', 'pending_serving', 'returned_for_review', 'served', 'claim_ready', 'rejected'].forEach((status) => {
      expect(canCorrectNhisClaimStatus(status)).toBe(true)
    })
    ;['submitted', 'paid', 'approved', 'accepted'].forEach((status) => {
      expect(canCorrectNhisClaimStatus(status)).toBe(false)
    })
  })
})
