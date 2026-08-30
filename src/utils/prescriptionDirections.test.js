import { describe, expect, it } from 'vitest'
import { autoSpaceDoseValue } from './prescriptionDirections'

describe('prescription direction formatting', () => {
  it('adds a space between a dose number and its letters', () => {
    expect(autoSpaceDoseValue('1MG')).toBe('1 MG')
    expect(autoSpaceDoseValue('5ml')).toBe('5 ml')
    expect(autoSpaceDoseValue('2TABLETS')).toBe('2 TABLETS')
    expect(autoSpaceDoseValue('0.5mg')).toBe('0.5 mg')
  })

  it('does not change already spaced or words-only doses', () => {
    expect(autoSpaceDoseValue('1 MG')).toBe('1 MG')
    expect(autoSpaceDoseValue('one tablet')).toBe('one tablet')
  })
})
