// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from 'vitest'

let db
const user = '10000000-0000-4000-8000-000000000001'
const org = '20000000-0000-4000-8000-000000000001'
const claim = '30000000-0000-4000-8000-000000000001'
const event = '40000000-0000-4000-8000-000000000001'
const recycle = async () => (await db.query('select recycle_nhis_claim($1) as result', [claim])).rows[0].result
const restore = async (id) => db.query('select restore_deleted_record($1)', [id])
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select '${user}'::uuid $$;
    create table users (id uuid primary key, organization_id uuid, role text, assigned_roles text[], can_delete_nhis_claims boolean, is_active boolean);
    create table nhis_claims (id uuid primary key, organization_id uuid, claim_number text);
    create table nhis_claim_medicines (id uuid primary key, claim_id uuid references nhis_claims(id), created_at timestamptz default now());
    create table nhis_claim_services (like nhis_claim_medicines including all);
    create table drugs (id uuid primary key, organization_id uuid, status text, quantity numeric, updated_at timestamptz);
    create table deleted_records (id uuid primary key default gen_random_uuid(), organization_id uuid, entity_type text, entity_id uuid, display_name text, snapshot jsonb, deleted_by uuid, deleted_at timestamptz default now(), unique(organization_id,entity_type,entity_id));
    create table nhis_serving_events (id uuid primary key, organization_id uuid, claim_id uuid not null references nhis_claims(id) on delete restrict, idempotency_key text, payload_hash text, created_at timestamptz default now(), unique(organization_id,idempotency_key));
    create table nhis_inventory_ledger (id uuid primary key default gen_random_uuid(), claim_id uuid not null references nhis_claims(id) on delete restrict, serving_event_id uuid not null references nhis_serving_events(id) on delete restrict, quantity_delta numeric);
    insert into users values ('${user}','${org}','admin','{}',false,true);
    insert into nhis_claims values ('${claim}','${org}','NHIS-TEST');
    insert into nhis_claim_medicines(id,claim_id) values(gen_random_uuid(),'${claim}');
    insert into nhis_claim_services(id,claim_id) values(gen_random_uuid(),'${claim}');
    insert into nhis_serving_events values('${event}','${org}','${claim}','original-key','original-hash','2026-09-15T12:00:00Z');
  `)
  await db.exec(await readFile(new URL('../../supabase/migrations/20260916060000_fix_nhis_recycle_serving_events.sql', import.meta.url), 'utf8'))
}, 30000)
afterAll(async () => { await db?.close() })
beforeEach(async () => { await db.exec('begin') })
afterEach(async () => { await db.exec('rollback') })

it('archives and restores event-only claims with original IDs and idempotency data', async () => {
  const before = await db.query('select * from nhis_serving_events')
  const result = await recycle()
  expect((await db.query('select * from nhis_claims')).rows).toEqual([])
  expect((await db.query('select * from nhis_serving_events')).rows).toEqual([])
  const archive = (await db.query('select snapshot from deleted_records')).rows[0].snapshot
  expect(archive.serving_events[0]).toMatchObject({ id: event, idempotency_key: 'original-key', payload_hash: 'original-hash' })
  expect(archive.medicines).toHaveLength(1)
  expect(archive.services).toHaveLength(1)
  await restore(result.id)
  expect(await db.query('select * from nhis_serving_events')).toEqual(before)
  expect((await db.query('select * from deleted_records')).rows).toEqual([])
  expect((await db.query('select * from nhis_claim_medicines')).rows).toHaveLength(1)
})

it('rejects claims with inventory movements before changing the archive or ledger', async () => {
  await db.exec(`insert into nhis_inventory_ledger(claim_id,serving_event_id,quantity_delta) values('${claim}','${event}',-2),('${claim}','${event}',2); savepoint attempt`)
  await expect(recycle()).rejects.toThrow('recorded inventory movements')
  await db.exec('rollback to savepoint attempt')
  expect((await db.query('select * from nhis_inventory_ledger')).rows).toHaveLength(2)
  expect((await db.query('select * from nhis_claims')).rows).toHaveLength(1)
  expect((await db.query('select * from deleted_records')).rows).toEqual([])
})

it('restores older snapshots without a serving-events key', async () => {
  await db.exec('delete from nhis_serving_events')
  const result = await recycle()
  await db.exec("update deleted_records set snapshot = snapshot - 'serving_events'")
  await restore(result.id)
  expect((await db.query('select * from nhis_claims')).rows).toHaveLength(1)
})

it.each([
  "update users set organization_id = '20000000-0000-4000-8000-000000000002'",
  "update users set role = 'claims_officer'",
  'update users set is_active = false',
  'update users set role = null',
  'delete from users',
])('rejects unauthorized recycling: %s', async (setup) => {
  await db.exec(setup)
  await expect(recycle()).rejects.toThrow('permission')
})

it('allows a delegated delete permission but still requires admin restoration', async () => {
  await db.exec("update users set role='claims_officer', can_delete_nhis_claims=true")
  const result = await recycle()
  await expect(restore(result.id)).rejects.toThrow('administrator')
})

it('rolls back restoration when an idempotency key conflicts', async () => {
  const result = await recycle()
  await db.exec(`insert into nhis_claims values('30000000-0000-4000-8000-000000000002','${org}','OTHER');
    insert into nhis_serving_events(id,organization_id,claim_id,idempotency_key) values(gen_random_uuid(),'${org}','30000000-0000-4000-8000-000000000002','original-key'); savepoint attempt`)
  await expect(restore(result.id)).rejects.toThrow('duplicate key')
  await db.exec('rollback to savepoint attempt')
  expect((await db.query('select * from nhis_claims where id=$1', [claim])).rows).toEqual([])
  expect((await db.query('select * from deleted_records')).rows).toHaveLength(1)
})
