import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const tierAccess = fs.readFileSync('supabase/functions/tier-access/index.ts', 'utf8')
const getDrugsBody = tierAccess.slice(
  tierAccess.indexOf('const getDrugs = async ('),
  tierAccess.indexOf('const loadEpharmacyOrders = async (')
)

describe('Inventory read performance contract', () => {
  it('keeps catalog synchronization and full NHIS matching out of get_drugs reads', () => {
    expect(getDrugsBody).not.toContain('syncDefaultMedicationCatalog(')
    expect(getDrugsBody).not.toContain('enrichDrugsWithNhisCatalog(')
    expect(getDrugsBody).toContain(".eq('organization_id', organizationId)")
    expect(getDrugsBody).toContain(".eq('status', 'active')")
  })

  it('repairs missing regular catalogue rows through a separate idempotent action', () => {
    expect(tierAccess).toContain("action === 'provision_default_medication_catalog'")
    expect(tierAccess).toContain('syncDefaultMedicationCatalog(adminClient, organizationId, branchId)')
    expect(getDrugsBody).not.toContain('provision_default_medication_catalog')
  })
})
