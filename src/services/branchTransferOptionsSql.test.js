// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, expect, it } from 'vitest'

const org = '00000000-0000-0000-0000-0000000000a1'
const otherOrg = '00000000-0000-0000-0000-0000000000a2'
const orgLevel = '00000000-0000-0000-0000-0000000000b1' // no branch on profile
const branchBound = '00000000-0000-0000-0000-0000000000b2'
const nobody = '00000000-0000-0000-0000-0000000000b3'
const branch = {
  a: '00000000-0000-0000-0000-0000000000c1', // where stock is needed
  b: '00000000-0000-0000-0000-0000000000c2',
  c: '00000000-0000-0000-0000-0000000000c3',
  closed: '00000000-0000-0000-0000-0000000000c4', // inactive
  foreign: '00000000-0000-0000-0000-0000000000c5', // other organization
}
const drug = (n) => `00000000-0000-0000-0000-00000000${String(n).padStart(4, '0')}`
let db

const as = (user) => db.query("select set_config('test.actor', $1, false)", [user])
const options = async (branchId, ids) => {
  const { rows } = await db.query('select * from get_branch_transfer_options($1::uuid, $2::uuid[])', [branchId, ids])
  return rows
}
const addDrug = (id, orgId, branchId, name, quantity, reorder, extra = {}) =>
  db.query(
    `insert into drugs (id, organization_id, branch_id, name, batch_number, quantity, reorder_level, expiry_date, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, orgId, branchId, name, extra.batch ?? 'B1', quantity, reorder, extra.expiry ?? null, extra.status ?? 'active'],
  )

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.actor', true), '')::uuid $$;
    create function public.user_organization_id() returns uuid language sql stable as $$ select '${org}'::uuid $$;
    create table organizations (id uuid primary key);
    create table branches (id uuid primary key, organization_id uuid, name varchar(255), is_active boolean default true, is_main boolean default false);
    create table users (id uuid primary key, organization_id uuid, role text, branch_id uuid, is_active boolean default true,
      can_approve_purchases boolean default false, can_manage_purchases boolean default false);
    create table drugs (id uuid primary key, organization_id uuid, branch_id uuid, name text, batch_number text,
      quantity numeric default 0, reorder_level numeric, expiry_date date, status text default 'active');
    insert into organizations values ('${org}'), ('${otherOrg}');
    insert into branches (id, organization_id, name, is_active) values
      ('${branch.a}', '${org}', 'Accra Main', true), ('${branch.b}', '${org}', 'Kumasi', true),
      ('${branch.c}', '${org}', 'Tema', true), ('${branch.closed}', '${org}', 'Closed Branch', false),
      ('${branch.foreign}', '${otherOrg}', 'Foreign Branch', true);
    insert into users (id, organization_id, role, branch_id, can_manage_purchases) values
      ('${orgLevel}', '${org}', 'admin', null, false),
      ('${branchBound}', '${org}', 'admin', '${branch.a}', false),
      ('${nobody}', '${org}', 'cashier', null, false);
  `)
  // user_can_manage_purchases() comes from the lifecycle migration, whose tables it also needs.
  await db.exec(`
    create table suppliers (id uuid primary key);
    create table stock_movements (id uuid primary key default gen_random_uuid(), drug_id uuid, movement_type text, quantity numeric,
      previous_quantity numeric, new_quantity numeric, reference_id uuid, notes text, created_by uuid, organization_id uuid, created_at timestamptz);
    create table purchases (id uuid primary key, organization_id uuid not null default '${org}', purchase_number text not null,
      supplier_id uuid references suppliers(id), supplier_name text, invoice_number text, total_amount numeric not null default 0,
      status text not null default 'draft' check (status in ('draft', 'completed', 'cancelled')), notes text, updated_at timestamptz default now());
    create table purchase_items (id uuid primary key, purchase_id uuid not null references purchases(id) on delete cascade,
      drug_id uuid references drugs(id), drug_name text not null, brand_name text, generic_name text, sale_on_return boolean not null default false,
      quantity numeric(10,2) not null, unit text default 'unit', unit_cost numeric(10,2) not null default 0, net_total numeric(12,2) not null default 0,
      batch_number text, expiry_date date);
    create function public.log_audit_event(p_event_type text, p_entity_type text, p_entity_id uuid, p_action text,
      p_details jsonb default '{}', p_organization_id uuid default null) returns void language sql as $$ select $$;
  `)
  await db.exec("alter table drugs add column brand_name text, add column generic_name text, add column sale_on_return boolean default false, add column cost_price numeric default 0, add column updated_at timestamptz")
  await db.exec(readFileSync('supabase/migrations/20260615143500_enforce_purchase_approval_privilege.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20260923100000_purchase_order_lifecycle.sql', 'utf8'))
  const migration = readFileSync('supabase/migrations/20260923120000_branch_transfer_options.sql', 'utf8')
  await db.exec(migration)
  await db.exec(migration) // replay-safe

  // The medicine that is short in Accra Main.
  await addDrug(drug(1), org, branch.a, 'Amoxicillin 500mg', 2, 20)
  // Elsewhere in the organization:
  await addDrug(drug(2), org, branch.b, 'amoxicillin 500mg ', 90, 20) // same medicine, different case/spacing: 70 spare
  await addDrug(drug(3), org, branch.c, 'Amoxicillin 500mg', 35, 20, { batch: 'B9', expiry: '2099-01-01' }) // 15 spare
  await addDrug(drug(4), org, branch.b, 'Amoxicillin 500mg', 20, 20, { batch: 'AT-THRESHOLD' }) // exactly at threshold: 0 spare
  await addDrug(drug(5), org, branch.c, 'Amoxicillin 500mg', 10, 20, { batch: 'LOW' }) // itself low
  await addDrug(drug(6), org, branch.b, 'Amoxicillin 500mg', 500, 20, { batch: 'EXPIRED', expiry: '2020-01-01' }) // expired: never offered
  await addDrug(drug(7), org, branch.b, 'Amoxicillin 500mg', 500, 20, { batch: 'INACTIVE', status: 'inactive' })
  await addDrug(drug(8), org, branch.closed, 'Amoxicillin 500mg', 500, 20, { batch: 'CLOSED' }) // inactive branch
  await addDrug(drug(9), otherOrg, branch.foreign, 'Amoxicillin 500mg', 500, 20, { batch: 'FOREIGN' }) // another organization
  await addDrug(drug(10), org, branch.b, 'Paracetamol 500mg', 400, 20) // a different medicine
  await addDrug(drug(11), org, branch.a, 'Amoxicillin 500mg', 3, 20, { batch: 'SAME-BRANCH' }) // same branch as the need
}, 60000)
afterAll(async () => { await db?.close() })

