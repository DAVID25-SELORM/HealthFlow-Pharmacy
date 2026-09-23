// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, expect, it } from 'vitest'

const org = '00000000-0000-0000-0000-0000000000a1'
const otherOrg = '00000000-0000-0000-0000-0000000000a2'
const admin = '00000000-0000-0000-0000-0000000000b1'
const nobody = '00000000-0000-0000-0000-0000000000b3'
const drugs = {
  busy: '00000000-0000-0000-0000-0000000000d1', // sells steadily, 3 purchases
  brandNew: '00000000-0000-0000-0000-0000000000d2', // created 3 days ago
  never: '00000000-0000-0000-0000-0000000000d3', // old, never sold, never bought
  foreign: '00000000-0000-0000-0000-0000000000d4', // another organization
}
let db

const as = (user) => db.query("select set_config('test.actor', $1, false)", [user])
const insights = async (ids = null) => {
  const { rows } = await db.query('select *, last_purchase_date::text as last_purchase_day from get_reorder_insights($1::uuid[])', [ids])
  return Object.fromEntries(rows.map((row) => [row.drug_id, row]))
}

const pid = (n) => `30000000-0000-0000-0000-${String(n).padStart(12, '0')}`

const purchase = async (n, { status, supplier, date, orderedAt = null, cost, drug = drugs.busy, receiptCost = null }) => {
  const id = pid(n)
  await db.query(
    `insert into purchases (id, organization_id, purchase_number, supplier_name, purchase_date, ordered_at, status, created_at)
     values ($1, $2, $3, $4, $5::date, $6::timestamptz, $7, $5::date::timestamptz)`,
    [id, org, `PO-${n}`, supplier, date, orderedAt, status],
  )
  const { rows } = await db.query(
    `insert into purchase_items (id, purchase_id, drug_id, drug_name, quantity, unit_cost)
     values (gen_random_uuid(), $1, $2, 'x', 10, $3) returning id`,
    [id, drug, cost],
  )
  if (receiptCost != null) {
    await db.query(
      `insert into purchase_receipts (organization_id, purchase_id, purchase_item_id, drug_id, receipt_key, received_quantity, unit_cost)
       values ($1, $2, $3, $4, 'k', 5, $5)`,
      [org, id, rows[0].id, drug, receiptCost],
    )
  }
}

