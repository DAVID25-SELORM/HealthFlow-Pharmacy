// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, afterEach, expect, it } from 'vitest'

let db
const user = '10000000-0000-4000-8000-000000000001'
const org = '20000000-0000-4000-8000-000000000001'
const claim = '30000000-0000-4000-8000-000000000001'
const event = '40000000-0000-4000-8000-000000000001'
const drug = '70000000-0000-4000-8000-000000000001'
const recycle = async () => (await db.query('select recycle_nhis_claim($1) as result', [claim])).rows[0].result
const restore = async (id) => db.query('select restore_deleted_record($1)', [id])

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role authenticated; create role anon;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select '${user}'::uuid $$;
    create table users (id uuid primary key, organization_id uuid, role text, assigned_roles text[], can_delete_nhis_claims boolean, is_active boolean);
    create table organizations (id uuid primary key);
    create table pharmacy_settings (organization_id uuid);
    create table nhis_claims (id uuid primary key, organization_id uuid, claim_number text, branch_id uuid);
    create table nhis_claim_medicines (id uuid primary key, claim_id uuid references nhis_claims(id), created_at timestamptz default now(), nhis_drug_id uuid, drug_code text, served_qty numeric);
    create table nhis_claim_services (like nhis_claim_medicines including all);
    create table branches (id uuid primary key);
    create table auth.users (id uuid primary key);
    create table drugs (id uuid primary key, organization_id uuid, status text, quantity numeric, updated_at timestamptz, branch_id uuid);
    create table deleted_records (id uuid primary key default gen_random_uuid(), organization_id uuid, entity_type text, entity_id uuid, display_name text, snapshot jsonb, deleted_by uuid, deleted_at timestamptz default now(), unique(organization_id,entity_type,entity_id));
create table if not exists public.nhis_serving_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  branch_id uuid references public.branches(id) on delete restrict,
  claim_id uuid not null references public.nhis_claims(id) on delete restrict,
  idempotency_key text not null,
  source text not null check (source in ('cloud_serve', 'cloud_direct_serve', 'branch_offline_sync')),
  actor_user_id uuid references auth.users(id) on delete set null,
  payload_hash text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);

create index if not exists idx_nhis_serving_events_claim_created
  on public.nhis_serving_events (claim_id, created_at desc);

create table if not exists public.nhis_inventory_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  branch_id uuid references public.branches(id) on delete restrict,
  claim_id uuid not null references public.nhis_claims(id) on delete restrict,
  serving_event_id uuid not null references public.nhis_serving_events(id) on delete restrict,
  inventory_drug_id uuid not null references public.drugs(id) on delete restrict,
  claim_medicine_key text not null,
  quantity_delta numeric not null check (quantity_delta <> 0),
  movement_type text not null check (movement_type in ('nhis_dispensing', 'nhis_dispensing_reversal')),
  reversal_of_ledger_id uuid references public.nhis_inventory_ledger(id) on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (serving_event_id, inventory_drug_id, claim_medicine_key)
);

create index if not exists idx_nhis_inventory_ledger_claim_created
  on public.nhis_inventory_ledger (claim_id, created_at desc);
create index if not exists idx_nhis_inventory_ledger_drug_created
  on public.nhis_inventory_ledger (inventory_drug_id, created_at desc);

alter table public.nhis_serving_events enable row level security;
alter table public.nhis_inventory_ledger enable row level security;
revoke all on public.nhis_serving_events, public.nhis_inventory_ledger from public, anon, authenticated;

comment on table public.nhis_serving_events is
  'Immutable, tenant-scoped idempotency boundary for cloud and offline NHIS serving.';
