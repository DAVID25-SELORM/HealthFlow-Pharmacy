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
    `insert into nhis_claims (id, organization_id, member_no, hin, ccc_no, service_date_from, status, claim_number, patient_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [row.id, row.organization_id, row.member_no, row.hin, row.ccc_no, row.service_date_from, row.status, row.claim_number, row.patient_id || null]
  )
}

beforeAll(async () => {
  db = new PGlite()
  // Simulate production wiring first; a later test verifies clean installation.
  await db.exec(`create role anon; create role authenticated;
    create table nhis_claims (
      id uuid primary key,
      organization_id uuid,
      member_no text,
      hin text,
      ccc_no text,
      service_date_from date,
      status text,
      claim_number text,
      patient_id uuid,
      total_amount numeric default 0
    );
    create table nhis_claim_medicines (claim_id uuid, drug_code text);
    create function user_organization_id() returns uuid language sql stable as $$ select '${ORG}'::uuid $$;
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

it('installs the trigger on a clean database and preserves exactly one production trigger on replay', async () => {
  await db.exec('drop trigger guard_facility_ccc_duplicate_trg on nhis_claims')
  await db.exec(readFileSync(MIGRATION, 'utf8'))
  await db.exec(readFileSync(MIGRATION, 'utf8'))
  const { rows } = await db.query("select count(*)::int as count from pg_trigger where tgfoid = 'guard_facility_ccc_duplicate()'::regprocedure and not tgisinternal")
  expect(rows[0].count).toBe(1)
})
it.each(['cancelled', 'canceled', 'voided', 'failed', 'rejected'])('allows a %s candidate alongside a live claim but blocks reactivation', async (status) => {
  const member_no = String(92000000 + ++seq)
  await insertClaim({ member_no })
  const id = uuid()
  await insertClaim({ id, member_no, status })
  await expect(db.query("update nhis_claims set status = 'served' where id = $1", [id])).rejects.toThrow('Possible duplicate claim')
})
it('normalizes empty member/HIN, CCC formatting and patient-ID fallback consistently', async () => {
  await insertClaim({ member_no: '', hin: '9300-0001', ccc_no: '12-345' })
  await expect(insertClaim({ member_no: '93000001', ccc_no: '12345' })).rejects.toThrow('Possible duplicate claim')
  const patient_id = uuid()
  await insertClaim({ member_no: null, patient_id })
  await expect(insertClaim({ member_no: '', patient_id })).rejects.toThrow('Possible duplicate claim')
})
it('uses the unique index as a backstop even without the trigger', async () => {
  await db.exec('alter table nhis_claims disable trigger guard_facility_ccc_duplicate')
  try {
    await insertClaim({ member_no: '94000001' })
    await expect(insertClaim({ member_no: '94000001' })).rejects.toThrow('nhis_claims_member_ccc_duplicate_idx')
  } finally { await db.exec('alter table nhis_claims enable trigger guard_facility_ccc_duplicate') }
})
it('looks up normalized CCC and same-member/date candidates with medicines, pagination, exclusion and facility scope', async () => {
  const ids = [uuid(), uuid(), uuid()]
  await insertClaim({ id: ids[0], member_no: '9500-0001', ccc_no: '98-765' })
  await insertClaim({ id: ids[1], member_no: '95000001', ccc_no: '22222' })
  await insertClaim({ id: ids[2], member_no: '95000001', ccc_no: '98765', organization_id: '00000000-0000-0000-0000-00000000000b' })
  await db.query('insert into nhis_claim_medicines values ($1, $2)', [ids[1], 'PARA500'])
  const lookup = async (offset, ignore = null) => (await db.query(
    "select * from get_nhis_ccc_duplicate_candidates('95000001', null, '98765', '2026-10-01', $1, $2, 1)", [ignore, offset]
  )).rows.map((r) => r.get_nhis_ccc_duplicate_candidates)
  expect((await lookup(0))[0].id).toBe(ids[0])
  expect((await lookup(1))[0]).toMatchObject({ id: ids[1], medicines: ['PARA500'] })
  expect(await lookup(2)).toEqual([])
  expect((await lookup(0, ids[0]))[0].id).toBe(ids[1])
})
it('keeps candidate lookup subject to caller RLS and denies anonymous access', async () => {
  await db.exec(`alter table nhis_claims enable row level security;
    alter table nhis_claim_medicines enable row level security;
    grant select on nhis_claims, nhis_claim_medicines to authenticated;
    create policy deny_claims on nhis_claims for select to authenticated using (false);
    set role authenticated;`)
  try {
    const { rows } = await db.query("select * from get_nhis_ccc_duplicate_candidates('40000001', null, '11111', '2026-10-01')")
    expect(rows).toEqual([])
  } finally { await db.exec('reset role') }
  await db.exec('set role anon')
  try {
    await expect(db.query("select * from get_nhis_ccc_duplicate_candidates('40000001', null, '11111', '2026-10-01')")).rejects.toThrow('permission denied')
  } finally { await db.exec('reset role') }
})
