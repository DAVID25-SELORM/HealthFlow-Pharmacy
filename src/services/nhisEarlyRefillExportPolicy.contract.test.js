// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const migrationPath = 'supabase/migrations/20261115090000_add_nhis_early_refill_export_policy.sql'
const migration = readFileSync(migrationPath, 'utf8')
const service = readFileSync('src/services/nhisService.js', 'utf8')
const page = readFileSync('src/pages/Nhis.jsx', 'utf8')

// NHIS-007 replaces the earlier organization duplicate-export opt-in (20261110090000).
// That migration stays in history and is untouched, but the application no longer reads it.
it('keeps the early refill export policy fail-closed and administrator-controlled', () => {
  expect(existsSync(migrationPath)).toBe(true)
  expect(migration).toContain('allow_early_refill_exports boolean not null default false')
  expect(migration).toContain('coalesce(value,false)')
  expect(migration).toContain("actor.role,'') not in ('admin','super_admin')")
  expect(migration).toContain('nhis_early_refill_export_policy_audit')
  expect(migration).toContain('enable row level security')
})

it('applies the policy only at export readiness and releases only the early refill review alert type', () => {
  expect(service).toContain('getNhisEarlyRefillExportPolicy')
  expect(service).toContain("supabase.rpc('get_nhis_early_refill_export_policy'")
  expect(service).toContain('allowEarlyRefillExports: earlyRefillExportPolicy.allow_early_refill_exports === true')
  expect(service).toContain('splitNhisEarlyRefillAlerts(alerts, {')
  expect(service).toContain('releasedEarlyRefillClaims: buildNhisEarlyRefillReleaseSummary(releasedEarlyRefillAlerts)')
})

it('no longer lets an organization policy release duplicate claims', () => {
  expect(service).not.toContain('getNhisDuplicateExportPolicy')
  expect(service).not.toContain('saveNhisDuplicateExportPolicy')
  expect(service).not.toContain('allow_duplicate_exports')
  expect(service).toContain('duplicateExportsAllowed: false')
  expect(page).not.toContain('Allow duplicate NHIS claims to be exported automatically')
  expect(page).not.toContain('nhis_claim.duplicate_export_allowed')
})

it('shows the early refill checkbox to administrators only and audits changes and releases', () => {
  expect(page).toContain("const canManageEarlyRefillExportPolicy = ['admin', 'super_admin'].includes(normalizedRole)")
  expect(page).toContain('Allow early refill claims to be exported')
  expect(page).toContain('nhis_claim.early_refill_export_policy_changed')
  expect(page).toContain('nhis_claim.early_refill_export_allowed')
})
