import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260906150000_add_nhis_learned_dose_suggestions.sql'), 'utf8')

describe('NHIS learned dose suggestion privacy contract', () => {
  it('keeps facility observations tenant-scoped and shared suggestions de-identified', () => {
    expect(migration).toContain('create table if not exists public.nhis_facility_dose_suggestions')
    expect(migration).toContain('organization_id uuid not null')
    expect(migration).toContain('create table if not exists public.nhis_shared_dose_suggestions')
    const sharedDefinition = migration.slice(
      migration.indexOf('create table if not exists public.nhis_shared_dose_suggestions'),
      migration.indexOf('alter table public.nhis_dose_suggestion_settings')
    )
    expect(sharedDefinition).not.toContain('organization_id')
    expect(sharedDefinition).not.toContain('claim_id')
    expect(sharedDefinition).not.toContain('patient')
  })

  it('uses auth-derived tenant context, promotion thresholds, suppression, and opaque idempotency', () => {
    expect(migration).toContain('v_org_id uuid := public.user_organization_id()')
    expect(migration).toContain('min_contributing_organizations')
    expect(migration).toContain("'claims_officer', 'records_officer'")
    expect(migration).toContain("status in ('active', 'suppressed', 'review_required')")
    expect(migration).toContain('md5(v_key)')
    expect(migration).toContain("where public.nhis_shared_dose_suggestions.status <> 'suppressed'")
  })
})
