import { describe, expect, it } from 'vitest'
import { getNhisMedicineStrength } from './nhisMedicineStrength'

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
})
