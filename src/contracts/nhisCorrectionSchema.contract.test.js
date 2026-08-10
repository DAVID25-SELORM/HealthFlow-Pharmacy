import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readMigration = (name) => readFileSync(
  resolve(process.cwd(), 'supabase/migrations', name),
  'utf8'
)

describe('privileged NHIS correction schema compatibility', () => {
  const correctionSql = readMigration('20260810120000_add_privileged_nhis_claim_correction_audit.sql')
  const repairSql = readMigration('20260810210000_add_nhis_unserved_medicines_note.sql')

  it('tracks the unserved medicine note column used by the atomic correction RPC', () => {
    expect(correctionSql).toContain('unserved_medicines_note=v_new.unserved_medicines_note')
    expect(repairSql).toMatch(/alter table if exists public\.nhis_claims[\s\S]*add column if not exists unserved_medicines_note text/i)
  })

  it('keeps the repair idempotent for databases that received the legacy patch', () => {
    expect(repairSql).toContain('add column if not exists unserved_medicines_note text')
  })
})
