import { describe, expect, it } from 'vitest'
import {
  canMcaOpenNhisClaimForServing,
  isNhisClaimDirectlyServed,
  shouldApplyMcaEditWindowToClaim,
  shouldFinalizeNhisServingReview,
  splitMcaReadinessIssues,
} from './nhisServingWorkflow'

describe('NHIS serving workflow status transitions', () => {
  it('does not finalize claims that are still awaiting dispensary serving', () => {
    expect(shouldFinalizeNhisServingReview('pending_serving')).toBe(false)
    expect(shouldFinalizeNhisServingReview('serving_in_progress')).toBe(false)
  })

  it('finalizes only claims returned from dispensary serving for claims officer review', () => {
    expect(shouldFinalizeNhisServingReview('returned_for_review')).toBe(true)
    expect(shouldFinalizeNhisServingReview('partially_served')).toBe(true)
    expect(shouldFinalizeNhisServingReview('fully_served')).toBe(true)
  })

  it('allows dispensary users to open claims that are in the serving workflow', () => {
    expect(canMcaOpenNhisClaimForServing('pending_serving')).toBe(true)
    expect(canMcaOpenNhisClaimForServing('serving_in_progress')).toBe(true)
    expect(canMcaOpenNhisClaimForServing('returned_for_review')).toBe(true)
    expect(canMcaOpenNhisClaimForServing('served')).toBe(true)
  })

  it('does not allow dispensary users to open completed submission states for serving', () => {
    expect(canMcaOpenNhisClaimForServing('submitted')).toBe(false)
    expect(canMcaOpenNhisClaimForServing('paid')).toBe(false)
    expect(canMcaOpenNhisClaimForServing('rejected')).toBe(false)
  })

  it('keeps claims served directly by a Claims Officer out of the dispensary workflow', () => {
    const directClaim = {
      status: 'served',
      direct_served_at: '2026-07-01T12:00:00.000Z',
    }

    expect(isNhisClaimDirectlyServed(directClaim)).toBe(true)
    expect(canMcaOpenNhisClaimForServing(directClaim)).toBe(false)
    expect(canMcaOpenNhisClaimForServing({ status: 'served' })).toBe(true)
  })

  it('applies the dispensary edit window only to served claims', () => {
    expect(shouldApplyMcaEditWindowToClaim('pending_serving')).toBe(false)
    expect(shouldApplyMcaEditWindowToClaim('serving_in_progress')).toBe(false)
    expect(shouldApplyMcaEditWindowToClaim('returned_for_review')).toBe(false)
    expect(shouldApplyMcaEditWindowToClaim('served')).toBe(true)
  })

  it('keeps dispensary serving blockers separate from claims officer prescription completion', () => {
    const split = splitMcaReadinessIssues({
      blockers: [
        'Medicine 1: dose is required.',
        'Medicine 1: dosage schedule/frequency is required.',
        'Medicine 1: duration is required.',
        'Medicine 1: exact dispensed quantity must be greater than zero.',
      ],
      warnings: [
        'Medicine 1: waiting for dispensary served quantity.',
        'Medicine 1: Level not configured.',
        'Prescriber name or ID is missing from the prescription.',
      ],
    })

    expect(split.medicineBlockers).toEqual([
      'Medicine 1: exact dispensed quantity must be greater than zero.',
    ])
    expect(split.claimCompletionBlockers).toEqual([
      'Medicine 1: dose is required.',
      'Medicine 1: dosage schedule/frequency is required.',
      'Medicine 1: duration is required.',
    ])
    expect(split.medicineWarnings).toEqual([
      'Medicine 1: waiting for dispensary served quantity.',
      'Medicine 1: Level not configured.',
    ])
    expect(split.claimCompletionWarnings).toEqual([
      'Prescriber name or ID is missing from the prescription.',
    ])
    expect(split.canSaveMedicines).toBe(false)
  })

  it('does not block dispensary medicine saving for missing prescription directions alone', () => {
    const split = splitMcaReadinessIssues({
      blockers: [
        'Medicine 1: dose is required.',
        'Medicine 1: dosage schedule/frequency is required.',
        'Medicine 1: duration is required.',
      ],
      warnings: [],
    })

    expect(split.medicineBlockers).toEqual([])
    expect(split.claimCompletionBlockers).toHaveLength(3)
    expect(split.canSaveMedicines).toBe(true)
  })
})
