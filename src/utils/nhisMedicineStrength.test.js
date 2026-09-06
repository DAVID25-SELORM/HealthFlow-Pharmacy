import { describe, expect, it } from 'vitest'
import { getNhisMedicineStrength } from './nhisMedicineStrength'
import { DEFAULT_NHIS_DRUG_CATALOG } from '../data/nhisDefaultDrugCatalog'

describe('NHIS medicine strength', () => {
  it('prefers the explicit catalogue strength', () => {
    expect(getNhisMedicineStrength({ strength: '10 mg', description: 'Medicine Tablet, 5 mg' })).toBe('10 mg')
  })

  it('derives mg, mcg and liquid concentrations from catalogue descriptions', () => {
    expect(getNhisMedicineStrength({ description: 'Carvedilol Tablet 12.5 mg' })).toBe('12.5 mg')
    expect(getNhisMedicineStrength({ description: 'Misoprostol Tablet, 400mcg' })).toBe('400mcg')
    expect(getNhisMedicineStrength({ description: 'Amoxicillin Suspension, 125 mg/5 mL' })).toBe('125 mg/5 mL')
    expect(getNhisMedicineStrength({
      strength: '150 mg',
      description: 'Clindamycin Injection, 150 mg/mL in 2 mL',
    })).toBe('150 mg/mL')
  })

  it('preserves every declared component of combination catalogue strengths', () => {
    expect(getNhisMedicineStrength({
      strength: '500 mg',
      description: 'Amoxicillin + Clavulanic Acid Tablet, 500 mg + 125 mg',
    })).toBe('500 mg + 125 mg')
    expect(getNhisMedicineStrength({
      description: 'Co-trimoxazole Suspension, (200+40) mg/5 mL',
    })).toBe('(200+40) mg/5 mL')
    expect(getNhisMedicineStrength({
      description: 'Budesonide + Formoterol Inhaler 160 microgram/4.5 microgram (60 Doses)',
    })).toBe('160 microgram/4.5 microgram')
  })

  it('does not truncate numeric combination strengths in the default NHIS catalogue', () => {
    const combinationRows = DEFAULT_NHIS_DRUG_CATALOG.filter((medicine) =>
      /\d(?:\.\d+)?\s*(?:mcg|micrograms?|µg|mg|g)\s*\+\s*\d/i.test(medicine.description)
    )
    expect(combinationRows.length).toBeGreaterThan(10)
    for (const medicine of combinationRows) {
      expect(getNhisMedicineStrength(medicine)).toContain('+')
    }
  })
})
