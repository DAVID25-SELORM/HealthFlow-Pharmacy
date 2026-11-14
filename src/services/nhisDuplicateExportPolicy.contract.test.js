// @vitest-environment node
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20261110090000_add_nhis_duplicate_export_policy.sql', 'utf8')
const service = readFileSync('src/services/nhisService.js', 'utf8')
const page = readFileSync('src/pages/Nhis.jsx', 'utf8')

it('keeps duplicate export policy fail-closed and administrator-controlled', () => {
  expect(migration).toContain('allow_duplicate_exports boolean not null default false')
  expect(migration).toContain("coalesce(value,false)")
  expect(migration).toContain("actor.role,'') not in ('admin','super_admin')")
  expect(migration).toContain('nhis_duplicate_export_policy_audit')
})

it('applies the organization policy only at export readiness and records allowed exports', () => {
  expect(service).toContain("getNhisDuplicateExportPolicy")
  expect(service).toContain('duplicateGroups.length && !readiness.duplicateExportsAllowed')
  expect(service).toContain('duplicateExportsAllowed: duplicateExportPolicy.allow_duplicate_exports === true')
  expect(page).toContain("nhis_claim.duplicate_export_policy_changed")
  expect(page).toContain("nhis_claim.duplicate_export_allowed")
})
