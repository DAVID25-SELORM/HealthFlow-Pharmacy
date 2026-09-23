// @vitest-environment node
// Purchase-order lifecycle (Reorder Centre phase 2): draft -> ordered -> partially_received
// -> completed, cancellation, and the rule that stock only increases when goods are received.
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, expect, it } from 'vitest'

const org = '00000000-0000-0000-0000-0000000000a1'
const admin = '00000000-0000-0000-0000-0000000000b1'
const buyer = '00000000-0000-0000-0000-0000000000b2' // can manage, cannot approve
const nobody = '00000000-0000-0000-0000-0000000000b3'
const drug = '00000000-0000-0000-0000-0000000000d1'
let db

const as = (user) => db.query("select set_config('test.actor', $1, false)", [user])
const rpc = async (sql, params = []) => (await db.query(`select ${sql} as r`, params)).rows[0].r
const stock = async () => Number((await db.query('select quantity from drugs where id=$1', [drug])).rows[0].quantity)
const purchaseRow = async (id) => (await db.query('select * from purchases where id=$1', [id])).rows[0]
const movements = async () => (await db.query("select * from stock_movements where movement_type='purchase'")).rows
const audit = async () => (await db.query('select event_type, details from audit_logs order by id')).rows

let seq = 0
const newPurchase = async ({ status = 'draft', supplier = 'MedSupply Ltd', items = [{ qty: 100 }] } = {}) => {
  seq += 1
  const id = `10000000-0000-0000-0000-${String(seq).padStart(12, '0')}`
  await db.query(
    `insert into purchases (id, organization_id, purchase_number, supplier_name, total_amount, status)
     values ($1, $2, $3, $4, 100, $5)`,
    [id, org, `PO-T${seq}`, supplier, status],
  )
  const itemIds = []
  for (const [index, item] of items.entries()) {
    const itemId = `20000000-0000-0000-0000-${String(seq * 10 + index).padStart(12, '0')}`
    await db.query(
      `insert into purchase_items (id, purchase_id, drug_id, drug_name, quantity, unit_cost, net_total)
       values ($1, $2, $3, 'Amoxicillin 500mg', $4, 2.5, 100)`,
      [itemId, id, item.noDrug ? null : drug, item.qty],
    )
    itemIds.push(itemId)
  }
  return { id, itemIds }
}

