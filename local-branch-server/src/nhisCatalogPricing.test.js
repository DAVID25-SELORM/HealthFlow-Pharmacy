import { describe, expect, it } from 'vitest'
import { applyNhisCatalogPricing } from './nhisCatalogPricing.js'

const catalog = [{
  id: 'catalog-1',
  code: 'NHIS-001',
  description: 'Catalog medicine',
  unit: 'tablet',
  unit_price: 2.5,
  is_active: true,
}]

describe('branch NHIS catalog pricing', () => {
it('overwrites client NHIS prices and totals from the local catalog', () => {
  const claim = applyNhisCatalogPricing({
    total_amount: 999,
    nhis_claim_medicines: [{
      nhis_drug_id: 'catalog-1',
      drug_code: 'TAMPERED',
      description: 'Tampered medicine',
      unit_price: 999,
      dispensed_qty: 3,
      total_amount: 2997,
    }],
    nhis_claim_services: [{ total_amount: 10 }],
  }, catalog)

  expect(claim.nhis_claim_medicines[0].drug_code).toBe('NHIS-001')
  expect(claim.nhis_claim_medicines[0].unit_price).toBe(2.5)
  expect(claim.nhis_claim_medicines[0].total_amount).toBe(7.5)
  expect(claim.total_amount).toBe(17.5)
})

it('resolves a branch-local catalog id mismatch by NHIS code', () => {
  const claim = applyNhisCatalogPricing({
    nhis_claim_medicines: [{
      nhis_drug_id: 'stale-local-id',
      drug_code: 'nhis-001',
      dispensed_qty: 2,
    }],
  }, catalog)

  expect(claim.nhis_claim_medicines[0].nhis_drug_id).toBe('catalog-1')
  expect(claim.nhis_claim_medicines[0].total_amount).toBe(5)
})

it('rejects medicine lines that are not in the active NHIS catalog', () => {
  expect(() => applyNhisCatalogPricing({
      nhis_claim_medicines: [{ drug_code: 'UNKNOWN', dispensed_qty: 1 }],
    }, catalog)).toThrow(/must match an active NHIS catalog item/)
})

it('does not use catalog rows stored with a numeric inactive flag', () => {
  expect(() => applyNhisCatalogPricing({
      nhis_claim_medicines: [{ drug_code: 'NHIS-001', dispensed_qty: 1 }],
    }, [{ ...catalog[0], is_active: 0 }])).toThrow(/must match an active NHIS catalog item/)
})
})
