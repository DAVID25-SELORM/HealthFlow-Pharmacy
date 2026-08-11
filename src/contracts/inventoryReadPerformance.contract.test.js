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
})
