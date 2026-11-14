import { describe, expect, it } from 'vitest'
import {
  READINESS_FILTERS,
  getReadinessFilters,
  getReadinessIssueCategories,
} from './nhisReadinessCategories'

const EARLY_REFILL =
  'Export blocked: Lisinopril Tablet, 2.5 mg has early refill review; 8 treatment day(s) may still remain. ' +
  'NHIA may reject or reduce payment for an early refill. Previous dispensing date: 2026-08-11. ' +
  'Calculation: previous quantity 30; dose 1; frequency od; 1 administration(s)/day; 30 calculated treatment day(s). ' +
  'Expected completion date: 2026-09-09. Source: WESTPOINT CHEMIST. Risk score 70/100. ' +
  'Action: Review with the claims officer before dispensing; document the authorized reason if continued.'

const claim = (...issues) => ({ issues })

describe('pharmacy claims are never tagged Diagnosis', () => {
  it('puts an early-refill blocker under Clinical rules and Medicine only', () => {
    expect(getReadinessIssueCategories(claim(EARLY_REFILL), { isHospital: false }).sort()).toEqual(['clinical', 'medicine'])
  })

  it('does not tag a pharmacy claim Diagnosis even when the text names a diagnosis', () => {
    const categories = getReadinessIssueCategories(claim('Diagnosis is required for hospital NHIS claims.'), { isHospital: false })
    expect(categories).not.toContain('diagnosis')
    expect(categories).toEqual(['other'])
  })

  it('defaults to the pharmacy behaviour when no facility type is given', () => {
    expect(getReadinessIssueCategories(claim('ICD-10 code is missing'))).not.toContain('diagnosis')
  })
})

describe('hospital claims keep their Diagnosis category', () => {
  it('still tags real diagnosis problems', () => {
    expect(getReadinessIssueCategories(claim('Diagnosis is required for hospital NHIS claims.'), { isHospital: true })).toContain('diagnosis')
    expect(getReadinessIssueCategories(claim('Enter a valid ICD-10 code'), { isHospital: true })).toContain('diagnosis')
    expect(getReadinessIssueCategories(claim('Treatment does not match the recorded diagnosis'), { isHospital: true })).toContain('diagnosis')
    expect(getReadinessIssueCategories(claim('Select the treatment given'), { isHospital: true })).toContain('diagnosis')
  })

  it('no longer treats "treatment day(s)" in a calculation as a diagnosis', () => {
    expect(getReadinessIssueCategories(claim(EARLY_REFILL), { isHospital: true })).not.toContain('diagnosis')
  })
})

describe('other categories are unchanged', () => {
  it('still categorises attachment, member, prescriber and not-included issues', () => {
    expect(getReadinessIssueCategories(claim('Attach the scanned prescription PDF before exporting.'))).toContain('attachment')
    expect(getReadinessIssueCategories(claim('Membership number is missing'))).toContain('identifier')
    expect(getReadinessIssueCategories(claim('Prescriber name is required'))).toContain('prescriber')
    expect(getReadinessIssueCategories({ issues: ['x'], exportInclusion: 'not_included' })).toContain('not_included')
  })

  it('falls back to Other', () => {
    expect(getReadinessIssueCategories(claim('Something unrelated'))).toEqual(['other'])
    expect(getReadinessIssueCategories({})).toEqual(['other'])
  })
})

describe('filter chips', () => {
  it('hides the Diagnosis chip for pharmacies and keeps it for hospitals', () => {
    expect(getReadinessFilters(false).map((filter) => filter.id)).not.toContain('diagnosis')
    expect(getReadinessFilters().map((filter) => filter.id)).not.toContain('diagnosis')
    expect(getReadinessFilters(true).map((filter) => filter.id)).toContain('diagnosis')
  })

  it('shows every other chip to pharmacies', () => {
    const pharmacy = getReadinessFilters(false).map((filter) => filter.id)
    expect(pharmacy).toEqual(READINESS_FILTERS.map((filter) => filter.id).filter((id) => id !== 'diagnosis'))
    expect(pharmacy).toContain('clinical')
    expect(pharmacy).toContain('medicine')
  })
})
