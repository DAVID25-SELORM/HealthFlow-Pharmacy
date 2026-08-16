import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260816193000_make_nhis_correction_reason_optional.sql'
), 'utf8')
const service = readFileSync(resolve(process.cwd(), 'src/services/nhisService.js'), 'utf8')

describe('optional NHIS correction reason', () => {
  it('allows an empty reason without weakening correction audit safeguards', () => {
    expect(migration).toContain('alter column reason drop not null')
    expect(migration).toContain("'nullif(btrim(p_reason), '''')'")
    expect(service).not.toContain('Reason for correction is required before saving a previously saved claim.')
    expect(service).toContain('Privileged claim corrections require an online cloud connection')
    expect(service).toContain("'correct_nhis_claim_privileged'")
  })
})
