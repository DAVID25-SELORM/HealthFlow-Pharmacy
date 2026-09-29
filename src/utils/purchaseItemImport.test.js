import { describe, expect, it } from 'vitest'
import {
  PURCHASE_IMPORT_MAX_ROWS,
  PURCHASE_IMPORT_ROW_STATUS,
  finalizePurchaseImportItem,
  groupDuplicatePurchaseImportRows,
  mapPurchaseImportHeaders,
  matchPurchaseImportDrug,
  parsePurchaseImportCsv,
  purchaseImportRowsToObjects,
  validatePurchaseImportRow,
} from './purchaseItemImport'

const HEADER = ['Drug / Item', 'Brand Name', 'Generic Name', 'Unit', 'Qty', 'Unit Cost', 'Discount %', 'Batch No.', 'Expiry Date', 'Sale on Return']
const drugs = [
  { id: 'd1', name: 'Paracetamol 500mg', brand_name: 'Panadol', generic_name: 'Paracetamol' },
  { id: 'd2', name: 'Amoxicillin 500mg', brand_name: 'Amoxil', generic_name: 'Amoxicillin' },
  { id: 'd3', name: 'Amoxicillin 500mg', brand_name: 'Amoxil', generic_name: 'Amoxicillin' }, // a second batch, same name
]
const unitOptions = ['tablet', 'capsule', 'syrup', 'vial']
// Mirrors Purchases.jsx's own calculators exactly, so tests confirm calculation parity without importing a React page.
const calcGross = (qty, cost) => (Number.parseFloat(qty) || 0) * (Number.parseFloat(cost) || 0)
const calcDiscountValue = (qty, cost, type, value) => {
  const gross = calcGross(qty, cost)
  const v = Number.parseFloat(value) || 0
  return type === 'amount' ? Math.min(Math.max(v, 0), gross) : Math.min(Math.max((gross * v) / 100, 0), gross)
}
const calcNetTotal = (qty, cost, type, value) => Math.max(0, calcGross(qty, cost) - calcDiscountValue(qty, cost, type, value))
const validate = (row) => validatePurchaseImportRow(row, { drugs, allowedUnits: unitOptions })

describe('mapPurchaseImportHeaders / purchaseImportRowsToObjects', () => {
  it('maps every template header, in any column order, to its canonical field', () => {
    const shuffled = ['Unit Cost', 'Qty', 'Drug / Item']
    const { keyByColumnIndex, missing, duplicates } = mapPurchaseImportHeaders(shuffled)
    expect(keyByColumnIndex).toEqual(['unitCost', 'quantity', 'drugName'])
    expect(missing).toEqual([])
    expect(duplicates).toEqual([])
  })

  it('accepts header aliases and ignores unknown extra columns', () => {
    const { keyByColumnIndex, missing } = mapPurchaseImportHeaders(['Drug', 'Cost', 'Quantity', 'Warehouse Bin'])
    expect(keyByColumnIndex).toEqual(['drugName', 'unitCost', 'quantity', null])
    expect(missing).toEqual([])
  })

  it('reports missing required columns by name', () => {
    const { missing } = mapPurchaseImportHeaders(['Brand Name'])
    expect(missing).toEqual(expect.arrayContaining(['drugName', 'quantity', 'unitCost']))
  })

  it('reports a duplicate column instead of silently taking the last one', () => {
    const { duplicates } = mapPurchaseImportHeaders(['Drug / Item', 'Qty', 'Unit Cost', 'Item'])
    expect(duplicates).toEqual(['drugName'])
  })

  it('throws a specific message for an empty file', () => {
    expect(() => purchaseImportRowsToObjects([])).toThrow('The file is empty.')
  })

  it('throws a specific message when required headers are missing', () => {
    expect(() => purchaseImportRowsToObjects([['Brand Name'], ['Panadol']])).toThrow(/Missing required column/)
  })

  it('throws a specific message for a header row with no data rows', () => {
    expect(() => purchaseImportRowsToObjects([HEADER])).toThrow('no data rows')
  })

  it('throws when the file exceeds the row limit', () => {
    const rows = [HEADER, ...Array.from({ length: PURCHASE_IMPORT_MAX_ROWS + 1 }, () => ['Paracetamol', '', '', '', '1', '1', '', '', '', ''])]
    expect(() => purchaseImportRowsToObjects(rows)).toThrow(`up to ${PURCHASE_IMPORT_MAX_ROWS} rows`)
  })

  it('turns rows into objects keyed by canonical field, skipping fully blank rows', () => {
    const rows = [HEADER, ['Paracetamol 500mg', 'Panadol', 'Paracetamol', 'tablet', '100', '0.5', '0', 'B1', '2027-12-31', 'No'], ['', '', '', '', '', '', '', '', '', '']]
    const objects = purchaseImportRowsToObjects(rows)
    expect(objects).toHaveLength(1)
    expect(objects[0]).toMatchObject({ drugName: 'Paracetamol 500mg', quantity: '100', unitCost: '0.5' })
  })
})

