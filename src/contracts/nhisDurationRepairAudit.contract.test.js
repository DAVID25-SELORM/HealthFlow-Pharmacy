import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260811194500_allow_audited_nhis_medicine_replacement.sql'
), 'utf8')

describe('NHIS duration repair audit compatibility', () => {
  it('retains the historical medicine UUID without blocking row replacement', () => {
    expect(migration).toContain('drop constraint nhis_duration_repair_audit_medicine_id_fkey')
    expect(migration).not.toMatch(/drop column\s+medicine_id/i)
    expect(migration).not.toMatch(/on delete cascade/i)
    expect(migration).toContain('medicine UUID must remain required')
  })
})
