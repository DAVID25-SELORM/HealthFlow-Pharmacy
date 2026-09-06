import { describe, expect, it } from 'vitest'
import { getNhisDoseOptions, getNhisDoseSuggestionOptions } from './nhisDoseOptions'

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
})
