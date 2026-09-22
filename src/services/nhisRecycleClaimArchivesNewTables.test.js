// @vitest-environment node
// recycle_nhis_claim previously failed with a raw foreign key violation for any
// claim that had a row in nhis_claim_signatures, nhis_cxf_events or
// nhis_claim_remediation (added 2026-09-20, after the function's last update).
// This checks the fix archives and restores them, and that the two deliberate
// protections (inventory ledger, inventory policy baseline) still block deletion.
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, afterEach, expect, it } from 'vitest'

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
    create table organizations (id uuid primary key);
    create table nhis_claims (id uuid primary key, organization_id uuid, claim_number text);
    create table nhis_claim_medicines (id uuid primary key, claim_id uuid references nhis_claims(id), created_at timestamptz default now());
    create table nhis_claim_services (like nhis_claim_medicines including all);
    create table drugs (id uuid primary key, organization_id uuid, status text, quantity numeric, updated_at timestamptz);
    create table deleted_records (id uuid primary key default gen_random_uuid(), organization_id uuid, entity_type text, entity_id uuid, display_name text, snapshot jsonb, deleted_by uuid, deleted_at timestamptz default now(), unique(organization_id,entity_type,entity_id));
    create table nhis_serving_events (id uuid primary key, organization_id uuid, claim_id uuid not null references nhis_claims(id) on delete restrict, idempotency_key text, payload_hash text, created_at timestamptz default now(), unique(organization_id,idempotency_key));
    create table nhis_inventory_ledger (id uuid primary key default gen_random_uuid(), claim_id uuid not null references nhis_claims(id) on delete restrict, serving_event_id uuid not null references nhis_serving_events(id) on delete restrict, quantity_delta numeric);
    create table nhis_inventory_policy_activations (id uuid primary key default gen_random_uuid());
    create table nhis_inventory_policy_activation_baselines (activation_id uuid not null references nhis_inventory_policy_activations(id) on delete restrict, claim_id uuid not null references nhis_claims(id) on delete restrict, claim_medicine_key text not null, served_quantity numeric not null, primary key (activation_id, claim_id, claim_medicine_key));
    create table nhis_claim_signatures (id uuid primary key default gen_random_uuid(), claim_id uuid not null references nhis_claims(id) on delete restrict, organization_id uuid not null, claim_fingerprint text not null, status text not null default 'VALID', signed_on timestamptz not null default now(), signed_by_user_id uuid not null, signed_by_name text not null, signed_by_role text not null, reason text not null, unique(claim_id, claim_fingerprint));
    create table nhis_cxf_events (id uuid primary key default gen_random_uuid(), organization_id uuid not null, claim_id uuid not null references nhis_claims(id) on delete restrict, actor_id uuid not null, event_type text not null, reason text, signature_id uuid references nhis_claim_signatures(id) on delete restrict, serializer_version text, compatibility_profile text, artifact_sha256 text, details jsonb not null default '{}', created_at timestamptz not null default now());
    create table nhis_claim_remediation (claim_id uuid primary key references nhis_claims(id) on delete restrict, organization_id uuid not null, reasons text[] not null, reviewed_at timestamptz not null default now(), reviewed_by uuid not null);
    insert into users values ('${user}','${org}','admin','{}',false,true);
    insert into organizations values ('${org}');
    insert into nhis_claims values ('${claim}','${org}','NHIS-TEST');
    insert into nhis_claim_medicines(id,claim_id) values(gen_random_uuid(),'${claim}');
    insert into nhis_claim_services(id,claim_id) values(gen_random_uuid(),'${claim}');
    insert into nhis_serving_events values('${event}','${org}','${claim}','original-key','original-hash','2026-09-15T12:00:00Z');
  `)
  await db.exec(await readFile(new URL('../../supabase/migrations/20260916060000_fix_nhis_recycle_serving_events.sql', import.meta.url), 'utf8'))
  await db.exec(await readFile(new URL('../../supabase/migrations/20260922090000_recycle_claim_archives_signing_and_cxf_events.sql', import.meta.url), 'utf8'))
}, 30000)
afterAll(async () => { await db?.close() })
beforeEach(async () => { await db.exec('begin') })
afterEach(async () => { await db.exec('rollback') })

it('recycles and restores a claim that has signatures, cxf events and a remediation row (the exact reported failure)', async () => {
  const sig = '50000000-0000-4000-8000-000000000001'
  await db.exec(`
    insert into nhis_claim_signatures(id, claim_id, organization_id, claim_fingerprint, signed_by_user_id, signed_by_name, signed_by_role, reason)
      values ('${sig}', '${claim}', '${org}', 'fp-1', '${user}', 'Test Signer', 'admin', 'export');
    insert into nhis_cxf_events(organization_id, claim_id, actor_id, event_type, signature_id, serializer_version)
      values ('${org}', '${claim}', '${user}', 'export', '${sig}', 'v1');
    insert into nhis_claim_remediation(claim_id, organization_id, reasons, reviewed_by)
      values ('${claim}', '${org}', array['duplicate'], '${user}');
  `)
  const result = await recycle()
  expect((await db.query('select * from nhis_claims')).rows).toEqual([])
  expect((await db.query('select * from nhis_cxf_events')).rows).toEqual([])
  expect((await db.query('select * from nhis_claim_signatures')).rows).toEqual([])
  expect((await db.query('select * from nhis_claim_remediation')).rows).toEqual([])
  const snapshot = (await db.query('select snapshot from deleted_records')).rows[0].snapshot
  expect(snapshot.cxf_events).toHaveLength(1)
  expect(snapshot.signatures[0]).toMatchObject({ id: sig, claim_fingerprint: 'fp-1' })
  expect(snapshot.remediation[0]).toMatchObject({ reasons: ['duplicate'] })

  await restore(result.id)
  expect((await db.query('select * from nhis_claims')).rows).toHaveLength(1)
  expect((await db.query('select * from nhis_cxf_events')).rows).toHaveLength(1)
  expect((await db.query('select * from nhis_claim_signatures')).rows).toHaveLength(1)
  expect((await db.query('select * from nhis_claim_remediation')).rows).toHaveLength(1)
  expect((await db.query('select * from deleted_records')).rows).toEqual([])
})

it('still rejects a claim with inventory ledger movements', async () => {
  await db.exec(`insert into nhis_inventory_ledger(claim_id,serving_event_id,quantity_delta) values('${claim}','${event}',-2); savepoint attempt`)
  await expect(recycle()).rejects.toThrow('recorded inventory movements')
  await db.exec('rollback to savepoint attempt')
})

it('still rejects a claim with an inventory policy activation baseline', async () => {
  const activation = '60000000-0000-4000-8000-000000000001'
  await db.exec(`
    insert into nhis_inventory_policy_activations(id) values ('${activation}');
    insert into nhis_inventory_policy_activation_baselines(activation_id, claim_id, claim_medicine_key, served_quantity)
      values ('${activation}', '${claim}', 'PARA-500', 10);
    savepoint attempt
  `)
  await expect(recycle()).rejects.toThrow('inventory policy baseline')
  await db.exec('rollback to savepoint attempt')
})

it('recycles a claim with none of the newer tables populated (the original, already-working case)', async () => {
  const result = await recycle()
  expect((await db.query('select * from nhis_claims')).rows).toEqual([])
  await restore(result.id)
  expect((await db.query('select * from nhis_claims')).rows).toHaveLength(1)
})
