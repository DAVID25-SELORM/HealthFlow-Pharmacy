import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const nhisPage = readFileSync(resolve(process.cwd(), 'src/pages/Nhis.jsx'), 'utf8')
const nhisService = readFileSync(resolve(process.cwd(), 'src/services/nhisService.js'), 'utf8')
const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260823100000_expose_active_medication_serving_facility.sql'),
  'utf8'
)

describe('NHIS serving-facility active-medication alert contract', () => {
  it('identifies the serving facility without exposing a claim reference', () => {
    expect(nhisPage).toContain('Serving facility: ${sourceLabel}')
    expect(migration).toContain('scored_matches.organization_id')
    expect(migration).toContain('visible_lines.organization_id')
    expect(migration).toContain("where o.id = scored_matches.organization_id")
    expect(migration).toContain("where o.id = visible_lines.organization_id")
    expect(migration).not.toContain('previous_claim_reference')
  })
})
