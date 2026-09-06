import { describe, expect, it } from 'vitest'
import {
  getNhisCatalogMedicineVariants,
  getNhisVariantForms,
  getNhisVariantStrengths,
  resolveNhisCatalogMedicineVariant,
} from './nhisCatalogMedicineVariants'

const catalogue = [
  { id: 'aml-5', code: 'AMLODT5', description: 'Amlodipine Tablet 5 mg', unit: 'Tablet', unit_price: 1.1 },
  { id: 'aml-10', code: 'AMLODT10', description: 'Amlodipine Tablet 10 mg', unit: 'Tablet', unit_price: 1.9 },
  { id: 'para-tab', code: 'PARATAB5', description: 'Paracetamol Tablet 500 mg', unit: 'Tablet', unit_price: 0.5 },
  { id: 'para-susp', code: 'PARASUS1', description: 'Paracetamol Suspension 120 mg/5 mL', unit: 'Bottle', unit_price: 4.5 },
  { id: 'miso-4', code: 'MISOT4', description: 'Misoprostol Tablet 400 mcg', unit: 'Tablet', unit_price: 2 },
]

describe('NHIS catalogue medicine variants', () => {
  it('derives medicine-specific mg strengths from catalogue variants', () => {
    const variants = getNhisCatalogMedicineVariants(catalogue, catalogue[0])
    expect(getNhisVariantStrengths(variants, 'tablet')).toEqual(['5 mg', '10 mg'])
  })

  it('keeps formulations and liquid concentrations distinct', () => {
    const variants = getNhisCatalogMedicineVariants(catalogue, catalogue[2])
    expect(getNhisVariantForms(variants)).toEqual(['tablet', 'suspension'])
    expect(getNhisVariantStrengths(variants, 'suspension')).toEqual(['120 mg/5 mL'])
  })

  it('resolves the authoritative variant, code, and tariff after changing strength', () => {
    expect(resolveNhisCatalogMedicineVariant({
      catalogue,
      medicine: catalogue[0],
      dosageForm: 'tablet',
      strength: '10 mg',
    })).toMatchObject({ id: 'aml-10', code: 'AMLODT10', unitPrice: 1.9 })
  })

  it('recognizes mcg strengths without a generic strength list', () => {
    expect(getNhisVariantStrengths(getNhisCatalogMedicineVariants(catalogue, catalogue[4]))).toEqual(['400 mcg'])
  })

  it('keeps infusion concentration and catalogue identity separate from administration volume', () => {
    const infusions = [
      { id: 'ns-09', code: 'NS09', description: 'Sodium Chloride Infusion 0.9%, 500 mL', unit: 'Bag', unit_price: 7.5 },
      { id: 'ns-045', code: 'NS045', description: 'Sodium Chloride Infusion 0.45%, 500 mL', unit: 'Bag', unit_price: 8.5 },
    ]
    const variants = getNhisCatalogMedicineVariants(infusions, infusions[0])

    expect(getNhisVariantForms(variants)).toEqual(['infusion'])
    expect(getNhisVariantStrengths(variants, 'infusion')).toEqual(['0.9%', '0.45%'])
    expect(resolveNhisCatalogMedicineVariant({
      catalogue: infusions,
      medicine: infusions[0],
      dosageForm: 'infusion',
      strength: '0.45%',
    })).toMatchObject({ id: 'ns-045', code: 'NS045', unitPrice: 8.5 })
  })

  it('keeps historical combined descriptions readable without rewriting them', () => {
    const historical = { description: 'Amlodipine Tablet 10 mg', unit: 'Tablet' }
    expect(getNhisCatalogMedicineVariants(catalogue, historical).map((variant) => variant.code))
      .toEqual(['AMLODT5', 'AMLODT10'])
  })

  it('does not duplicate strength choices when a catalogue has repeated imports', () => {
    const repeated = [...catalogue, { ...catalogue[1], id: 'aml-10-repeat' }]
    expect(getNhisVariantStrengths(getNhisCatalogMedicineVariants(repeated, repeated[0]), 'tablet'))
      .toEqual(['5 mg', '10 mg'])
  })
})
