import { describe, expect, it } from 'vitest'
import { getNhisDoseOptions } from './nhisDoseOptions'

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
})