describe('parsePurchaseImportCsv', () => {
  it('parses a simple CSV', () => {
    expect(parsePurchaseImportCsv('Drug,Qty\nParacetamol,100\n')).toEqual([['Drug', 'Qty'], ['Paracetamol', '100']])
  })

  it('handles quoted fields containing commas, embedded quotes and newlines', () => {
    const csv = 'Drug,Note\n"Paracetamol, 500mg","Says ""keep cool""\nStore in a fridge"\n'
    expect(parsePurchaseImportCsv(csv)).toEqual([['Drug', 'Note'], ['Paracetamol, 500mg', 'Says "keep cool"\nStore in a fridge']])
  })

  it('strips a UTF-8 BOM (common in Excel-exported CSVs)', () => {
    expect(parsePurchaseImportCsv('﻿Drug,Qty\nParacetamol,1\n')[0]).toEqual(['Drug', 'Qty'])
  })

  it('tolerates a file with no trailing newline', () => {
    expect(parsePurchaseImportCsv('Drug,Qty\nParacetamol,1')).toEqual([['Drug', 'Qty'], ['Paracetamol', '1']])
  })
})

describe('matchPurchaseImportDrug', () => {
  it('matches a unique existing drug by exact, case-insensitive name and sets its id', () => {
    const result = matchPurchaseImportDrug('paracetamol 500mg', drugs)
    expect(result).toMatchObject({ status: 'matched', drugId: 'd1' })
  })

  it('treats several existing rows sharing a name (different batches) as matched, not ambiguous, leaving drugId null', () => {
    const result = matchPurchaseImportDrug('Amoxicillin 500mg', drugs)
    expect(result.status).toBe('matched')
    expect(result.drugId).toBeNull()
    expect(result.candidates).toHaveLength(2)
  })

  it('reports no match for a name that does not exist', () => {
    expect(matchPurchaseImportDrug('Made Up Drug', drugs)).toMatchObject({ status: 'unmatched', drugId: null, candidates: [] })
  })

  it('reports no match for a blank name', () => {
    expect(matchPurchaseImportDrug('', drugs).status).toBe('unmatched')
  })
})

describe('validatePurchaseImportRow', () => {
  const validRow = { drugName: 'Paracetamol 500mg', brandName: '', genericName: '', unit: 'tablet', quantity: '100', unitCost: '0.5', discountPercent: '10', batchNumber: 'B1', expiryDate: '2027-12-31', saleOnReturn: 'No' }

  it('accepts a fully valid, matched row and auto-fills brand/generic from the catalogue', () => {
    const result = validate({ ...validRow, brandName: '', genericName: '' })
    expect(result.status).toBe(PURCHASE_IMPORT_ROW_STATUS.VALID)
    expect(result.issues).toEqual([])
    expect(result.item).toMatchObject({
      drugId: 'd1', drugName: 'Paracetamol 500mg', brandName: 'Panadol', genericName: 'Paracetamol',
      unit: 'tablet', quantity: 100, unitCost: 0.5, discountType: 'percent', discountPercent: 10,
      saleOnReturn: false, batchNumber: 'B1', expiryDate: '2027-12-31',
    })
  })

  it('flags a missing drug name as invalid', () => {
    expect(validate({ ...validRow, drugName: '' }).status).toBe(PURCHASE_IMPORT_ROW_STATUS.INVALID)
  })

  it('flags a zero or negative quantity as invalid', () => {
    expect(validate({ ...validRow, quantity: '0' }).status).toBe(PURCHASE_IMPORT_ROW_STATUS.INVALID)
    expect(validate({ ...validRow, quantity: '-5' }).status).toBe(PURCHASE_IMPORT_ROW_STATUS.INVALID)
  })

  it('flags a non-numeric or negative unit cost as invalid', () => {
    expect(validate({ ...validRow, unitCost: 'free' }).status).toBe(PURCHASE_IMPORT_ROW_STATUS.INVALID)
    expect(validate({ ...validRow, unitCost: '-1' }).status).toBe(PURCHASE_IMPORT_ROW_STATUS.INVALID)
  })

  it('flags an out-of-range discount as invalid, and defaults a blank discount to zero', () => {
    expect(validate({ ...validRow, discountPercent: '150' }).status).toBe(PURCHASE_IMPORT_ROW_STATUS.INVALID)
    const blank = validate({ ...validRow, discountPercent: '' })
    expect(blank.status).toBe(PURCHASE_IMPORT_ROW_STATUS.VALID)
    expect(blank.item.discountPercent).toBe(0)
  })

  it('rejects a locale-ambiguous expiry date rather than guessing at day/month order', () => {
    expect(validate({ ...validRow, expiryDate: '03/04/2027' }).status).toBe(PURCHASE_IMPORT_ROW_STATUS.INVALID)
  })

  it('accepts an ISO expiry date and a real Date object (as read-excel-file returns for date cells)', () => {
    expect(validate({ ...validRow, expiryDate: '2027-12-31' }).item.expiryDate).toBe('2027-12-31')
    expect(validate({ ...validRow, expiryDate: new Date('2027-12-31T00:00:00Z') }).item.expiryDate).toBe('2027-12-31')
  })

  it('leaves expiry date and batch number optional, matching manual entry', () => {
    const result = validate({ ...validRow, expiryDate: '', batchNumber: '' })
    expect(result.status).toBe(PURCHASE_IMPORT_ROW_STATUS.VALID)
    expect(result.item.expiryDate).toBe('')
    expect(result.item.batchNumber).toBe('')
  })

  it('warns (does not block) on an unrecognized unit, falling back to the default unit', () => {
    const result = validate({ ...validRow, unit: 'barrel' })
    expect(result.status).toBe(PURCHASE_IMPORT_ROW_STATUS.WARNING)
    expect(result.item.unit).toBe('tablet')
  })

  it('warns (does not block) on an unmatched drug name, and still produces an importable row', () => {
    const result = validate({ ...validRow, drugName: 'Some New Medicine', brandName: 'X', genericName: 'Y' })
    expect(result.status).toBe(PURCHASE_IMPORT_ROW_STATUS.WARNING)
    expect(result.matchStatus).toBe('unmatched')
    expect(result.item.drugId).toBeNull()
    expect(result.item.drugName).toBe('Some New Medicine')
  })

  it('parses Sale on Return from common yes/no spellings and warns (without blocking) on an unrecognized value', () => {
    expect(validate({ ...validRow, saleOnReturn: 'Yes' }).item.saleOnReturn).toBe(true)
    expect(validate({ ...validRow, saleOnReturn: 'yes' }).item.saleOnReturn).toBe(true)
    expect(validate({ ...validRow, saleOnReturn: 'No' }).item.saleOnReturn).toBe(false)
    expect(validate({ ...validRow, saleOnReturn: '' }).item.saleOnReturn).toBe(false)
    const weird = validate({ ...validRow, saleOnReturn: 'maybe' })
    expect(weird.status).toBe(PURCHASE_IMPORT_ROW_STATUS.WARNING)
    expect(weird.item.saleOnReturn).toBe(false)
  })

  it('collects every issue on a row with several problems, instead of stopping at the first', () => {
    const result = validate({ ...validRow, drugName: '', quantity: '-1', unitCost: 'bad' })
    expect(result.status).toBe(PURCHASE_IMPORT_ROW_STATUS.INVALID)
    expect(result.issues.length).toBeGreaterThanOrEqual(3)
  })
})