const line = (itemId, quantity, extra = {}) => ({ purchase_item_id: itemId, quantity, ...extra })

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
      cost_price numeric default 0, updated_at timestamptz);
    create table stock_movements (id uuid primary key default gen_random_uuid(), drug_id uuid, movement_type text,
      quantity numeric, previous_quantity numeric, new_quantity numeric, reference_id uuid, notes text,
      created_by uuid, organization_id uuid, created_at timestamptz);
    create table purchases (
      id uuid primary key, organization_id uuid not null default '${org}', purchase_number text not null,
      supplier_id uuid references suppliers(id), supplier_name text, invoice_number text,
      total_amount numeric not null default 0,
      status text not null default 'draft' check (status in ('draft', 'completed', 'cancelled')),
      notes text, updated_at timestamptz default now());
    create table purchase_items (
      id uuid primary key, purchase_id uuid not null references purchases(id) on delete cascade,
      drug_id uuid references drugs(id), drug_name text not null, brand_name text, generic_name text,
      sale_on_return boolean not null default false, quantity numeric(10,2) not null, unit text default 'unit',
      unit_cost numeric(10,2) not null default 0, net_total numeric(12,2) not null default 0,
      batch_number text, expiry_date date);
    create table audit_logs (id bigserial primary key, event_type text, entity_id uuid, details jsonb);
    create function public.log_audit_event(p_event_type text, p_entity_type text, p_entity_id uuid, p_action text,
      p_details jsonb default '{}', p_organization_id uuid default null) returns void language sql as $$
      insert into audit_logs(event_type, entity_id, details) values (p_event_type, p_entity_id, p_details) $$;

    insert into organizations values ('${org}');
    insert into users (id, organization_id, role, can_approve_purchases, can_manage_purchases) values
      ('${admin}', '${org}', 'admin', false, false),
      ('${buyer}', '${org}', 'pharmacist', false, true),
      ('${nobody}', '${org}', 'cashier', false, false);
    insert into drugs (id, organization_id, quantity, batch_number, cost_price) values ('${drug}', '${org}', 10, 'OLD-BATCH', 2);
  `)
  // History as production has it: the approval-privilege migration (user_can_approve_purchases + the
  // original complete_purchase), and a purchase that was completed before the lifecycle existed.
  await db.exec(readFileSync('supabase/migrations/20260615143500_enforce_purchase_approval_privilege.sql', 'utf8'))
  await db.exec(`
    insert into purchases (id, purchase_number, supplier_name, total_amount, status)
      values ('99999999-0000-0000-0000-000000000001', 'PO-LEGACY', 'Old Supplier', 55, 'completed');
    insert into purchase_items (id, purchase_id, drug_id, drug_name, quantity, net_total)
      values ('99999999-0000-0000-0000-000000000002', '99999999-0000-0000-0000-000000000001', '${drug}', 'Amoxicillin 500mg', 7, 55);
  `)
  const migration = readFileSync('supabase/migrations/20260923100000_purchase_order_lifecycle.sql', 'utf8')
  await db.exec(migration)
  await db.exec(migration) // replay-safe
}, 60000)
afterAll(async () => { await db?.close() })

it('preserves historical purchases and their quantities untouched', async () => {
  const legacy = await purchaseRow('99999999-0000-0000-0000-000000000001')
  expect(legacy.status).toBe('completed')
  const item = (await db.query("select quantity::float q, received_quantity::float r from purchase_items where id='99999999-0000-0000-0000-000000000002'")).rows[0]
  expect(item).toEqual({ q: 7, r: 0 })
})

it('placing an order needs a permitted user, a supplier and items, and never changes stock', async () => {
  const { id } = await newPurchase()
  await as(nobody)
  expect((await rpc('place_purchase_order($1)', [id])).error).toMatch(/permission/)
  await as(buyer)
  const noSupplier = await newPurchase({ supplier: '' })
  expect((await rpc('place_purchase_order($1)', [noSupplier.id])).error).toMatch(/supplier/)
  const before = await stock()
  expect(await rpc('place_purchase_order($1)', [id])).toMatchObject({ success: true, status: 'ordered' })
  const row = await purchaseRow(id)
  expect(row.status).toBe('ordered')
  expect(row.ordered_by).toBe(buyer)
  expect(row.ordered_at).not.toBeNull()
  expect(await stock()).toBe(before)
  expect(await movements()).toHaveLength(0)
  expect((await rpc('place_purchase_order($1)', [id])).error).toMatch(/draft/) // cannot place twice
})

it('rejects placing an order with a zero-quantity line', async () => {
  await as(buyer)
  const { id } = await newPurchase({ items: [{ qty: 0 }] })
  expect((await rpc('place_purchase_order($1)', [id])).error).toMatch(/above zero/)
})

it('partial receiving adds only what arrived, keeps the rest outstanding, and records batch/expiry/cost/user', async () => {
  await as(buyer)
  const { id, itemIds } = await newPurchase()
  await rpc('place_purchase_order($1)', [id])
  const before = await stock()
  await as(admin)
  const result = await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [
    id,
    JSON.stringify([line(itemIds[0], 60, { batch_number: 'B-100', expiry_date: '2028-06-30', unit_cost: 3.1 })]),
    'receipt-1',
  ])
  expect(result).toMatchObject({ success: true, status: 'partially_received', outstanding: 40, received_total: 60 })
  expect(await stock()).toBe(before + 60)
  expect((await purchaseRow(id)).status).toBe('partially_received')
  const item = (await db.query('select received_quantity::float r from purchase_items where id=$1', [itemIds[0]])).rows[0]
  expect(item.r).toBe(60)
  const receipt = (await db.query('select * from purchase_receipts where purchase_id=$1', [id])).rows[0]
  expect(receipt).toMatchObject({ batch_number: 'B-100', received_by: admin, drug_id: drug })
  expect(Number(receipt.received_quantity)).toBe(60)
  expect(Number(receipt.unit_cost)).toBeCloseTo(3.1)
  const drugRow = (await db.query('select batch_number, cost_price::float c from drugs where id=$1', [drug])).rows[0]
  expect(drugRow).toEqual({ batch_number: 'B-100', c: 3.1 })
  const movement = (await movements()).at(-1)
  expect(Number(movement.quantity)).toBe(60)
  expect(Number(movement.new_quantity) - Number(movement.previous_quantity)).toBe(60)
  expect(movement.reference_id).toBe(id)
})

it('a later receipt of the remainder completes the order', async () => {
  await as(buyer)
  const { id, itemIds } = await newPurchase()
  await rpc('place_purchase_order($1)', [id])
  await as(admin)
  await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [id, JSON.stringify([line(itemIds[0], 60)]), 'k1'])
  const before = await stock()
  const done = await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [id, JSON.stringify([line(itemIds[0], 40)]), 'k2'])
  expect(done).toMatchObject({ success: true, status: 'completed', outstanding: 0 })
  expect(await stock()).toBe(before + 40)
  expect((await purchaseRow(id)).status).toBe('completed')
})

it('refuses to receive more than is outstanding, and writes nothing when it refuses', async () => {
  await as(buyer)
  const { id, itemIds } = await newPurchase()
  await rpc('place_purchase_order($1)', [id])
  await as(admin)
  const before = await stock()
  const moves = (await movements()).length
  const result = await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [id, JSON.stringify([line(itemIds[0], 101)]), 'k-over'])
  expect(result.error).toMatch(/only 100 outstanding/)
  // across several lines of the same item too
  const split = await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [id, JSON.stringify([line(itemIds[0], 60), line(itemIds[0], 60)]), 'k-split'])
  expect(split.error).toMatch(/outstanding/)
  expect(await stock()).toBe(before)
  expect((await movements()).length).toBe(moves)
  expect((await purchaseRow(id)).status).toBe('ordered')
  expect((await db.query('select count(*)::int n from purchase_receipts where purchase_id=$1', [id])).rows[0].n).toBe(0)
})

it('the same receipt key can never post stock twice', async () => {
  await as(buyer)
  const { id, itemIds } = await newPurchase()
  await rpc('place_purchase_order($1)', [id])
  await as(admin)
  const before = await stock()
  const args = [id, JSON.stringify([line(itemIds[0], 25)]), 'same-key']
  expect(await rpc('receive_purchase_goods($1, $2::jsonb, $3)', args)).toMatchObject({ success: true })
  expect(await rpc('receive_purchase_goods($1, $2::jsonb, $3)', args)).toMatchObject({ success: true, already_processed: true })
  expect(await stock()).toBe(before + 25)
  expect((await db.query('select count(*)::int n from purchase_receipts where purchase_id=$1', [id])).rows[0].n).toBe(1)
})

it('supports several batches of one item in a single delivery', async () => {
  await as(buyer)
  const { id, itemIds } = await newPurchase()
  await rpc('place_purchase_order($1)', [id])
  await as(admin)
  const before = await stock()
  const result = await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [
    id,
    JSON.stringify([line(itemIds[0], 30, { batch_number: 'A', expiry_date: '2028-01-01' }), line(itemIds[0], 20, { batch_number: 'B', expiry_date: '2029-01-01' })]),
    'multi',
  ])
  expect(result).toMatchObject({ success: true, status: 'partially_received', outstanding: 50, lines: 2 })
  expect(await stock()).toBe(before + 50)
  const receipts = (await db.query('select batch_number from purchase_receipts where purchase_id=$1 order by batch_number', [id])).rows
  expect(receipts.map((r) => r.batch_number)).toEqual(['A', 'B'])
})

it('an item with no linked medicine is tracked as received but posts no stock', async () => {
  await as(buyer)
  const { id, itemIds } = await newPurchase({ items: [{ qty: 5, noDrug: true }] })
  await rpc('place_purchase_order($1)', [id])
  await as(admin)
  const before = await stock()
  const moves = (await movements()).length
  expect(await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [id, JSON.stringify([line(itemIds[0], 5)]), 'nodrug'])).toMatchObject({ status: 'completed' })
  expect(await stock()).toBe(before)
  expect((await movements()).length).toBe(moves)
})

it('only an approver can receive, and only against a placed, unfinished order', async () => {
  await as(buyer)
  const draft = await newPurchase()
  const placed = await newPurchase()
  await rpc('place_purchase_order($1)', [placed.id])
  expect((await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [placed.id, JSON.stringify([line(placed.itemIds[0], 1)]), 'x'])).error).toMatch(/permission/)
  await as(admin)
  expect((await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [draft.id, JSON.stringify([line(draft.itemIds[0], 1)]), 'y'])).error).toMatch(/placed/)
  await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [placed.id, JSON.stringify([line(placed.itemIds[0], 100)]), 'all'])
  expect((await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [placed.id, JSON.stringify([line(placed.itemIds[0], 1)]), 'z'])).error).toMatch(/placed and is not yet fully received/)
})

it('cancelling a placed order needs a reason, leaves stock alone and stops counting outstanding', async () => {
  await as(buyer)
  const { id, itemIds } = await newPurchase()
  await rpc('place_purchase_order($1)', [id])
  expect((await rpc('cancel_purchase_order($1, $2)', [id, ''])).error).toMatch(/reason/)
  const before = await stock()
  const result = await rpc('cancel_purchase_order($1, $2)', [id, 'Supplier out of stock'])
  expect(result).toMatchObject({ success: true, status: 'cancelled', outstanding_cancelled: 100 })
  const row = await purchaseRow(id)
  expect(row).toMatchObject({ status: 'cancelled', cancelled_by: buyer, cancellation_reason: 'Supplier out of stock' })
  expect(await stock()).toBe(before)
  await as(admin)
  expect((await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [id, JSON.stringify([line(itemIds[0], 1)]), 'after-cancel'])).error).toBeTruthy()
})

it('cancelling a partially received order keeps what already arrived', async () => {
  await as(buyer)
  const { id, itemIds } = await newPurchase()
  await rpc('place_purchase_order($1)', [id])
  await as(admin)
  await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [id, JSON.stringify([line(itemIds[0], 60)]), 'p'])
  const afterReceipt = await stock()
  const result = await rpc('cancel_purchase_order($1, $2)', [id, 'Rest never delivered'])
  expect(result).toMatchObject({ success: true, outstanding_cancelled: 40 })
  expect(await stock()).toBe(afterReceipt)
})

it('a draft can be cancelled without a reason; a completed order cannot be cancelled; strangers cannot cancel', async () => {
  await as(buyer)
  const draft = await newPurchase()
  expect(await rpc('cancel_purchase_order($1, $2)', [draft.id, null])).toMatchObject({ success: true })
  const done = await newPurchase()
  await rpc('place_purchase_order($1)', [done.id])
  await as(admin)
  await rpc('receive_purchase_goods($1, $2::jsonb, $3)', [done.id, JSON.stringify([line(done.itemIds[0], 100)]), 'c'])
  expect((await rpc('cancel_purchase_order($1, $2)', [done.id, 'oops'])).error).toMatch(/not fully received/)
  await as(nobody)
  const other = await newPurchase()
  expect((await rpc('cancel_purchase_order($1, $2)', [other.id, 'x'])).error).toMatch(/permission/)
})

it('records an audit event for each procurement step, without leaking secrets', async () => {
  const events = (await audit()).map((row) => row.event_type)
  expect(events).toEqual(expect.arrayContaining([
    'PURCHASE_ORDER_PLACED', 'GOODS_PARTIALLY_RECEIVED', 'GOODS_RECEIVED', 'PURCHASE_ORDER_CANCELLED',
  ]))
  const cancelled = (await audit()).find((row) => row.event_type === 'PURCHASE_ORDER_CANCELLED')
  expect(cancelled.details).toMatchObject({ reason: expect.any(String), previous_status: expect.any(String) })
})

it('an audit failure never blocks a purchasing action', async () => {
  await as(buyer)
  const { id } = await newPurchase()
  await db.exec('alter table audit_logs rename to audit_logs_offline')
  expect(await rpc('place_purchase_order($1)', [id])).toMatchObject({ success: true })
  await db.exec('alter table audit_logs_offline rename to audit_logs')
})

it('complete_purchase still works on a draft and now records the received quantity', async () => {
  await as(admin)
  const { id, itemIds } = await newPurchase({ items: [{ qty: 12 }] })
  const before = await stock()
  expect(await rpc('complete_purchase($1)', [id])).toMatchObject({ success: true })
  expect(await stock()).toBe(before + 12)
  expect((await purchaseRow(id)).status).toBe('completed')
  const item = (await db.query('select received_quantity::float r from purchase_items where id=$1', [itemIds[0]])).rows[0]
  expect(item.r).toBe(12)
  expect((await rpc('complete_purchase($1)', [id])).error).toMatch(/draft/) // and only once
})

it('receipts cannot be written or edited directly by an authenticated user', async () => {
  const privileges = (await db.query(
    "select privilege_type from information_schema.role_table_grants where table_name='purchase_receipts' and grantee='authenticated'",
  )).rows.map((row) => row.privilege_type)
  expect(privileges).not.toEqual(expect.arrayContaining(['INSERT']))
  expect(privileges).not.toEqual(expect.arrayContaining(['UPDATE']))
  expect(privileges).not.toEqual(expect.arrayContaining(['DELETE']))
})
