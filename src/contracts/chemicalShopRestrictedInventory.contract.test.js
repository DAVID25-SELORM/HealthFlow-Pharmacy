import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  isChemicalShopMedicineAllowed,
  isChemicalShopOrganizationType,
} from '../../supabase/functions/_shared/chemicalShopInventory.ts'

const migration = fs.readFileSync(
  'supabase/migrations/20260809100000_add_chemical_shop_restricted_inventory.sql',
  'utf8'
)
const tierAccess = fs.readFileSync('supabase/functions/tier-access/index.ts', 'utf8')
const customerEpharmacy = fs.readFileSync('supabase/functions/customer-epharmacy/index.ts', 'utf8')

describe('Chemical Shop restricted inventory contract', () => {
  it('allows only OTC or explicitly permitted non-restricted medicines', () => {
    expect(isChemicalShopMedicineAllowed({ medicine_access_level: 'OTC' })).toBe(true)
    expect(isChemicalShopMedicineAllowed({ chemical_shop_sale_permitted: true })).toBe(true)
    expect(isChemicalShopMedicineAllowed({ medicine_access_level: 'POM' })).toBe(false)
    expect(isChemicalShopMedicineAllowed({})).toBe(false)
    expect(isChemicalShopMedicineAllowed({
      medicine_access_level: 'OTC',
      chemical_shop_sale_permitted: true,
      epharmacy_sale_class: 'prescription',
    })).toBe(false)
  })

  it('activates the restriction only for Chemical Shops', () => {
    expect(isChemicalShopOrganizationType('chemical_shop')).toBe(true)
    expect(isChemicalShopOrganizationType(' Chemical_Shop ')).toBe(true)
    expect(isChemicalShopOrganizationType('pharmacy')).toBe(false)
    expect(isChemicalShopOrganizationType('hospital')).toBe(false)
  })

  it('guards normal sales, purchasing, stock changes, and offline snapshots', () => {
    expect(migration).toContain('prevent_chemical_shop_restricted_sale')
    expect(migration).toContain('prevent_chemical_shop_restricted_purchase')
    expect(migration).toContain('prevent_chemical_shop_restricted_stock_change')
    expect(migration).toContain('prevent_chemical_shop_restricted_stock_insert')
    expect(migration).toContain('branch_sync_get_inventory_snapshot')
    expect(migration).toContain('or public.is_drug_allowed_for_chemical_shop(drugs)')
  })

  it('keeps quarantine records private and all review/status operations audited', () => {
    expect(migration).toContain('revoke all on public.restricted_inventory from public, anon, authenticated')
    expect(migration).toContain("'Restricted inventory list viewed'")
    expect(migration).toContain("'Restricted inventory audit viewed'")
    expect(migration).toContain("'status_changed'")
    expect(migration).toContain('u.organization_id = p_organization_id')
    expect(migration).toContain('can_manage_restricted_inventory')
  })

  it('filters service-role inventory, reports, and customer ordering', () => {
    expect(tierAccess).toContain('isChemicalShopMedicineAllowed')
    expect(tierAccess).toContain('chemicalShop ? rows.filter(isChemicalShopMedicineAllowed) : rows')
    expect(tierAccess).toContain("purchase_items (*, drugs (medicine_access_level, chemical_shop_sale_permitted, epharmacy_sale_class))")
    expect(tierAccess).toContain("if (chemicalShop) return { sales, nhisClaims: [] }")
    expect(customerEpharmacy).toContain('isChemicalShopOrganizationType')
    expect(customerEpharmacy).toContain('isChemicalShopMedicineAllowed(row)')
    expect(customerEpharmacy).toContain('isChemicalShopMedicineAllowed(drug)')
  })

  it('guards every service-role inventory write path for Chemical Shops', () => {
    expect(tierAccess).toContain(
      'Chemical Shops can add only medicines explicitly classified as OTC or approved for Chemical Shop sale.'
    )
    expect(tierAccess).toContain(
      'This medicine is restricted for Chemical Shops. Use Restricted Inventory for compliance review.'
    )
    expect(tierAccess).toContain(
      'Chemical Shops can import only medicines explicitly classified as OTC or approved for Chemical Shop sale.'
    )
    expect(tierAccess).toContain(
      'NHIS medicine catalogue sync is not available for Chemical Shop inventory.'
    )
  })

  it('preserves restricted stock instead of deleting it', () => {
    expect(migration).toContain("'Historical inventory migration'")
    expect(migration).toContain('insert into public.restricted_inventory')
    expect(migration).not.toMatch(/delete\s+from\s+public\.drugs/i)
  })
})