describe('finalizePurchaseImportItem: calculations match manual entry exactly', () => {
  it('produces the same discountAmount/netTotal the manual entry panel would compute for the same numbers', () => {
    const { item } = validate({ drugName: 'Paracetamol 500mg', unit: 'tablet', quantity: '100', unitCost: '0.5', discountPercent: '10', expiryDate: '', batchNumber: '', saleOnReturn: '' })
    const finalized = finalizePurchaseImportItem(item, { calcDiscountValue, calcNetTotal })
    expect(finalized.discountAmount).toBeCloseTo(calcDiscountValue(100, 0.5, 'percent', 10), 10)
    expect(finalized.netTotal).toBeCloseTo(calcNetTotal(100, 0.5, 'percent', 10), 10)
    expect(finalized.netTotal).toBeCloseTo(45, 10) // 100 * 0.5 = 50 gross, 10% off = 45
  })
})

describe('groupDuplicatePurchaseImportRows', () => {
  const entry = (over) => ({ item: { drugName: 'Paracetamol 500mg', batchNumber: 'B1', expiryDate: '2027-12-31', unitCost: 0.5, discountPercent: 0, unit: 'tablet', saleOnReturn: false, quantity: 100, ...over } })

  it('groups rows identical in product, batch, expiry, cost, discount, unit and sale-on-return', () => {
    const groups = groupDuplicatePurchaseImportRows([entry(), entry(), entry({ quantity: 50 })])
    expect(groups).toEqual([[0, 1, 2]])
  })

  it('keeps rows with a different batch separate', () => {
    expect(groupDuplicatePurchaseImportRows([entry(), entry({ batchNumber: 'B2' })])).toEqual([])
  })

  it('keeps rows with a different expiry date separate', () => {
    expect(groupDuplicatePurchaseImportRows([entry(), entry({ expiryDate: '2028-01-01' })])).toEqual([])
  })

  it('keeps rows with a different unit cost or discount separate', () => {
    expect(groupDuplicatePurchaseImportRows([entry(), entry({ unitCost: 0.6 })])).toEqual([])
    expect(groupDuplicatePurchaseImportRows([entry(), entry({ discountPercent: 5 })])).toEqual([])
  })

  it('keeps rows with a different sale-on-return state separate', () => {
    expect(groupDuplicatePurchaseImportRows([entry(), entry({ saleOnReturn: true })])).toEqual([])
  })
})
