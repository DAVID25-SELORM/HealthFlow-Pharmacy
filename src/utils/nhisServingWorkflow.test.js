import { describe, expect, it } from 'vitest'
import {
  canCorrectDirectServedNhisMedicine,
  canNhisClaimBeServedDirectly,
  canMcaOpenNhisClaimForServing,
  isNhisClaimDirectlyServed,
  markNhisMedicinesServedDirectly,
  markNhisMedicineFullyServed,
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

  it('does not offer direct serving again after a claim was already served directly', () => {
    expect(canNhisClaimBeServedDirectly({
      role: 'claims_officer',
      claim: {
        status: 'served',
        direct_served_at: '2026-08-08T10:00:00.000Z',
      },
    })).toBe(false)

    expect(canNhisClaimBeServedDirectly({
      role: 'admin',
      claim: { status: 'served' },
    })).toBe(true)
  })

  it('keeps direct serving restricted to its existing authorized roles and statuses', () => {
    expect(canNhisClaimBeServedDirectly({ role: 'assistant', claim: { status: 'draft' } })).toBe(false)
    expect(canNhisClaimBeServedDirectly({ role: 'admin', claim: { status: 'paid' } })).toBe(false)
    expect(canNhisClaimBeServedDirectly({ role: 'admin', claim: { status: 'draft' } })).toBe(true)
    expect(canNhisClaimBeServedDirectly({ role: 'claims_officer' })).toBe(true)
  })

  it('allows only authorized direct-serving roles to correct an already direct-served medicine', () => {
    const claim = { status: 'served', direct_served_at: '2026-08-08T10:00:00.000Z' }

    expect(canCorrectDirectServedNhisMedicine({ role: 'admin', claim })).toBe(true)
    expect(canCorrectDirectServedNhisMedicine({ role: 'claims_officer', claim })).toBe(true)
    expect(canCorrectDirectServedNhisMedicine({ role: 'assistant', claim })).toBe(false)
    expect(canCorrectDirectServedNhisMedicine({ role: 'admin', claim: { status: 'served' } })).toBe(false)
  })

  it('stages the full prescribed quantity without changing medicine pricing or directions', () => {
    expect(markNhisMedicineFullyServed({
      drugCode: 'PARACETA1',
      prescribedQty: 84,
      servedQty: 28,
      dispensedQty: 28,
      servingStatus: 'partially_served',
      reasonIfNotFullyServed: 'Partial stock',
      unitPrice: 0.12,
      dose: '2 tablets',
      frequency: 'TDS',
      duration: '7 days',
    })).toEqual({
      drugCode: 'PARACETA1',
      prescribedQty: 84,
      servedQty: 84,
      dispensedQty: 84,
      servingStatus: 'fully_served',
      reasonIfNotFullyServed: '',
      unitPrice: 0.12,
      dose: '2 tablets',
      frequency: 'TDS',
      duration: '7 days',
    })
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

  it('marks requested quantities as served for direct claims officer serving', () => {
    const servedAt = '2026-07-27T10:00:00.000Z'
    const medicines = markNhisMedicinesServedDirectly([
      {
        drugCode: 'NIFEDITA3',
        unitPrice: 0.3,
        prescribedQty: 14,
        servedQty: 0,
        dispensedQty: 0,
        servingStatus: 'pending',
      },
      {
        drugCode: 'ALLOPITA1',
        unitPrice: 5.14,
        dispensedQty: 1,
        servingStatus: 'pending',
      },
    ], {
      actorId: 'claims-officer-id',
      servedAt,
    })

    expect(medicines[0]).toMatchObject({
      prescribedQty: 14,
      servedQty: 14,
      dispensedQty: 14,
      servingStatus: 'fully_served',
      servedByMca: 'claims-officer-id',
      servedAt,
      totalAmount: 4.2,
    })
    expect(medicines[1]).toMatchObject({
      prescribedQty: 1,
      servedQty: 1,
      dispensedQty: 1,
      servingStatus: 'fully_served',
      servedByMca: 'claims-officer-id',
      servedAt,
      totalAmount: 5.14,
    })
  })
})