comment on table public.nhis_inventory_ledger is
  'Immutable NHIS inventory effects. Corrections must add compensating rows; they never rewrite history.';

    create table nhis_inventory_policy_activations (id uuid primary key default gen_random_uuid(), organization_id uuid, enabled_at timestamptz default now());
    create table nhis_inventory_policy_activation_baselines (activation_id uuid not null references nhis_inventory_policy_activations(id) on delete restrict, claim_id uuid not null references nhis_claims(id) on delete restrict, claim_medicine_key text not null, served_quantity numeric not null, primary key (activation_id, claim_id, claim_medicine_key));
    create table nhis_claim_signatures (id uuid primary key default gen_random_uuid(), claim_id uuid not null references nhis_claims(id) on delete restrict, organization_id uuid not null, claim_fingerprint text not null, status text not null default 'VALID', signed_on timestamptz not null default now(), signed_by_user_id uuid not null, signed_by_name text not null, signed_by_role text not null, reason text not null, unique(claim_id, claim_fingerprint));
    create table nhis_cxf_events (id uuid primary key default gen_random_uuid(), organization_id uuid not null, claim_id uuid not null references nhis_claims(id) on delete restrict, actor_id uuid not null, event_type text not null, reason text, signature_id uuid references nhis_claim_signatures(id) on delete restrict, serializer_version text, compatibility_profile text, artifact_sha256 text, details jsonb not null default '{}', created_at timestamptz not null default now());
    create table nhis_claim_remediation (claim_id uuid primary key references nhis_claims(id) on delete restrict, organization_id uuid not null, reasons text[] not null, reviewed_at timestamptz not null default now(), reviewed_by uuid not null);
    insert into users values ('${user}','${org}','admin','{}',false,true);
    insert into organizations values ('${org}');
    insert into nhis_claims values ('${claim}','${org}','NHIS-TEST',null);
    insert into nhis_claim_medicines(id,claim_id) values(gen_random_uuid(),'${claim}');
    insert into nhis_claim_services(id,claim_id) values(gen_random_uuid(),'${claim}');
    insert into auth.users values ('${user}');
    insert into nhis_serving_events(id,organization_id,claim_id,idempotency_key,payload_hash,source) values('${event}','${org}','${claim}','original-key','original-hash','cloud_direct_serve');
    create table stock_movements (id uuid default gen_random_uuid(), drug_id uuid, movement_type text, source_type text, quantity numeric, previous_quantity numeric, new_quantity numeric, reference_id uuid, notes text, created_by uuid, organization_id uuid, branch_id uuid, created_at timestamptz);
    insert into drugs(id,organization_id,status,quantity) values ('${drug}','${org}','active',90);
  `)
  await db.exec(await readFile(new URL('../../supabase/migrations/20260916060000_fix_nhis_recycle_serving_events.sql', import.meta.url), 'utf8'))
  await db.exec(await readFile(new URL('../../supabase/migrations/20260922090000_recycle_claim_archives_signing_and_cxf_events.sql', import.meta.url), 'utf8'))
  const guard = await readFile('supabase/migrations/20260907105000_guard_nhis_inventory_medicine_corrections.sql', 'utf8')
  await db.exec(guard.slice(0, guard.indexOf('create or replace function public.serve_nhis_claim_medicines')))
  await db.exec(await readFile('supabase/migrations/20261003100000_restore_stock_when_recycling_nhis_claim.sql', 'utf8'))
  await db.exec(await readFile('supabase/migrations/20261003110000_fix_nhis_restore_settings_lock.sql', 'utf8'))
  // Exercise recycling with the actual coverage guards installed as well.
  await db.exec(`
    create function user_organization_id() returns uuid language sql as $$ select '${org}'::uuid $$;
    alter table organizations add column name text;
    alter table nhis_claims add column member_no text, add column hin text,
      add column service_date_from date, add column status text;
    alter table nhis_claim_medicines add column description text, add column dispensary_date date,
      add column served_at timestamptz, add column prescribed_qty numeric, add column dispensed_qty numeric,
      add column serving_status text, add column dose text, add column frequency text, add column duration text;
    create table nhis_drugs(id uuid,organization_id uuid,code text,generic_name text,strength text,dosage_form text,description text);
    create function nhis_medicine_dispensing_date(date,timestamptz,date) returns date language sql immutable as $$
      select coalesce($1,($2 at time zone 'Africa/Accra')::date,$3) $$;
    create function nhis_medicine_date_quality_warning(date,timestamptz,date) returns text language sql immutable as $$ select null::text $$;
  `)
  await db.exec(await readFile('src/services/fixtures/nhis-overlap-production-20261003.sql','utf8'))
  for (const migration of [
    '20261002110000_check_coverage_before_nhis_serving.sql',
    '20261003120000_require_identity_for_nhis_coverage.sql',
    '20261003130000_fix_nhis_overlap_caller_membership.sql',
    '20261003140000_align_nhis_serving_coverage_dates.sql',
    '20261003150000_recheck_nhis_coverage_on_claim_edit.sql',
    '20261003160000_lock_all_nhis_coverage_identifiers.sql',
    '20261003170000_complete_nhis_coverage_guards.sql'
  ]) await db.exec(await readFile('supabase/migrations/'+migration,'utf8'))
}, 60000)
afterAll(async () => { await db?.close() })
beforeEach(async () => { await db.exec('begin') })
afterEach(async () => { await db.exec('rollback') })

const seedDeduction = async (quantity = 10, item = drug, key = 'MED-A') => db.query(`
  insert into nhis_inventory_ledger(organization_id,claim_id,serving_event_id,inventory_drug_id,
    claim_medicine_key,quantity_delta,movement_type,actor_user_id)
  values($1,$2,$3,$4,$5,$6,'nhis_dispensing',$7)`, [org, claim, event, item, key, -quantity, user])
const stock = async () => Number((await db.query('select quantity from drugs where id=$1', [drug])).rows[0].quantity)
const fails = async (run, message) => {
  await db.exec('savepoint attempt')
  await expect(run()).rejects.toThrow(message)
  await db.exec('rollback to savepoint attempt')
}

it('returns only deducted quantities to the exact item and records actor and both balances', async () => {
  await seedDeduction()
  const original = (await db.query('select * from nhis_inventory_ledger')).rows[0]
  await recycle()
  expect(await stock()).toBe(100)
  expect((await db.query('select * from nhis_claims')).rows).toEqual([])
  expect((await db.query('select * from nhis_inventory_ledger where id=$1', [original.id])).rows[0]).toEqual(original)
  expect((await db.query('select * from stock_movements')).rows[0]).toMatchObject({
    movement_type: 'return', quantity: '10', previous_quantity: '90', new_quantity: '100', created_by: user,
  })
  expect((await db.query('select sum(quantity_delta) as net from nhis_inventory_ledger')).rows[0].net).toBe('0')
})

it('restores the claim and deducts exactly the returned quantities, including repeated cycles', async () => {
  await seedDeduction()
  for (let i = 0; i < 3; i += 1) {
    const bin = await recycle()
    expect(await stock()).toBe(100)
    await fails(recycle, 'not found')
    expect(await stock()).toBe(100)
    await restore(bin.id)
    expect(await stock()).toBe(90)
    await fails(() => restore(bin.id), 'not found')
    expect(await stock()).toBe(90)
  }
  expect((await db.query('select * from nhis_inventory_ledger')).rows).toHaveLength(7)
})

it('does not invent stock for historic served quantities or policy baselines', async () => {
  await db.exec(`insert into nhis_inventory_policy_activations(id,organization_id) values('${org}','${org}');
    insert into nhis_inventory_policy_activation_baselines values('${org}','${claim}','MED-A',50)`)
  const bin = await recycle()
  expect(await stock()).toBe(90)
  await restore(bin.id)
  expect(await stock()).toBe(90)
  expect((await db.query('select served_quantity from nhis_inventory_policy_activation_baselines')).rows[0].served_quantity).toBe('50')
  expect((await db.query('select * from stock_movements')).rows).toEqual([])
})

it('compensates net deductions after a prior partial reversal', async () => {
  await seedDeduction()
  await db.exec(`insert into nhis_serving_events(id,organization_id,claim_id,idempotency_key,source,payload_hash)
    values('${drug}','${org}','${claim}','partial','cloud_serve','partial');
    insert into nhis_inventory_ledger(organization_id,claim_id,serving_event_id,inventory_drug_id,claim_medicine_key,quantity_delta,movement_type)
    values('${org}','${claim}','${drug}','${drug}','MED-A',4,'nhis_dispensing_reversal');
    update drugs set quantity=94`)
  const bin = await recycle()
  expect(await stock()).toBe(100)
  await restore(bin.id)
  expect(await stock()).toBe(94)
})

it('rolls back every restored row and movement when stock is insufficient', async () => {
  await seedDeduction()
  const bin = await recycle()
  await db.exec('update drugs set quantity=2')
  await fails(() => restore(bin.id), 'insufficient stock')
  expect(await stock()).toBe(2)
  expect((await db.query('select * from nhis_claims')).rows).toEqual([])
  expect((await db.query('select * from deleted_records')).rows).toHaveLength(1)
  expect((await db.query('select * from nhis_inventory_ledger')).rows).toHaveLength(2)
})

it('requires active original stock when restoring, while allowing returns to an inactive item', async () => {
  await seedDeduction()
  await db.exec("update drugs set status='inactive'")
  const bin = await recycle()
  expect(await stock()).toBe(100)
  await fails(() => restore(bin.id), 'inactive')
})

it('preserves history after the recycle-bin snapshot is permanently removed', async () => {
  await seedDeduction()
  await recycle()
  await db.exec('delete from deleted_records')
  expect(await stock()).toBe(100)
  expect((await db.query('select * from nhis_inventory_ledger')).rows).toHaveLength(2)
  expect((await db.query('select * from nhis_serving_events')).rows).toHaveLength(2)
})

it('rejects unauthorized and cross-organization deletion without changing stock', async () => {
  await seedDeduction()
  await db.exec("update users set role='assistant'")
  await fails(recycle, 'permission')
  await db.exec(`update users set role='admin',organization_id='${drug}'`)
  await fails(recycle, 'permission')
  expect(await stock()).toBe(90)
})

it('blocks raw parent deletion from bypassing the stock return workflow', async () => {
  await seedDeduction()
  await fails(() => db.exec(`delete from nhis_claims where id='${claim}'`), 'Recycle Bin workflow')
})

it('does not expose private stock functions to authenticated clients', async () => {
  const { rows } = await db.query(`select has_function_privilege('authenticated',
    'apply_nhis_recycle_stock(uuid,uuid)', 'execute') as allowed`)
  expect(rows[0].allowed).toBe(false)
})

it('preserves historic stock-neutral quantities if inventory policy is enabled while archived', async () => {
  await db.exec("update nhis_claim_medicines set drug_code='MED-A',served_qty=30")
  await seedDeduction(10)
  const bin = await recycle()
  await db.exec(`insert into nhis_inventory_policy_activations(id,organization_id) values('${org}','${org}')`)
  await restore(bin.id)
  expect(await stock()).toBe(90)
  expect((await db.query('select served_quantity from nhis_inventory_policy_activation_baselines')).rows[0].served_quantity).toBe('20')
})

it('returns split batches independently and rolls back the first deduction if the second batch is short', async () => {
  const other = '80000000-0000-4000-8000-000000000001'
  await db.exec(`insert into drugs(id,organization_id,status,quantity) values('${other}','${org}','active',5)`)
  await seedDeduction(10)
  await seedDeduction(3, other)
  const bin = await recycle()
  expect(await stock()).toBe(100)
  expect(Number((await db.query('select quantity from drugs where id=$1', [other])).rows[0].quantity)).toBe(8)
  await db.query('update drugs set quantity=1 where id=$1', [other])
  await fails(() => restore(bin.id), 'insufficient stock')
  expect(await stock()).toBe(100)
  expect((await db.query('select * from stock_movements')).rows).toHaveLength(2)
})

it('rolls back stock returns when a later claim archive step fails', async () => {
  await seedDeduction()
  await db.exec(`create table unhandled_dependency(claim_id uuid references nhis_claims(id));
    insert into unhandled_dependency values('${claim}')`)
  await fails(recycle, 'foreign key')
  expect(await stock()).toBe(90)
  expect((await db.query('select * from deleted_records')).rows).toEqual([])
  expect((await db.query('select * from stock_movements')).rows).toEqual([])
})

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

it('recycles and restores a supplied claim with every coverage guard installed', async () => {
  await db.exec(`update nhis_claims set member_no='12345678',service_date_from='2026-09-07',status='served';
    update nhis_claim_medicines set drug_code='MED-A',served_qty=10,dispensed_qty=10,
      serving_status='fully_served',dose='1',frequency='BD',duration='5 days' where claim_id='${claim}'`)
  await seedDeduction()
  const bin=await recycle()
  expect(await stock()).toBe(100)
  await restore(bin.id)
  expect(await stock()).toBe(90)
})
it('rolls back restoration and stock deduction if another supply now overlaps', async () => {
  await db.exec(`update nhis_claims set member_no='12345678',service_date_from='2026-09-07',status='served';
    update nhis_claim_medicines set drug_code='MED-A',served_qty=10,dispensed_qty=10,
      serving_status='fully_served',dose='1',frequency='BD',duration='5 days' where claim_id='${claim}'`)
  await seedDeduction()
  const bin=await recycle()
  await db.exec(`insert into nhis_claims(id,organization_id,member_no,service_date_from,status)
    values('30000000-0000-4000-8000-000000000002','${org}','12345678','2026-09-07','served');
    insert into nhis_claim_medicines(id,claim_id,drug_code,served_qty,serving_status,dose,frequency,duration)
    values(gen_random_uuid(),'30000000-0000-4000-8000-000000000002','MED-A',10,'fully_served','1','BD','5 days')`)
  await fails(()=>restore(bin.id),'Cannot serve')
  expect(await stock()).toBe(100)
  expect((await db.query('select id from deleted_records where id=$1',[bin.id])).rows).toHaveLength(1)
})
