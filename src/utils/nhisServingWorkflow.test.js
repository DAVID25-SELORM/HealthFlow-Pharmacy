import { describe, expect, it } from 'vitest'
import {
  canMcaOpenNhisClaimForServing,
  shouldApplyMcaEditWindowToClaim,
  shouldFinalizeNhisServingReview,
} from './nhisServingWorkflow'

describe('NHIS serving workflow status transitions', () => {
  it('does not finalize claims that are still awaiting MCA serving', () => {
    expect(shouldFinalizeNhisServingReview('pending_serving')).toBe(false)
    expect(shouldFinalizeNhisServingReview('serving_in_progress')).toBe(false)
  })

  it('finalizes only claims returned from MCA serving for claims officer review', () => {
    expect(shouldFinalizeNhisServingReview('returned_for_review')).toBe(true)
    expect(shouldFinalizeNhisServingReview('partially_served')).toBe(true)
    expect(shouldFinalizeNhisServingReview('fully_served')).toBe(true)
  })

  it('allows MCA users to open claims that are in the serving workflow', () => {
    expect(canMcaOpenNhisClaimForServing('pending_serving')).toBe(true)
    expect(canMcaOpenNhisClaimForServing('serving_in_progress')).toBe(true)
    expect(canMcaOpenNhisClaimForServing('returned_for_review')).toBe(true)
    expect(canMcaOpenNhisClaimForServing('served')).toBe(true)
  })

  it('does not allow MCA users to open completed submission states for serving', () => {
    expect(canMcaOpenNhisClaimForServing('submitted')).toBe(false)
    expect(canMcaOpenNhisClaimForServing('paid')).toBe(false)
    expect(canMcaOpenNhisClaimForServing('rejected')).toBe(false)
  })

  it('applies the MCA edit window only to served claims', () => {
    expect(shouldApplyMcaEditWindowToClaim('pending_serving')).toBe(false)
    expect(shouldApplyMcaEditWindowToClaim('serving_in_progress')).toBe(false)
    expect(shouldApplyMcaEditWindowToClaim('returned_for_review')).toBe(false)
    expect(shouldApplyMcaEditWindowToClaim('served')).toBe(true)
  })
})