it('offers spare stock from other branches, largest first, with the branch, batch and expiry', async () => {
  await as(orgLevel)
  const rows = await options(branch.a, [drug(1)])
  expect(rows.map((r) => [r.source_branch_name, Number(r.spare_quantity)])).toEqual([['Kumasi', 70], ['Tema', 15]])
  expect(rows[0]).toMatchObject({ target_drug_id: drug(1), source_drug_id: drug(2), source_branch_id: branch.b })
  expect(Number(rows[0].source_quantity)).toBe(90)
  expect(rows[1]).toMatchObject({ batch_number: 'B9' })
})

it('matches the same medicine regardless of case and spacing', async () => {
  await as(orgLevel)
  const rows = await options(branch.a, [drug(1)])
  expect(rows.some((r) => r.source_drug_id === drug(2))).toBe(true)
})

it('never offers stock at or below the source branch\'s own reorder level', async () => {
  await as(orgLevel)
  const sources = (await options(branch.a, [drug(1)])).map((r) => r.source_drug_id)
  expect(sources).not.toContain(drug(4)) // exactly at threshold
  expect(sources).not.toContain(drug(5)) // below it
})

it('never offers expired, inactive, closed-branch, other-organization, other-medicine or same-branch stock', async () => {
  await as(orgLevel)
  const sources = (await options(branch.a, [drug(1)])).map((r) => r.source_drug_id)
  for (const excluded of [6, 7, 8, 9, 10, 11]) expect(sources).not.toContain(drug(excluded))
})

it('returns nothing for a medicine that no other branch has spare', async () => {
  await as(orgLevel)
  await addDrug(drug(20), org, branch.a, 'Rare Medicine', 0, 10)
  expect(await options(branch.a, [drug(20)])).toEqual([])
})

it('ignores drug ids that are not in the chosen branch (cannot be used to probe other rows)', async () => {
  await as(orgLevel)
  expect(await options(branch.b, [drug(1)])).toEqual([]) // drug(1) belongs to Accra, not Kumasi
})

it('gives nothing to staff tied to a single branch, who never see other branches\' stock', async () => {
  await as(branchBound)
  expect(await options(branch.a, [drug(1)])).toEqual([])
})

it('only someone who can manage purchases may ask', async () => {
  await as(nobody)
  await expect(options(branch.a, [drug(1)])).rejects.toThrow(/permission/)
})

it('rejects a missing branch, and a branch outside the organization', async () => {
  await as(orgLevel)
  await expect(options(null, [drug(1)])).rejects.toThrow(/Choose a branch/)
  await expect(options(branch.foreign, [drug(1)])).rejects.toThrow(/could not be found/)
})

it('is read-only: it changes no stock', async () => {
  await as(orgLevel)
  const before = (await db.query('select id, quantity from drugs order by id')).rows
  await options(branch.a, [drug(1)])
  expect((await db.query('select id, quantity from drugs order by id')).rows).toEqual(before)
})

it('is executable by signed-in users but not anonymously', async () => {
  const grants = (await db.query(
    "select grantee from information_schema.routine_privileges where routine_name='get_branch_transfer_options'",
  )).rows.map((row) => row.grantee)
  expect(grants).toContain('authenticated')
  expect(grants).not.toContain('anon')
})
