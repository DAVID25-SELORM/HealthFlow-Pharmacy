// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, expect, it } from 'vitest'

const MIGRATION = 'supabase/migrations/20261002100000_member_aware_ccc_duplicate_detection.sql'
const ORG = '00000000-0000-0000-0000-00000000000a'

let db
let seq = 0
const uuid = () => `00000000-0000-0000-0000-${String(++seq).padStart(12, '0')}`

const insertClaim = (overrides = {}) => {
  const row = {
    id: uuid(),
    organization_id: ORG,
    member_no: '40000001',
    hin: null,
    ccc_no: '11111',
    service_date_from: '2026-10-01',
    status: 'served',
    claim_number: 'NHIS-TEST',
    ...overrides,
  }
  return db.query(
    `insert into nhis_claims (id, organization_id, member_no, hin, ccc_no, service_date_from, status, claim_number)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [row.id, row.organization_id, row.member_no, row.hin, row.ccc_no, row.service_date_from, row.status, row.claim_number]
  )
}

beforeAll(async () => {
  db = new PGlite()
  // Mirrors production: the trigger wiring itself (CREATE TRIGGER) was added by the drift migrations
  // that already ran against the live database (see docs/nhis-ccc-duplicate-detection.md); this
  // migration only replaces the function body (CREATE OR REPLACE), reusing that existing wiring. So the
  // sandbox must create a placeholder function + trigger first, exactly as production already has one,
  // before applying the migration under test.
  await db.exec(`create role anon; create role authenticated;
    create table nhis_claims (
      id uuid primary key,
      organization_id uuid,
      member_no text,
      hin text,
      ccc_no text,
      service_date_from date,
      status text,
      claim_number text
    );
    create function guard_facility_ccc_duplicate() returns trigger language plpgsql as $$
      begin return new; end $$;
    create trigger guard_facility_ccc_duplicate_trg
      before insert or update on nhis_claims
      for each row execute function guard_facility_ccc_duplicate();`)
  await db.exec(readFileSync(MIGRATION, 'utf8'))
}, 30000)

afterAll(async () => { await db?.close() })

it('blocks the same member + same CCC + same service date (category A — strong duplicate)', async () => {
  await insertClaim()
  await expect(insertClaim()).rejects.toThrow('Possible duplicate claim')
})

it('never blocks a different member sharing the same CCC (category C — allow)', async () => {
  await insertClaim({ member_no: '50000002' })
})

it('never blocks the same member reusing a CCC on a clearly different service date', async () => {
  await insertClaim({ member_no: '60000003', service_date_from: '2026-01-01' })
  await insertClaim({ member_no: '60000003', service_date_from: '2026-06-01' })
})

it('does not treat a rejected/failed existing claim as a live duplicate', async () => {
  await insertClaim({ member_no: '70000004', status: 'rejected' })
  await insertClaim({ member_no: '70000004', status: 'served' })
})

it('an UPDATE that leaves member/CCC/date unchanged is never treated as a new duplicate', async () => {
  const id = uuid()
  await insertClaim({ id, member_no: '80000005', status: 'served', claim_number: 'NHIS-UPDATE' })
  await db.query('update nhis_claims set claim_number = $1 where id = $2', ['NHIS-UPDATE-2', id])
})

it('an UPDATE that introduces a real same-member/same-CCC/same-date conflict is blocked', async () => {
  await insertClaim({ member_no: '90000006', ccc_no: '22222', service_date_from: '2026-02-01', status: 'served' })
  const movingId = uuid()
  await insertClaim({ id: movingId, member_no: '90000006', ccc_no: '33333', service_date_from: '2026-02-01', status: 'served' })
  await expect(
    db.query('update nhis_claims set ccc_no = $1 where id = $2', ['22222', movingId])
  ).rejects.toThrow('Possible duplicate claim')
})

it('reapplying the migration (same name, create-or-replace / if-not-exists) does not error', async () => {
  await db.exec(readFileSync(MIGRATION, 'utf8'))
  await insertClaim({ member_no: '91000007' })
})

it('the partial unique index backing the guard exists', async () => {
  const { rows } = await db.query(
    "select indexname from pg_indexes where indexname = 'nhis_claims_member_ccc_duplicate_idx'"
  )
  expect(rows).toHaveLength(1)
})
