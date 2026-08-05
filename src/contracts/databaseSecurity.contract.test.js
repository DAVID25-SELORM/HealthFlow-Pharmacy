import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = (name) => readFileSync(resolve(process.cwd(), 'supabase/migrations', name), 'utf8')

describe('protected database security contracts', () => {
  it('keeps organization-scoped NHIA configuration behind RLS', () => {
    const sql = migration('20260525190000_create_nhia_configuration.sql')
    expect(sql).toMatch(/alter table public\.nhia_configuration enable row level security/i)
    expect(sql).toContain('nhia_configuration_select_org')
  })

  it('keeps deleted records tenant-scoped and protected by RLS', () => {
    const sql = migration('20260701100000_add_recycle_bin.sql')
    expect(sql).toMatch(/alter table public\.deleted_records enable row level security/i)
    expect(sql).toContain('deleted_records_admin_select')
    expect(sql).toContain('restore_deleted_record')
    expect(sql).toContain('permanently_delete_record')
  })

  it('keeps offline installer releases restricted by publication and super-admin policies', () => {
    const sql = migration('20260723130000_create_offline_installer_releases.sql')
    expect(sql).toMatch(/alter table public\.offline_installer_releases enable row level security/i)
    expect(sql).toContain('offline_installer_releases_select_enabled_or_super_admin')
    expect(sql).toContain('offline_installer_releases_manage_super_admin')
  })

  it('keeps branch sync and NHIA integration tables closed to direct clients', () => {
    const sql = migration('20260723030000_harden_security_advisor_findings.sql')
    expect(sql).toContain('branch_sync_clients_no_direct_client_access')
    expect(sql).toContain('branch_sync_events_no_direct_client_access')
    expect(sql).toContain('organization_nhia_integrations_no_direct_client_access')
    expect(sql.match(/using \(false\) with check \(false\)/gi)).toHaveLength(4)
  })

  it('keeps NHIS prescriber records organization-scoped', () => {
    const sql = migration('20260721120000_add_nhis_prescriber_facility_records.sql')
    expect(sql).toMatch(/alter table public\.nhis_prescribers enable row level security/i)
    expect(sql).toContain('nhis_prescribers_select_org')
    expect(sql).toContain('nhis_prescribers_write_org')
  })
})
