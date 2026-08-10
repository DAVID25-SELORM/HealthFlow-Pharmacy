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

  it('prevents users from changing their own tenant, role, status, or privileges', () => {
    const sql = migration('20260806100000_prevent_user_self_privilege_escalation.sql')
    expect(sql).toContain('prevent_user_self_privilege_escalation')
    expect(sql).toMatch(/before update on public\.users/i)
    expect(sql).toContain("'assigned_roles'")
    expect(sql).toContain("'organization_id'")
    expect(sql).toContain("'branch_id'")
    expect(sql).toContain("'is_active'")
    expect(sql).toContain("'can_delete_nhis_claims'")
    expect(sql).toMatch(/auth\.uid\(\) <> old\.id/i)
    expect(sql).toMatch(/errcode = '42501'/i)
    expect(sql).toMatch(/revoke all on function public\.prevent_user_self_privilege_escalation\(\) from authenticated/i)
  })

  it('keeps privileged NHIS correction history immutable and organization-scoped', () => {
    const sql = migration('20260810120000_add_privileged_nhis_claim_correction_audit.sql')
    expect(sql).toMatch(/alter table public\.nhis_claim_corrections enable row level security/i)
    expect(sql).toMatch(/revoke all on public\.nhis_claim_corrections from anon, authenticated/i)
    expect(sql).toMatch(/grant select on public\.nhis_claim_corrections to authenticated/i)
    expect(sql).not.toMatch(/grant (insert|update|delete).*nhis_claim_corrections.*authenticated/i)
    expect(sql).toMatch(/organization_id = public\.user_organization_id\(\)/i)
    expect(sql).toMatch(/security definer\s+set search_path = public/i)
    expect(sql).toMatch(/v_org_id <> public\.user_organization_id\(\)/i)
    expect(sql).toMatch(/u\.id = auth\.uid\(\).*u\.organization_id = v_org_id/i)
    expect(sql).toMatch(/role in \('admin', 'claims_officer'\)/i)
    expect(sql).toMatch(/revoke all on function public\.record_nhis_claim_correction.*from public, anon, authenticated/i)
    expect(sql).toMatch(/create or replace function public\.correct_nhis_claim_privileged/i)
    expect(sql).toMatch(/select \* into v_claim[\s\S]*for update/i)
    expect(sql).toMatch(/v_claim\.updated_at is distinct from p_expected_updated_at/i)
    expect(sql).toMatch(/v_new := jsonb_populate_record\(v_claim, v_patch\)/i)
    expect(sql).toMatch(/delete from public\.nhis_claim_medicines[\s\S]*insert into public\.nhis_claim_medicines/i)
    expect(sql).toMatch(/delete from public\.nhis_claim_services[\s\S]*insert into public\.nhis_claim_services/i)
    expect(sql).toMatch(/v_old_json := to_jsonb\(v_claim\)/i)
    expect(sql).toMatch(/revoke all on function public\.correct_nhis_claim_privileged.*from public, anon/i)
    expect(sql).toMatch(/grant execute on function public\.correct_nhis_claim_privileged.*to authenticated/i)
  })
})
