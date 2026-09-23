import { describe, expect, it } from 'vitest'
import {
  CRITICAL_STOCK_RATIO,
  STOCK_SEVERITY,
  buildReorderLineItem,
  getEffectiveTargetStockLevel,
  getEstimatedReorderValue,
  getStockSeverity,
  getSuggestedReorderQuantity,
  groupReorderItemsBySupplier,
  isReorderRelevantDrug,
  needsReorderAttention,
} from './reorderCentre'

const drug = (overrides = {}) => ({
  id: 'd1',
  status: 'active',
  quantity: 10,
  reorder_level: 20,
  batch_number: 'BATCH-1',
  ...overrides,
})

describe('getEffectiveTargetStockLevel', () => {
  it('uses the stored target when set', () => {
    expect(getEffectiveTargetStockLevel(drug({ target_stock_level: 60 }))).toBe(60)
  })

  it('falls back to reorder_level for the calculation only, without mutating anything', () => {
    const d = drug({ target_stock_level: null })
    expect(getEffectiveTargetStockLevel(d)).toBe(20)
    expect(d.target_stock_level).toBeNull() // untouched
  })
})

describe('getStockSeverity', () => {
  it('is OUT_OF_STOCK at zero or negative quantity', () => {
    expect(getStockSeverity(drug({ quantity: 0 }))).toBe(STOCK_SEVERITY.OUT_OF_STOCK)
  })

  it(`is CRITICAL at or below ${CRITICAL_STOCK_RATIO * 100}% of the reorder level`, () => {
    expect(getStockSeverity(drug({ quantity: 5, reorder_level: 20 }))).toBe(STOCK_SEVERITY.CRITICAL) // 25%
    expect(getStockSeverity(drug({ quantity: 6, reorder_level: 20 }))).toBe(STOCK_SEVERITY.LOW) // 30%
  })

  it('is LOW at or below the reorder level but above the critical ratio', () => {
    expect(getStockSeverity(drug({ quantity: 20, reorder_level: 20 }))).toBe(STOCK_SEVERITY.LOW)
  })

  it('is OK above the reorder level', () => {
    expect(getStockSeverity(drug({ quantity: 21, reorder_level: 20 }))).toBe(STOCK_SEVERITY.OK)
  })

  it('excludes an unstocked catalog placeholder from every severity, including out-of-stock', () => {
    const placeholder = drug({ quantity: 0, batch_number: 'PDF-IMP-0001' })
    expect(getStockSeverity(placeholder)).toBe(STOCK_SEVERITY.OK)
    expect(needsReorderAttention(placeholder)).toBe(false)
  })

  it('excludes an inactive/discontinued drug', () => {
    expect(getStockSeverity(drug({ quantity: 0, status: 'inactive' }))).toBe(STOCK_SEVERITY.OK)
  })
})

describe('isReorderRelevantDrug', () => {
  it('is false for a catalog placeholder never actually stocked', () => {
    expect(isReorderRelevantDrug(drug({ quantity: 0, batch_number: 'PDF-IMP-0001' }))).toBe(false)
  })

  it('is true for a catalog drug that has since been stocked', () => {
    expect(isReorderRelevantDrug(drug({ quantity: 5, batch_number: 'PDF-IMP-0001' }))).toBe(true)
  })
})

describe('getSuggestedReorderQuantity', () => {
  it('targets the desired stock level, not just the reorder level', () => {
    // current stock = 8, reorder level = 20, target stock = 60 -> 52, not 12.
    const d = drug({ quantity: 8, reorder_level: 20, target_stock_level: 60 })
    expect(getSuggestedReorderQuantity(d)).toBe(52)
  })

  it('subtracts quantity already on an open order', () => {
    // target = 100, current = 20, already ordered = 30 -> 50, not 80.
    const d = drug({ quantity: 20, reorder_level: 20, target_stock_level: 100 })
    expect(getSuggestedReorderQuantity(d, 30)).toBe(50)
  })

  it('never goes negative when stock already meets or exceeds target plus outstanding', () => {
    const d = drug({ quantity: 90, reorder_level: 20, target_stock_level: 100 })
    expect(getSuggestedReorderQuantity(d, 50)).toBe(0)
  })

  it('rounds up to a whole unit', () => {
    const d = drug({ quantity: 8.4, reorder_level: 20, target_stock_level: 60 })
    expect(getSuggestedReorderQuantity(d)).toBe(52) // ceil(51.6)
  })
})

describe('getEstimatedReorderValue', () => {
  it('prefers cost price over selling price', () => {
    expect(getEstimatedReorderValue(drug({ cost_price: 3.5, price: 5 }), 10)).toBeCloseTo(35)
  })

  it('falls back to selling price when cost price is missing', () => {
    expect(getEstimatedReorderValue(drug({ price: 5 }), 10)).toBeCloseTo(50)
  })
})

describe('buildReorderLineItem', () => {
  it('produces the exact shape Purchases.jsx expects, using drug.supplier by default', () => {
    const d = drug({
      id: 'd1', name: 'Amoxicillin 500mg', brand_name: 'Amoxil', generic_name: 'Amoxicillin',
      unit: 'capsule', cost_price: 3.5, supplier: 'MedSupply Ltd', reorder_level: 20, quantity: 8,
      target_stock_level: 60,
    })
    expect(buildReorderLineItem(d, 30)).toEqual({
      drugId: 'd1',
      drugName: 'Amoxicillin 500mg',
      brandName: 'Amoxil',
      genericName: 'Amoxicillin',
      unit: 'capsule',
      unitCost: 3.5,
      saleOnReturn: false,
      supplier: 'MedSupply Ltd',
      alreadyOnOrder: 30,
      suggestedQuantity: 22, // 60 - 8 - 30
    })
  })

  it('accepts a supplier override, e.g. one just assigned in the Reorder Centre', () => {
    const d = drug({ id: 'd2', name: 'Ibuprofen', supplier: '' })
    expect(buildReorderLineItem(d, 0, 'Accord Pharma').supplier).toBe('Accord Pharma')
  })
})

describe('groupReorderItemsBySupplier', () => {
  it('groups items under their supplier and keeps items with no supplier separate', () => {
    const items = [
      { drugName: 'A', supplier: 'MedSupply Ltd' },
      { drugName: 'B', supplier: 'MedSupply Ltd' },
      { drugName: 'C', supplier: 'Accord Pharma' },
      { drugName: 'D', supplier: '' },
    ]
    const groups = groupReorderItemsBySupplier(items)
    expect(groups.map((g) => g.supplier)).toEqual(['Accord Pharma', 'MedSupply Ltd', null])
    expect(groups.find((g) => g.supplier === 'MedSupply Ltd').items).toHaveLength(2)
    expect(groups.find((g) => g.supplier === null).items).toHaveLength(1)
  })
})
