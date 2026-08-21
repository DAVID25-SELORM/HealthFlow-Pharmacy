import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260820100000_fix_cross_facility_medicine_dispensing_dates.sql'
), 'utf8')
const dispensingDateHelper = sql.match(
  /create or replace function public\.nhis_medicine_dispensing_date[\s\S]*?\n\$\$;/i
)?.[0] || ''

describe('cross-facility NHIS medicine dispensing-date contract', () => {
  it('uses only the approved clinical date order in Africa/Accra', () => {
    expect(sql).toMatch(/coalesce\(\s*p_dispensary_date,\s*\(p_served_at at time zone 'Africa\/Accra'\)::date,\s*p_service_date\s*\)/i)
    expect(dispensingDateHelper).not.toMatch(/created_at/i)
    expect(dispensingDateHelper).not.toMatch(/updated_at/i)
    expect(dispensingDateHelper).not.toMatch(/sync(ed)?_at/i)
  })

  it('flags mismatch and missing clinical dates without a historical backfill', () => {
    expect(sql).toContain('dispensing_date_mismatch')
    expect(sql).toContain('missing_clinical_dispensing_date')
    expect(sql).toContain('Dispensing date requires review.')
    expect(sql).not.toMatch(/update\s+public\.nhis_claim_medicines\s+set/i)
  })

  it('applies the same date helper to overlap and patient-summary RPCs', () => {
    expect(sql).toContain("'public.check_nhis_active_medication_overlap(text,text,text,date,uuid,uuid,text,text,text,numeric,text,text,text)'::regprocedure")
    expect(sql).toContain("'public.get_nhis_patient_active_medications(text,text,date,uuid,uuid)'::regprocedure")
    expect(sql.match(/nhis_medicine_dispensing_date\(m\.dispensary_date, m\.served_at, c\.service_date_from\)/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('preserves calendar-day arithmetic instead of introducing rolling hours', () => {
    expect(sql).toContain("at time zone 'Africa/Accra'")
    expect(sql).toContain('dispensed_date + (matched_lines.coverage_days - 1)')
    expect(sql).not.toMatch(/interval\s+'24 hours'/i)
  })

  it('derives the active caller organization and ignores the client id for disclosure', () => {
    expect(sql).toContain('where u.id = auth.uid() and u.is_active = true')
    expect(sql).toContain('v_caller_organization_id')
    expect(sql).toContain('join public.organizations o on o.id = c.organization_id')
    expect(sql).toContain('else null')
    expect(sql).toContain("'scored_matches.organization_id = v_caller_organization_id'")
    expect(sql).toContain("'visible_lines.organization_id = v_caller_organization_id'")
  })

  it('keeps the audit view tenant scoped and RPCs closed to anon', () => {
    expect(sql).toContain('with (security_invoker = true)')
    expect(sql).toContain('c.organization_id = public.user_organization_id()')
    expect(sql).toMatch(/revoke all on function public\.check_nhis_active_medication_overlap[\s\S]*from public, anon/i)
    expect(sql).toMatch(/revoke all on public\.nhis_medicine_dispensing_date_audit from public, anon/i)
  })

  it('preserves offline serving metadata and authoritative claim service dates', () => {
    expect(sql).toContain('create or replace function public.branch_sync_upsert_nhis_claim_with_serving_metadata')
    expect(sql).toContain("if p_entity_type = 'nhis_claims' then")
    expect(sql).toContain('public.branch_sync_upsert_offline_record_core(')
    for (const field of [
      'dispensary_date',
      'served_at',
      'served_qty',
      'serving_status',
      'prescribed_qty',
      'served_by_mca',
      'entered_at',
    ]) {
      expect(sql).toContain(field)
    }
    expect(sql).toContain("service_date_from = nullif(p_record->>'service_date_from', '')::date")
    expect(sql).toContain("nullif(v_item->>'served_at', '')::timestamptz")
    expect(sql).toMatch(/revoke all on function public\.branch_sync_upsert_nhis_claim_with_serving_metadata[\s\S]*from public, anon, authenticated/i)
  })

  it('does not weaken the genuinely-served overlap eligibility rule', () => {
    expect(sql).not.toContain("replace(v_overlap, 'coalesce(m.served_qty, m.dispensed_qty, 0) > 0'")
  })
})
