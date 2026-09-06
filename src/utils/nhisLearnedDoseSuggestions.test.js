import { describe, expect, it } from 'vitest'
import {
  getNhisLearnedDoseObservation,
  mergeNhisDoseSuggestions,
  normalizeNhisLearnedDose,
} from './nhisLearnedDoseSuggestions'

const ciprofloxacin = {
  nhisDrugId: 'drug-cipro-1',
  dosageForm: 'Infusion',
  strength: '2 mg/mL',
  description: 'Ciprofloxacin infusion 2 mg/mL in 100 mL',
}

describe('NHIS learned dose suggestions', () => {
  it('normalizes equivalent manual dose spacing and casing without unit conversion', () => {
    expect(normalizeNhisLearnedDose(ciprofloxacin, '400mg')).toMatchObject({ value: '400 mg', doseUnit: 'mg' })
    expect(normalizeNhisLearnedDose(ciprofloxacin, '400 MG')).toMatchObject({ value: '400 mg', doseUnit: 'mg' })
  })

  it('learns valid custom doses but does not learn official defaults or invalid model units', () => {
    expect(getNhisLearnedDoseObservation(ciprofloxacin, '400 mg', 'claim-line-1', 'custom')).toMatchObject({ doseValue: 400, doseUnit: 'mg' })
    expect(getNhisLearnedDoseObservation(ciprofloxacin, '200 mg', 'claim-line-2', 'official')).toBeNull()
    expect(getNhisLearnedDoseObservation(ciprofloxacin, '400 mL', 'claim-line-3')).toBeNull()
  })

  it('keeps learned values variant-specific and ranks official before facility before shared', () => {
    const merged = mergeNhisDoseSuggestions(ciprofloxacin, [
      { doseValue: 400, doseUnit: 'mg', source: 'shared', usageCount: 9 },
      { doseValue: 400, doseUnit: 'mg', source: 'facility', usageCount: 1 },
    ])
    expect(merged.map((option) => option.value)).toEqual(['200 mg', '400 mg'])
    expect(merged[0].source).toBe('official')
    expect(merged[1].source).toBe('official')
    expect(mergeNhisDoseSuggestions({ ...ciprofloxacin, strength: '500 mg' }, [
      { nhisDrugId: 'drug-cipro-1', dosageForm: 'Infusion', strength: '2 mg/mL', doseValue: 400, doseUnit: 'mg', source: 'facility', usageCount: 1 },
    ]).some((option) => option.value === '400 mg')).toBe(false)
  })

  it('does not permit IV-fluid volumes to become drug-infusion mass observations', () => {
    const saline = {
      nhisDrugId: 'drug-saline-1', dosageForm: 'Infusion', strength: '0.9%',
      description: 'Normal saline infusion 500 mL', category: 'IV fluid',
    }
    expect(normalizeNhisLearnedDose(saline, '500 mL')).toMatchObject({ doseUnit: 'ml' })
    expect(normalizeNhisLearnedDose(saline, '500 mg')).toBeNull()
  })
})
