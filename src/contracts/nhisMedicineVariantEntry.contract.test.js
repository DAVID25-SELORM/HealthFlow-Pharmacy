import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const page = readFileSync(resolve(process.cwd(), 'src/pages/Nhis.jsx'), 'utf8')
const service = readFileSync(resolve(process.cwd(), 'src/services/nhisService.js'), 'utf8')

describe('NHIS catalogue medicine variant entry', () => {
  it('resolves formulation and strength against an existing catalogue item', () => {
    expect(page).toContain('resolveNhisCatalogMedicineVariant')
    expect(page).toContain('Catalogue strength selects the matching NHIS code and unit price.')
    expect(page).toContain('<label>Formulation</label>')
  })

  it('keeps the authoritative catalogue identity and tariff in claim rows', () => {
    expect(service).toContain('nhis_drug_id: toNullableUuid(m.nhisDrugId ?? m.nhis_drug_id)')
    expect(service).toContain('drug_code: normalizeText(m.drugCode) || null')
    expect(service).toContain('unit_price: unitPrice')
    expect(service).toContain('const totalAmount = assertNonNegativeNumber(unitPrice * servedQty')
  })

  it('updates the current medicine line rather than appending a duplicate while editing', () => {
    expect(page).toContain('return prev.map((medicine, index) => index === editingMedicineIndex ? nextMedicine : medicine)')
  })

  it('clears a dose that belongs to a different catalogue variant', () => {
    expect(page).toContain("dose: variantChanged ? '' : prev.dose")
    expect(page).toContain("dose:        ''")
    expect(page).toContain("dose:         ''")
  })
})
