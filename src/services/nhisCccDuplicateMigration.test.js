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
    total_amount: 100,
    ...overrides,
  }
  return db.query(
    `insert into nhis_claims (id, organization_id, member_no, hin, ccc_no, service_date_from, status, claim_number, patient_id, total_amount)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [row.id, row.organization_id, row.member_no, row.hin, row.ccc_no, row.service_date_from, row.status, row.claim_number, row.patient_id || null, row.total_amount]
  )
}

beforeAll(async () => {
  db = new PGlite()
  // Mirrors production before this migration: the broad facility-wide guard (any claim, same CCC, +/-6 days)
  // is wired as a trigger, and earlier claims already share member + CCC + day with different totals.
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
      begin
        if exists (select 1 from nhis_claims c where c.organization_id = new.organization_id and c.id <> new.id
          and c.ccc_no = new.ccc_no and c.service_date_from between new.service_date_from - 6 and new.service_date_from + 6) then
          raise exception 'This CCC code is already used by another claim in this facility within 7 days of the service date.' using errcode = '23505';
        end if;
        return new;
      end $$;
    create trigger guard_facility_ccc_duplicate before insert or update on nhis_claims
      for each row execute function guard_facility_ccc_duplicate();
    create unique index nhis_claims_member_ccc_duplicate_idx on nhis_claims (member_no) where status = 'draft-only-test';`)
}, 30000)

afterAll(async () => { await db?.close() })

it('baseline: the live guard rejects a different member who shares a CCC within a week', async () => {
  await insertClaim({ member_no: '10000001', ccc_no: '67198', service_date_from: '2026-09-30' })
  await expect(insertClaim({ member_no: '10000002', ccc_no: '67198', service_date_from: '2026-10-02' }))
    .rejects.toThrow('already used by another claim in this facility')
})

it('applies cleanly even though production already holds same member + CCC + day claims', async () => {
  await db.exec('alter table nhis_claims disable trigger guard_facility_ccc_duplicate')
  await insertClaim({ member_no: '20000001', ccc_no: '31481', total_amount: 120 })
  await insertClaim({ member_no: '20000001', ccc_no: '31481', total_amount: 340 })
  await db.exec('alter table nhis_claims enable trigger guard_facility_ccc_duplicate')
  await db.exec(readFileSync(MIGRATION, 'utf8'))
})

it('no longer rejects a different member who shares a CCC within a week (the reported failure)', async () => {
  await insertClaim({ member_no: '10000002', ccc_no: '67198', service_date_from: '2026-10-02' })
})

it('no longer rejects several prescriptions for one member on one visit', async () => {
  await insertClaim({ member_no: '30000001', ccc_no: '55555', total_amount: 50 })
  await insertClaim({ member_no: '30000001', ccc_no: '55555', total_amount: 75 })
})

it('updating an old claim (attaching a prescription, changing its date or CCC) is never rejected', async () => {
  const id = uuid()
  await insertClaim({ id, member_no: '40000009', ccc_no: '67198', service_date_from: '2026-08-01' })
  await db.query('update nhis_claims set claim_number = $1, service_date_from = $2 where id = $3', ['NHIS-UPDATED', '2026-10-01', id])
  await db.query('update nhis_claims set ccc_no = $1 where id = $2', ['67198', id])
})

it('keeps exactly one trigger wired to the guard and leaves no member/CCC unique index behind', async () => {
  const triggers = await db.query("select count(*)::int as count from pg_trigger where tgfoid = 'guard_facility_ccc_duplicate()'::regprocedure and not tgisinternal")
  expect(triggers.rows[0].count).toBe(1)
  const indexes = await db.query("select indexname from pg_indexes where indexname = 'nhis_claims_member_ccc_duplicate_idx'")
  expect(indexes.rows).toEqual([])
})

it('reapplying the migration is harmless', async () => {
  await db.exec(readFileSync(MIGRATION, 'utf8'))
  await db.exec(readFileSync(MIGRATION, 'utf8'))
  await insertClaim({ member_no: '91000007' })
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
