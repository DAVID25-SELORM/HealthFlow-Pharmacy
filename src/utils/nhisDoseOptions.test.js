import { describe, expect, it } from 'vitest'
import {
  getNhisDoseOptions,
  getNhisDoseSuggestionOptions,
  resolveNhisDoseEntryModel,
  validateNhisDoseEntry,
} from './nhisDoseOptions'

describe('NHIS dose suggestions', () => {
  it('offers tablet quantities only for tablet medicines', () => {
    expect(getNhisDoseOptions({ unit: 'Tablet' })).toEqual([
      '0.5 tablet', '1 tablet', '2 tablets', '3 tablets',
    ])
  })

  it('offers ml quantities only for syrup medicines', () => {
    expect(getNhisDoseOptions({ description: 'Amoxicillin syrup, 125 mg/5 ml' })).toEqual([
      '2.5 ml', '5 ml', '10 ml', '15 ml',
    ])
  })

  it('uses the dosage form when the unit is generic', () => {
    expect(getNhisDoseOptions({ unit: 'Bottle', dosageForm: 'Oral suspension' })).toEqual([
      '2.5 ml', '5 ml', '10 ml', '15 ml',
    ])
  })

  it('stores the calculated active-ingredient tablet dose and shows its administration quantity', () => {
    expect(getNhisDoseSuggestionOptions({ unit: 'Tablet', strength: '10 mg' })).toEqual([
      expect.objectContaining({ value: '5 mg', label: '5 mg (0.5 tablet)' }),
      expect.objectContaining({ value: '10 mg', label: '10 mg (1 tablet)' }),
      expect.objectContaining({ value: '20 mg', label: '20 mg (2 tablets)' }),
      expect.objectContaining({ value: '30 mg', label: '30 mg (3 tablets)' }),
    ])
  })

  it('shows the calculated liquid dose for catalogue concentrations', () => {
    expect(getNhisDoseSuggestionOptions({
      description: 'Paracetamol Suspension',
      strength: '120 mg/5 mL',
    })[1]).toMatchObject({ value: '120 mg', label: '120 mg (5 ml)' })
  })

  it('offers a 600 mg injection dose from a 150 mg/mL catalogue strength', () => {
    expect(getNhisDoseSuggestionOptions({
      description: 'Clindamycin Injection',
      strength: '150 mg/mL',
    })).toContainEqual(expect.objectContaining({
      value: '600 mg',
      label: '600 mg (4 ml)',
    }))
  })

  it('uses vial quantities rather than invented mL volumes for fixed-strength injections', () => {
    expect(getNhisDoseSuggestionOptions({
      description: 'Omeprazole Injection',
      strength: '40 mg',
    })).toEqual([
      expect.objectContaining({ value: '20 mg', label: '20 mg (0.5 vial)' }),
      expect.objectContaining({ value: '40 mg', label: '40 mg (1 vial)' }),
      expect.objectContaining({ value: '80 mg', label: '80 mg (2 vials)' }),
    ])
  })

  it('keeps an infusion concentration separate from its prescribed volume', () => {
    const normalSaline = {
      dosageForm: 'Infusion',
      description: 'Sodium Chloride Infusion 0.9%, 500 mL',
      strength: '0.9%',
      unit: 'Bag',
    }

    expect(resolveNhisDoseEntryModel(normalSaline)).toMatchObject({
      kind: 'IV_FLUID_VOLUME',
      doseUnit: 'ml',
      options: ['500 ml', '1000 ml'],
    })
    expect(getNhisDoseSuggestionOptions(normalSaline)).toEqual([
      expect.objectContaining({ value: '500 ml', label: '500 ml' }),
      expect.objectContaining({ value: '1000 ml', label: '1,000 mL (1 L)' }),
    ])
    expect(validateNhisDoseEntry(normalSaline, '1000 mL')).toBe('')
    expect(validateNhisDoseEntry(normalSaline, '1000000 mg')).toContain('volume must be positive')
  })

  it('treats mass-per-volume drug infusions as drug doses, not IV-fluid volumes', () => {
    const ciprofloxacin = {
      dosageForm: 'Infusion',
      description: 'Ciprofloxacin Infusion, 2 mg/mL in 100 mL',
      strength: '2 mg/mL',
      unit: 'Bottle',
    }

    expect(resolveNhisDoseEntryModel(ciprofloxacin)).toMatchObject({
      kind: 'DRUG_INFUSION_MASS',
      doseUnit: 'mg',
      options: ['200 mg', '400 mg'],
    })
    expect(getNhisDoseSuggestionOptions(ciprofloxacin)).toContainEqual(
      expect.objectContaining({ value: '400 mg', label: '400 mg' })
    )
    expect(validateNhisDoseEntry(ciprofloxacin, '400 mg')).toBe('')
    expect(validateNhisDoseEntry(ciprofloxacin, '400 ml')).toContain('positive mg dose')
  })

  it('does not assign generic infusion volumes without catalogue container data', () => {
    expect(getNhisDoseOptions({ dosageForm: 'Infusion', strength: '0.9%' })).toEqual([])
  })

  it('keeps other supported formulation families in their own dose models', () => {
    expect(getNhisDoseOptions({ dosageForm: 'Capsule' })).toEqual(['1 capsule', '2 capsules', '3 capsules'])
    expect(getNhisDoseOptions({ dosageForm: 'Cream' })).toEqual(['1 application', '2 applications', 'Thin layer'])
    expect(getNhisDoseOptions({ dosageForm: 'Eye drops' })).toEqual(['1 drop', '2 drops', '3 drops'])
    expect(getNhisDoseOptions({ dosageForm: 'Inhaler' })).toEqual(['1 puff', '2 puffs', '3 puffs'])
    expect(getNhisDoseOptions({ dosageForm: 'Suppository' })).toEqual(['1 suppository', '2 suppositories'])
    expect(getNhisDoseOptions({ dosageForm: 'Pessary' })).toEqual(['1 pessary'])
    expect(getNhisDoseOptions({ dosageForm: 'Powder' })).toEqual(['0.5 dose', '1 dose', '2 doses'])
  })
})
