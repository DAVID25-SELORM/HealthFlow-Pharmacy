import { describe, expect, it } from 'vitest'
import { shouldFinalizeNhisServingReview } from './nhisServingWorkflow'

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
})

