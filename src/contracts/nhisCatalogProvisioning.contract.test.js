import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

const provisioning = fs.readFileSync('supabase/functions/_shared/nhisCatalogProvisioning.ts', 'utf8')
const service = fs.readFileSync('src/services/nhisService.js', 'utf8')
const migration = fs.readFileSync('supabase/migrations/20260822100000_improve_nhis_catalog_validation_error.sql', 'utf8')

describe('NHIS catalogue provisioning contract', () => {
  it('uses the generated NHIS catalogue as the single provisioning reference and inserts only missing codes', () => {
    expect(provisioning).toContain("../../../src/data/nhisDefaultDrugCatalog.js")
    expect(provisioning).toContain(".filter((row) => !existingByCode.has")
    expect(provisioning).not.toContain('.upsert(')
  })

  it('preserves inactive and customized organization rows while auditing inserted rows', () => {
    expect(provisioning).toContain('inactiveCodes')
    expect(provisioning).toContain('incompleteCodes')
    expect(provisioning).toContain("event_type: 'nhis_catalog.provisioned'")
  })

  it('blocks every unresolved claim line with an actionable facility-specific message before saving', () => {
    expect(service).toContain('is not available as an active NHIS catalogue item for this facility.')
    expect(service).toContain('else if (!catalogMedicine?.id)')
  })

  it('keeps the database trigger strict while identifying its failed line', () => {
    expect(migration).toContain('and is_active = true')
    expect(migration).toContain('is not available as an active NHIS catalogue item for this facility.')
  })
})
