import { describe, expect, it } from 'vitest'
import {
  ACTIVE_DRUG_DUPLICATE_ERROR,
  getExistingDrugSaveAction,
  isActiveDrugRecord,
} from './drugInventory'

describe('drug inventory save behavior', () => {
  it('treats missing rows as new creates', () => {
    expect(getExistingDrugSaveAction(null)).toBe('create')
  })

  it('treats inactive rows as reactivations', () => {
    expect(getExistingDrugSaveAction({ id: 'drug-1', status: 'inactive' })).toBe('reactivate')
    expect(getExistingDrugSaveAction({ id: 'drug-2', status: 'expired' })).toBe('reactivate')
  })

  it('treats active rows as hard duplicates', () => {
    expect(getExistingDrugSaveAction({ id: 'drug-3', status: 'active' })).toBe('duplicate_active')
    expect(ACTIVE_DRUG_DUPLICATE_ERROR).toContain('already exists in inventory')
  })

  it('identifies active status consistently', () => {
    expect(isActiveDrugRecord({ status: 'active' })).toBe(true)
    expect(isActiveDrugRecord({ status: ' Active ' })).toBe(true)
    expect(isActiveDrugRecord({ status: 'inactive' })).toBe(false)
  })
})
