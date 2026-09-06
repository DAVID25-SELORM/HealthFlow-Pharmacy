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

  it('shows the calculated mg dose but keeps the stored tablet instruction canonical', () => {
    expect(getNhisDoseSuggestionOptions({ unit: 'Tablet', strength: '10 mg' })).toEqual([
      expect.objectContaining({ value: '0.5 tablet', label: '0.5 tablet (5 mg)' }),
      expect.objectContaining({ value: '1 tablet', label: '1 tablet (10 mg)' }),
      expect.objectContaining({ value: '2 tablets', label: '2 tablets (20 mg)' }),
      expect.objectContaining({ value: '3 tablets', label: '3 tablets (30 mg)' }),
    ])
  })

  it('shows the calculated liquid dose for catalogue concentrations', () => {
    expect(getNhisDoseSuggestionOptions({
      description: 'Paracetamol Suspension',
      strength: '120 mg/5 mL',
    })[1]).toMatchObject({ value: '5 ml', label: '5 ml (120 mg)' })
  })
})
