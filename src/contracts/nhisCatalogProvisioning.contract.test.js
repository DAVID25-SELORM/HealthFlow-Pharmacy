import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

const provisioning = fs.readFileSync('supabase/functions/_shared/nhisCatalogProvisioning.ts', 'utf8')
const tierAccess = fs.readFileSync('supabase/functions/tier-access/index.ts', 'utf8')
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

  it('repairs an incomplete inventory mirror and skips a complete mirror on routine loads', () => {
    const actionStart = tierAccess.indexOf("if (action === 'provision_nhis_catalog')")
    const nextAction = tierAccess.indexOf("if (action === 'get_nhia_api_settings')", actionStart)
    const action = tierAccess.slice(actionStart, nextAction)

    expect(action).toContain(".from('nhis_drugs')")
    expect(action).toContain(".eq('is_active', true)")
    expect(action).toContain("select('id', { count: 'exact', head: true })")
    expect(action).toContain('inventoryNeedsRepair')
    expect(action).toContain('await syncNhisDrugsToInventory(')
    expect(action).toContain('{ drugs: activeCatalog || [] }')
    expect(action).toContain('inventoryUpserted: inventoryResult.upserted')
    expect(action).toContain('inventoryRepairSkipped: !inventoryNeedsRepair')
  })

  it('loads existing inventory once and writes the complete mirror in bounded batches', () => {
    const syncStart = tierAccess.indexOf('const syncNhisDrugsToInventory = async (')
    const syncEnd = tierAccess.indexOf('const normalizeCredentialMode', syncStart)
    const sync = tierAccess.slice(syncStart, syncEnd)

    expect(sync).toContain(".select('*')")
    expect(sync).toContain('chunkValues(updates, 25)')
    expect(sync).toContain('chunkValues(inserts, 100)')
    expect(sync).not.toContain('await findActiveDrugByNhisCode(')
    expect(sync).not.toContain("from('drugs').insert([row])")
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
