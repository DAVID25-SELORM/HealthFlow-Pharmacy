import { describe, expect, it } from 'vitest'
import {
  defaultTransferQuantity,
  describeTransferSource,
  summarizeTransferAdvice,
  validateTransferQuantity,
} from './branchTransfer'

const option = (overrides = {}) => ({
  source_drug_id: 's1', source_branch_id: 'b1', source_branch_name: 'Kumasi', batch_number: 'B1',
  expiry_date: '2029-03-31', source_quantity: 90, spare_quantity: 70, ...overrides,
})

describe('summarizeTransferAdvice', () => {
  it('says which branch has how much spare', () => {
    const advice = summarizeTransferAdvice([option()], 52)
    expect(advice.message).toBe('Kumasi has 70 spare')
    expect(advice.coversSuggestion).toBe(true)
    expect(advice.best.source_drug_id).toBe('s1')
  })

  it('adds up several branches and says when they cannot cover the need', () => {
    const advice = summarizeTransferAdvice([option(), option({ source_branch_name: 'Tema', spare_quantity: 15 })], 100)
    expect(advice.totalSpare).toBe(85)
    expect(advice.message).toBe('Kumasi and 1 other branch have 85 spare')
    expect(advice.coversSuggestion).toBe(false)
  })

  it('counts a branch once in the wording even if it has several batches', () => {
    const advice = summarizeTransferAdvice([option(), option({ source_drug_id: 's2', batch_number: 'B2', spare_quantity: 10 })], 10)
    expect(advice.message).toBe('Kumasi has 80 spare')
  })

  it('gives no advice when there is nothing spare, or no options', () => {
    expect(summarizeTransferAdvice([], 10)).toBeNull()
    expect(summarizeTransferAdvice(undefined, 10)).toBeNull()
    expect(summarizeTransferAdvice([option({ spare_quantity: 0 })], 10)).toBeNull()
  })

  it('does not claim to cover a need of zero', () => {
    expect(summarizeTransferAdvice([option()], 0).coversSuggestion).toBe(false)
  })
})

describe('transfer quantity', () => {
  it('defaults to what is needed, capped at what the source can spare', () => {
    expect(defaultTransferQuantity(option(), 52)).toBe('52')
    expect(defaultTransferQuantity(option({ spare_quantity: 15 }), 52)).toBe('15')
    expect(defaultTransferQuantity(option(), 0)).toBe('70')
  })

  it('rejects zero, negatives, non-numbers, and more than the spare', () => {
    expect(validateTransferQuantity('', option())).toMatch(/above zero/)
    expect(validateTransferQuantity('0', option())).toMatch(/above zero/)
    expect(validateTransferQuantity('-4', option())).toMatch(/above zero/)
    expect(validateTransferQuantity('71', option())).toMatch(/only has 70 spare/)
    expect(validateTransferQuantity('5', null)).toMatch(/Choose which branch/)
  })

  it('accepts anything up to the spare, inclusive', () => {
    expect(validateTransferQuantity('70', option())).toBe('')
    expect(validateTransferQuantity('0.5', option())).toBe('')
  })
})

describe('describeTransferSource', () => {
  it('shows branch, batch and expiry', () => {
    expect(describeTransferSource(option())).toBe('Kumasi · batch B1 · expires 2029-03-31')
    expect(describeTransferSource(option({ batch_number: null, expiry_date: null }))).toBe('Kumasi')
  })
})
