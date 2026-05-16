import { DEFAULT_NHIS_DRUG_CATALOG } from './nhisDefaultDrugCatalog'

describe('default NHIS drug catalog', () => {
  it('ships the generated NHIS medicine seed list used for empty facility catalogs', () => {
    expect(DEFAULT_NHIS_DRUG_CATALOG).toHaveLength(551)
    expect(DEFAULT_NHIS_DRUG_CATALOG).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AMOXICCA1',
          description: 'Amoxicillin Capsule, 250 mg',
          unit_price: 0.47,
        }),
      ])
    )
  })
})
