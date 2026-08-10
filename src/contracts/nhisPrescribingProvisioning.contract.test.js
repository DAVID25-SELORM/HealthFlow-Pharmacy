import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260810213000_provision_nhis_prescribing_facilities.sql'
), 'utf8')
const syncSource = readFileSync(resolve(process.cwd(), 'local-branch-server/src/supabaseSync.js'), 'utf8')
const serverSource = readFileSync(resolve(process.cwd(), 'local-branch-server/src/server.js'), 'utf8')
const tenantSignupSource = readFileSync(resolve(process.cwd(), 'supabase/functions/tenant-signup/index.ts'), 'utf8')
const correctiveMigration = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260810214500_retire_dispensing_pharmacy_as_prescribing_facility.sql'
), 'utf8')
const organizationWideMigration = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260810220000_make_nhis_prescribing_registers_organization_wide.sql'
), 'utf8')

describe('NHIS prescribing records provisioning and isolation', () => {
  it('provides an idempotent tenant-owned facility provisioner without fabricating prescribers', () => {
    expect(migration).toContain('create or replace function public.provision_nhis_prescribing_facility')
    expect(migration).toContain('lower(btrim(facility.facility_name)) = lower(btrim(organization.name))')
    expect(migration).not.toMatch(/insert into public\.nhis_prescribers/i)
  })

  it('retires own-facility provisioning because the tenant is the dispenser, not the prescription source', () => {
    expect(correctiveMigration).toContain('drop function if exists public.provision_nhis_prescribing_facility(uuid)')
    expect(tenantSignupSource).not.toContain("'provision_nhis_prescribing_facility'")
    expect(correctiveMigration).toContain("facility.notes = 'Created by canonical NHIS organization provisioning.'")
    expect(correctiveMigration).toContain('claim.prescribing_facility_id = facility.id')
    expect(correctiveMigration).toContain('prescriber.primary_facility_id = facility.id')
  })

  it('provides a metadata-only preview before repairing existing organizations', () => {
    expect(migration).toContain('public.list_nhis_prescribing_provisioning_gaps()')
    expect(migration).toContain('organization.can_use_nhis = true')
    expect(migration).not.toContain('from public.nhis_claims')
  })

  it('keeps private rows organization scoped and reusable across authorized branches', () => {
    expect(organizationWideMigration).toContain('organization_id = public.user_organization_id()')
    expect(organizationWideMigration).toContain('viewer.organization_id = nhis_prescribers.organization_id')
    expect(organizationWideMigration).toContain('viewer.organization_id = nhis_prescribing_facilities.organization_id')
    expect(organizationWideMigration).not.toContain('branch_id = viewer.branch_id')
    expect(organizationWideMigration).toContain('viewer.is_active = true')
  })

  it('keeps offline snapshots within the configured organization', () => {
    expect(syncSource).toContain("importOptionalAll(\n          supabase,\n          'nhis_prescribers'")
    expect(syncSource).toContain("importOptionalAll(\n          supabase,\n          'nhis_prescribing_facilities'")
    expect(serverSource).toContain('organization_id: config.organizationId || request.branchUser?.organizationId')
    expect(serverSource).toContain('branch_id: config.branchId || request.branchUser?.branchId || null')
  })
})