const sale = async (id, { status = 'completed', daysAgo, quantity, drug = drugs.busy, saleOrg = org }) => {
  await db.query(
    `insert into sales (id, organization_id, payment_status, sale_date) values ($1, $2, $3, now() - make_interval(days => $4::int))`,
    [id, saleOrg, status, daysAgo],
  )
  await db.query(
    `insert into sale_items (id, organization_id, sale_id, drug_id, quantity) values (gen_random_uuid(), $1, $2, $3, $4)`,
    [saleOrg, id, drug, quantity],
  )
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.actor', true), '')::uuid $$;
    create function public.user_organization_id() returns uuid language sql stable as $$ select '${org}'::uuid $$;
    create table organizations (id uuid primary key);
    create table users (id uuid primary key, organization_id uuid, role text, is_active boolean default true,
      can_approve_purchases boolean default false, can_manage_purchases boolean default false);
    create table suppliers (id uuid primary key);
    create table drugs (id uuid primary key, organization_id uuid, quantity numeric default 0, brand_name text,
      generic_name text, sale_on_return boolean default false, batch_number text, expiry_date date,
      cost_price numeric default 0, updated_at timestamptz, created_at timestamptz default now());
    create table stock_movements (id uuid primary key default gen_random_uuid(), drug_id uuid, movement_type text,
      quantity numeric, previous_quantity numeric, new_quantity numeric, reference_id uuid, notes text,
      created_by uuid, organization_id uuid, created_at timestamptz);
    create table purchases (
      id uuid primary key, organization_id uuid not null default '${org}', purchase_number text not null,
      supplier_id uuid references suppliers(id), supplier_name text, invoice_number text, purchase_date date,
      total_amount numeric not null default 0,
      status text not null default 'draft' check (status in ('draft', 'completed', 'cancelled')),
      notes text, updated_at timestamptz default now(), created_at timestamptz default now());
    create table purchase_items (
      id uuid primary key, purchase_id uuid not null references purchases(id) on delete cascade,
      drug_id uuid references drugs(id), drug_name text not null, brand_name text, generic_name text,
      sale_on_return boolean not null default false, quantity numeric(10,2) not null, unit text default 'unit',
      unit_cost numeric(10,2) not null default 0, net_total numeric(12,2) not null default 0,
      batch_number text, expiry_date date);
    create table sales (id text primary key, organization_id uuid, payment_status text, sale_date timestamptz);
    create table sale_items (id uuid primary key, organization_id uuid, sale_id text references sales(id), drug_id uuid, quantity numeric);
    create table audit_logs (id bigserial primary key, event_type text, entity_id uuid, details jsonb);
    create function public.log_audit_event(p_event_type text, p_entity_type text, p_entity_id uuid, p_action text,
      p_details jsonb default '{}', p_organization_id uuid default null) returns void language sql as $$ select $$;
    insert into organizations values ('${org}'), ('${otherOrg}');
    insert into users (id, organization_id, role, can_manage_purchases) values
      ('${admin}', '${org}', 'admin', false), ('${nobody}', '${org}', 'cashier', false);
    insert into drugs (id, organization_id, quantity, created_at) values
      ('${drugs.busy}', '${org}', 10, now() - interval '200 days'),
      ('${drugs.brandNew}', '${org}', 10, now() - interval '3 days'),
      ('${drugs.never}', '${org}', 10, now() - interval '400 days'),
      ('${drugs.foreign}', '${otherOrg}', 10, now() - interval '200 days');
  `)
  // The lifecycle tables/functions this depends on come from the two earlier migrations.
  await db.exec(readFileSync('supabase/migrations/20260615143500_enforce_purchase_approval_privilege.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20260923100000_purchase_order_lifecycle.sql', 'utf8'))
  const migration = readFileSync('supabase/migrations/20260923110000_reorder_insights.sql', 'utf8')
  await db.exec(migration)
  await db.exec(migration) // replay-safe

  await sale('s1', { daysAgo: 5, quantity: 30 })
  await sale('s2', { daysAgo: 60, quantity: 20 })
  await sale('s-old', { daysAgo: 200, quantity: 999 }) // outside the 90-day window
  await sale('s-refunded', { status: 'refunded', daysAgo: 2, quantity: 500 })
  await sale('s-cancelled', { status: 'cancelled', daysAgo: 2, quantity: 500 })
  await sale('s-pending', { status: 'pending', daysAgo: 2, quantity: 500 })
  await sale('s-new', { daysAgo: 1, quantity: 4, drug: drugs.brandNew })
  await sale('s-foreign', { daysAgo: 1, quantity: 77, drug: drugs.foreign, saleOrg: otherOrg })

  await purchase(1, { status: 'completed', supplier: 'Old Supplier', date: '2026-06-01', cost: 39.5 })
  await purchase(2, { status: 'completed', supplier: 'MedSupply Ltd', date: '2026-08-01', cost: 42 })
  await purchase(3, { status: 'draft', supplier: 'Draft Co', date: '2026-09-15', cost: 99 })
  await purchase(4, { status: 'cancelled', supplier: 'Cancelled Co', date: '2026-09-16', cost: 88 })
  await purchase(5, { status: 'completed', supplier: 'Zero Co', date: '2026-09-17', cost: 0 })
}, 60000)
afterAll(async () => { await db?.close() })

it('counts only completed sales inside the window (not refunded, cancelled, pending or old ones)', async () => {
  await as(admin)
  const row = (await insights([drugs.busy]))[drugs.busy]
  expect(Number(row.units_sold)).toBe(50) // 30 + 20
})

it('reports how much history there is, capped at the window, so the app can say "not enough data"', async () => {
  await as(admin)
  const result = await insights()
  expect(result[drugs.busy].history_days).toBe(90)
  expect(result[drugs.brandNew].history_days).toBe(3)
  expect(Number(result[drugs.brandNew].units_sold)).toBe(4)
  expect(result[drugs.never].history_days).toBe(90)
  expect(Number(result[drugs.never].units_sold)).toBe(0) // zero is real data, not a guess
})

it('gives the last and previous purchase cost with supplier and date, ignoring drafts, cancelled and zero-cost lines', async () => {
  await as(admin)
  const row = (await insights([drugs.busy]))[drugs.busy]
  expect(Number(row.last_cost)).toBe(42)
  expect(Number(row.previous_cost)).toBe(39.5)
  expect(row.last_supplier).toBe('MedSupply Ltd')
  expect(row.last_purchase_day).toBe('2026-08-01')
})

it('prefers the cost actually paid on the latest receipt over the ordered cost', async () => {
  await as(admin)
  await purchase(6, { status: 'partially_received', supplier: 'MedSupply Ltd', date: '2026-09-10', cost: 40, receiptCost: 44.5 })
  const row = (await insights([drugs.busy]))[drugs.busy]
  expect(Number(row.last_cost)).toBe(44.5)
  expect(Number(row.previous_cost)).toBe(42)
})

it('returns no cost for a medicine that was never bought', async () => {
  await as(admin)
  const row = (await insights([drugs.never]))[drugs.never]
  expect(row.last_cost).toBeNull()
  expect(row.last_supplier).toBeNull()
})

it("never returns another organization's medicine or sales", async () => {
  await as(admin)
  const result = await insights()
  expect(Object.keys(result)).not.toContain(drugs.foreign)
  expect((await insights([drugs.foreign]))[drugs.foreign]).toBeUndefined()
})

it('only someone who can manage purchases may call it, and anonymous cannot execute it', async () => {
  await as(nobody)
  await expect(insights()).rejects.toThrow(/permission/)
  const grants = (await db.query(
    "select grantee from information_schema.routine_privileges where routine_name='get_reorder_insights'",
  )).rows.map((row) => row.grantee)
  expect(grants).toContain('authenticated')
  expect(grants).not.toContain('anon')
})
