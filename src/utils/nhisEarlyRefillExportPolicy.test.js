import { describe, expect, it } from 'vitest'
import {
  NHIS_EARLY_REFILL_RELEASABLE_MATCH_TYPES,
  buildNhisEarlyRefillReleaseSummary,
  isNhisEarlyRefillReleasableAlert,
  splitNhisEarlyRefillAlerts,
} from './nhisEarlyRefillExportPolicy'

const alert = (matchType, extra = {}) => ({ match_type: matchType, medicine_description: 'Lisinopril Tablet, 2.5 mg', ...extra })

describe('splitNhisEarlyRefillAlerts (NHIS-007)', () => {
  it('releases nothing while the policy is off or not exactly true', () => {
    const alerts = [alert('early_refill_review'), alert('exact_code'), alert('same_ingredient'), alert('partial_previous_supply')]

    for (const allow of [false, undefined, null, 'true', 1, 'yes']) {
      expect(splitNhisEarlyRefillAlerts(alerts, { allow })).toEqual({ blocking: alerts, released: [] })
    }
    expect(splitNhisEarlyRefillAlerts(alerts)).toEqual({ blocking: alerts, released: [] })
  })

  it('releases only the early refill review, same medicine code and similar active ingredient alert types when the policy is on', () => {
    const early = alert('early_refill_review')
    const sameCode = alert('exact_code')
    const sameIngredient = alert('same_ingredient')
    const others = [
      alert('similar_active_ingredient'),
      alert('possible_completion_supply'),
      alert('partial_previous_supply'),
      alert('same_ingredient_extra'),
      alert('exact_code_extra'),
      alert(''),
      alert(undefined),
    ]

    const { blocking, released } = splitNhisEarlyRefillAlerts([early, sameCode, sameIngredient, ...others], { allow: true })

    expect(released).toEqual([early, sameCode, sameIngredient])
    expect(blocking).toEqual(others)
  })

  it('treats the match type case-insensitively and accepts a camelCase field', () => {
    expect(isNhisEarlyRefillReleasableAlert({ match_type: ' EARLY_REFILL_REVIEW ' })).toBe(true)
    expect(isNhisEarlyRefillReleasableAlert({ matchType: 'early_refill_review' })).toBe(true)
    expect(isNhisEarlyRefillReleasableAlert({ match_type: ' Exact_Code ' })).toBe(true)
    expect(isNhisEarlyRefillReleasableAlert({ match_type: 'same_ingredient' })).toBe(true)
    expect(isNhisEarlyRefillReleasableAlert({ match_type: 'partial_previous_supply' })).toBe(false)
    expect(isNhisEarlyRefillReleasableAlert({ match_type: 'early_refill_review_extra' })).toBe(false)
    expect(isNhisEarlyRefillReleasableAlert(null)).toBe(false)
    expect([...NHIS_EARLY_REFILL_RELEASABLE_MATCH_TYPES]).toEqual(['early_refill_review', 'exact_code', 'same_ingredient'])
  })

  it('tolerates missing or non-array input', () => {
    expect(splitNhisEarlyRefillAlerts(undefined, { allow: true })).toEqual({ blocking: [], released: [] })
    expect(splitNhisEarlyRefillAlerts(null, { allow: true })).toEqual({ blocking: [], released: [] })
    expect(splitNhisEarlyRefillAlerts('x', { allow: true })).toEqual({ blocking: [], released: [] })
  })

  it('does not change the order of the alerts that keep blocking', () => {
    const a = alert('partial_previous_supply', { id: 'a' })
    const b = alert('early_refill_review', { id: 'b' })
    const c = alert('similar_active_ingredient', { id: 'c' })

    expect(splitNhisEarlyRefillAlerts([a, b, c], { allow: true }).blocking.map((item) => item.id)).toEqual(['a', 'c'])
  })
})

describe('buildNhisEarlyRefillReleaseSummary', () => {
  it('groups released alerts by claim and lists each medicine once', () => {
    const summary = buildNhisEarlyRefillReleaseSummary([
      { claimId: 'c1', claimNumber: 'NHIS-000001', medicine: 'Lisinopril Tablet, 2.5 mg' },
      { claimId: 'c1', claimNumber: 'NHIS-000001', medicine: 'Lisinopril Tablet, 2.5 mg' },
      { claimId: 'c1', claimNumber: 'NHIS-000001', medicine: 'Amlodipine Tablet 5mg' },
      { claimId: 'c2', claimNumber: 'NHIS-000002', medicine: 'Metformin' },
    ])

    expect(summary.claim_count).toBe(2)
    expect(summary.truncated).toBe(false)
    expect(summary.claims).toEqual([
      { claim_id: 'c1', claim_number: 'NHIS-000001', medicines: ['Lisinopril Tablet, 2.5 mg', 'Amlodipine Tablet 5mg'] },
      { claim_id: 'c2', claim_number: 'NHIS-000002', medicines: ['Metformin'] },
    ])
  })

  it('is empty when nothing was released', () => {
    expect(buildNhisEarlyRefillReleaseSummary([])).toEqual({ claim_count: 0, claims: [], truncated: false })
    expect(buildNhisEarlyRefillReleaseSummary(undefined)).toEqual({ claim_count: 0, claims: [], truncated: false })
    expect(buildNhisEarlyRefillReleaseSummary([{ medicine: 'x' }])).toEqual({ claim_count: 0, claims: [], truncated: false })
  })

  it('keeps the audit payload small for a large export but still counts every claim', () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({ claimId: `c${index}`, claimNumber: `NHIS-${index}`, medicine: 'x' }))

    const summary = buildNhisEarlyRefillReleaseSummary(entries)

    expect(summary.claim_count).toBe(40)
    expect(summary.claims).toHaveLength(25)
    expect(summary.truncated).toBe(true)
  })
})
