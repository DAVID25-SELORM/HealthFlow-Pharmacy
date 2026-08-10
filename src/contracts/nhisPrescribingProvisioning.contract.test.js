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
const reconciliationMigration = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260810223000_reconcile_nhis_prescribing_registers_from_claims.sql'
), 'utf8')
const automaticRegistrationMigration = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260810224000_auto_register_nhis_prescription_sources.sql'
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

  it('reconciles claim snapshots into organization-owned rows without fabricating values', () => {
    expect(reconciliationMigration).toContain('coalesce(prescriber_name_snapshot, physician_name)')
    expect(reconciliationMigration).toContain('coalesce(prescribing_facility_name_snapshot, referring_facility)')
    expect(reconciliationMigration).toMatch(/existing\.organization_id = source\.organization_id/i)
    expect(reconciliationMigration).toMatch(/prescriber\.organization_id = claim\.organization_id/i)
    expect(reconciliationMigration).toMatch(/facility\.organization_id = claim\.organization_id/i)
    expect(reconciliationMigration).not.toContain('Created by canonical NHIS organization provisioning.')
  })

  it('automatically registers future claim sources within the claim organization', () => {
    expect(automaticRegistrationMigration).toContain('before insert or update of')
    expect(automaticRegistrationMigration).toContain('new.organization_id')
    expect(automaticRegistrationMigration).toContain('facility.organization_id = new.organization_id')
    expect(automaticRegistrationMigration).toContain('prescriber.organization_id = new.organization_id')
    expect(automaticRegistrationMigration).toContain('pg_advisory_xact_lock')
    expect(automaticRegistrationMigration).toContain('on conflict (prescriber_id, facility_id) do nothing')
    expect(automaticRegistrationMigration).toContain("lower(v_facility_name) not in")
    expect(automaticRegistrationMigration).toContain("lower(v_prescriber_name) not in")
  })

  it('keeps offline snapshots within the configured organization', () => {
    expect(syncSource).toContain("importOptionalAll(\n          supabase,\n          'nhis_prescribers'")
    expect(syncSource).toContain("importOptionalAll(\n          supabase,\n          'nhis_prescribing_facilities'")
    expect(serverSource).toContain('organization_id: config.organizationId || request.branchUser?.organizationId')
    expect(serverSource).toContain('branch_id: config.branchId || request.branchUser?.branchId || null')
  })
})
