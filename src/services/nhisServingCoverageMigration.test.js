// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest'

let db
const org = '00000000-0000-0000-0000-000000000001'
const prior = '00000000-0000-0000-0000-000000000002'
const current = '00000000-0000-0000-0000-000000000003'
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select '${org}'::uuid $$;
    create function user_organization_id() returns uuid language sql as $$ select '${org}'::uuid $$;
    create table nhis_claims (id uuid primary key, organization_id uuid, member_no text, hin text,
      claim_number text, service_date_from date, created_at timestamptz default now(), status text);
    create table nhis_drugs (id uuid, organization_id uuid, code text, generic_name text,
      strength text, dosage_form text, description text);
    create table nhis_claim_medicines (id serial primary key, claim_id uuid, nhis_drug_id uuid,
      drug_code text, description text, dispensary_date date, prescribed_qty numeric, dispensed_qty numeric,
      served_qty numeric, serving_status text, dose text, frequency text, duration text);
    create table users (id uuid, organization_id uuid, role text, assigned_roles text[]);
    insert into users values ('${org}', '${org}', 'claims_officer', '{}');
    alter table nhis_claims add column direct_served_at timestamptz, add column direct_served_by uuid,
      add column ccc_no text default '12345', add column serving_status text,
      add column serving_reviewed_by uuid, add column serving_reviewed_at timestamptz,
      add column total_amount numeric, add column updated_at timestamptz;
    alter table nhis_claim_medicines add column served_at timestamptz,
      add column unit_price numeric default 1, add column total_amount numeric;
    create function assert_nhis_ccc_for_progress(text) returns void language sql as $$ select $$;
  `)
  const directServing = readFileSync('supabase/migrations/20260912170000_enforce_nhis_ccc_transitions.sql', 'utf8')
  await db.exec(directServing.slice(directServing.indexOf('create or replace function public.serve_nhis_claim_direct'), directServing.indexOf("notify pgrst")))
  await db.exec(readFileSync('supabase/migrations/20260801100000_fix_nhis_active_medication_future_dispensing_window.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20261002110000_check_coverage_before_nhis_serving.sql', 'utf8'))
}, 30000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  await db.exec(`truncate nhis_claim_medicines, nhis_claims, nhis_drugs;
    insert into nhis_claims(id, organization_id, member_no, service_date_from, status) values
      ('${prior}', '${org}', '12345678', '2026-09-07', 'served'),
      ('${current}', '${org}', '12345678', '2026-09-14', 'draft');
    insert into nhis_claim_medicines(claim_id, drug_code, description, prescribed_qty, dispensed_qty,
      served_qty, serving_status, dose, frequency, duration) values
      ('${prior}', 'DRUG-A', 'Medicine A', 28, 28, 28, 'fully_served', '1', 'BD', '14 days'),
      ('${current}', 'DRUG-A', 'Medicine A', 28, 0, 0, 'pending', '1', 'BD', '14 days');`)
})
const serve = () => db.exec(`update nhis_claim_medicines set served_qty = 28,
  dispensed_qty = 28, serving_status = 'fully_served' where claim_id = '${current}'`)

it('blocks the reported 7th/14th overlap before serving and preserves pending quantities', async () => {
  await expect(serve()).rejects.toThrow('coverage through 2026-09-20 (7 day(s) remaining)')
  const { rows } = await db.query(`select served_qty, serving_status from nhis_claim_medicines where claim_id = '${current}'`)
  expect(rows[0]).toMatchObject({ served_qty: '0', serving_status: 'pending' })
})
it('allows the next supply after coverage ends', async () => {
  await db.exec(`update nhis_claims set service_date_from = '2026-09-21' where id = '${current}'`)
  await expect(serve()).resolves.toBeDefined()
})
it('does not match another member', async () => {
  await db.exec(`update nhis_claims set member_no = '87654321' where id = '${current}'`)
  await expect(serve()).resolves.toBeDefined()
})
it('allows a different medicine', async () => {
  await db.exec(`update nhis_claim_medicines set drug_code = 'DRUG-B' where claim_id = '${current}'`)
  await expect(serve()).resolves.toBeDefined()
})
it('checks equivalent ingredients when medicine codes differ', async () => {
  await db.exec(`insert into nhis_drugs values
    ('${prior}', '${org}', 'DRUG-A', 'ingredient', '10mg', 'tablet', 'Medicine A'),
    ('${current}', '${org}', 'DRUG-B', 'ingredient', '10mg', 'tablet', 'Medicine B');
    update nhis_claim_medicines set drug_code = 'DRUG-B' where claim_id = '${current}'`)
  await expect(serve()).rejects.toThrow('Cannot serve')
})
it('blocks the real Serve Directly RPC and leaves the claim unserved', async () => {
  await expect(db.query('select serve_nhis_claim_direct($1)', [current])).rejects.toThrow('Cannot serve')
  const { rows } = await db.query('select status, direct_served_at from nhis_claims where id = $1', [current])
  expect(rows[0]).toEqual({ status: 'draft', direct_served_at: null })
})
it('allows the real Serve Directly RPC after coverage ends', async () => {
  await db.exec(`update nhis_claims set service_date_from = '2026-09-21' where id = '${current}'`)
  const { rows } = await db.query('select serve_nhis_claim_direct($1) as result', [current])
  expect(rows[0].result).toMatchObject({ status: 'served', total_amount: 28 })
})
it('ignores cancelled previous claims', async () => {
  await db.exec(`update nhis_claims set status = 'cancelled' where id = '${prior}'`)
  await expect(serve()).resolves.toBeDefined()
})
it('checks a served medicine inserted by the dispensary replacement path', async () => {
  await expect(db.exec(`insert into nhis_claim_medicines(claim_id, drug_code, served_qty, serving_status)
    values ('${current}', 'DRUG-A', 28, 'fully_served')`)).rejects.toThrow('Cannot serve')
})
it('does not block pending entry or unrelated metadata corrections', async () => {
  await expect(db.exec(`update nhis_claim_medicines set description = 'Corrected description'`)).resolves.toBeDefined()
})
it('rolls back all lines if one of several medicines overlaps', async () => {
  await db.exec(`insert into nhis_claim_medicines(claim_id, drug_code, served_qty, serving_status)
    values ('${current}', 'DRUG-B', 0, 'pending')`)
  await expect(serve()).rejects.toThrow('Cannot serve')
  const { rows } = await db.query(`select sum(served_qty) as total from nhis_claim_medicines where claim_id = '${current}'`)
  expect(rows[0].total).toBe('0')
})
it('rejects serving outside the authenticated facility', async () => {
  await db.exec(`update nhis_claims set organization_id = '${prior}' where id = '${current}'`)
  await expect(serve()).rejects.toThrow('outside your organization')
})
it('does not silently serve when the coverage check is unavailable', async () => {
  await db.exec(`begin; alter function check_nhis_active_medication_overlap(
    text, text, text, date, uuid, uuid, text, text, text, numeric, text, text, text
  ) rename to unavailable_coverage_check`)
  try {
    await expect(serve()).rejects.toThrow('does not exist')
  } finally {
    await db.exec('rollback')
  }
})
