// @vitest-environment node
// The patient's cash portion of an insurance / NHIA claim sale must reach the shift cash drawer, like a cash sale does.
// 1) The migration patches the REAL production sale functions (captured 2026-09-26): once, idempotently, and fails
//    closed on an unexpected definition.
// 2) The posting logic it inserts behaves correctly, run inside stand-in functions that share the production variable
//    names and the same cash block the migration anchors on.
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, afterEach, expect, it } from 'vitest'

const migrationUrl = new URL('../../supabase/migrations/20260926100000_record_cash_topup_in_shift_drawer.sql', import.meta.url)
const productionUrl = new URL('./fixtures/saleFunctionsProduction.sql', import.meta.url)
const stripTx = (sql) => sql.replace(/^begin;$/m, '').replace(/^commit;$/m, '')
const definition = async (db, name) =>
  (await db.query('select pg_get_functiondef($1::regprocedure) as def', [name])).rows[0].def

const shiftId = '50000000-0000-4000-8000-000000000001'
const orgId = '20000000-0000-4000-8000-000000000001'
const branchId = '30000000-0000-4000-8000-000000000001'
const userId = '10000000-0000-4000-8000-000000000001'

// A stand-in with the production variable names and the production cash block, minus everything unrelated.
const standIn = (name, args) => `
create or replace function public.${name}(${args})
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  payment_method_value text; payment_status_value text; net_amount numeric; shift_id_value uuid; sold_by_value uuid;
  insurance_top_up_value numeric; insurance_top_up_method_value text; sale_record record;
begin
  payment_method_value := lower(sale_payload->>'payment_method');
  payment_status_value := coalesce(sale_payload->>'payment_status', 'completed');
  net_amount := coalesce((sale_payload->>'net_amount')::numeric, 0);
  shift_id_value := nullif(sale_payload->>'shift_id', '')::uuid;
  sold_by_value := '${userId}'::uuid;
  insurance_top_up_value := coalesce((sale_payload->>'insurance_top_up_amount')::numeric, 0);
  insurance_top_up_method_value := lower(nullif(sale_payload->>'insurance_top_up_payment_method', ''));
  select 'S-1'::text as sale_number, gen_random_uuid() as id into sale_record;

  IF payment_method_value = 'cash'
    AND payment_status_value = 'completed'
    AND net_amount > 0
    AND shift_id_value IS NOT NULL THEN
    INSERT INTO public.shift_cash_movements (
      shift_id, organization_id, branch_id, movement_type, source_type, source_id,
      amount, direction, description, created_by
    )
    VALUES (
      shift_id_value, '${orgId}'::uuid, '${branchId}'::uuid,
      'sale_cash', 'sale', sale_record.id, net_amount, 'in',
      CONCAT('Cash sale ', sale_record.sale_number), sold_by_value
    );
    PERFORM public.increment_shift_expected(shift_id_value, net_amount);
  END IF;

  RETURN jsonb_build_object('ok', true);
end $fn$;`

let prodDb
let db

beforeAll(async () => {
  // ---- real production definitions
  prodDb = new PGlite()
  // The production definitions declare variables of these row types, so the types must exist (columns are irrelevant here).
  await prodDb.exec('create table branch_sync_clients (id uuid); create table branch_sync_events (id uuid); create table sales (id uuid)')
  await prodDb.exec(await readFile(productionUrl, 'utf8'))
  await prodDb.exec(stripTx(await readFile(migrationUrl, 'utf8')))

  // ---- behaviour
  db = new PGlite()
  await db.exec(`
    create table shifts (id uuid primary key, organization_id uuid, branch_id uuid, expected_cash numeric default 0, status text default 'open', updated_at timestamptz);
    create table shift_cash_movements (id uuid primary key default gen_random_uuid(), shift_id uuid, organization_id uuid, branch_id uuid, movement_type text, source_type text, source_id uuid, amount numeric, direction text, description text, created_by uuid);
    create function public.increment_shift_expected(p_shift_id uuid, p_delta numeric) returns void language plpgsql as $$
      begin update shifts set expected_cash = coalesce(expected_cash, 0) + p_delta where id = p_shift_id and status = 'open';
      if not found then raise exception 'Open shift not found for this user.'; end if; end $$;
    insert into shifts(id, organization_id, branch_id, expected_cash) values ('${shiftId}', '${orgId}', '${branchId}', 100);
  `)
  await db.exec(standIn('create_sale_transaction', 'sale_payload jsonb'))
  await db.exec(standIn('branch_sync_create_sale_transaction', 'p_sync_token text, p_local_sale_id uuid, sale_payload jsonb'))
  await db.exec(stripTx(await readFile(migrationUrl, 'utf8')))
}, 120000)
afterAll(async () => { await prodDb?.close(); await db?.close() })
beforeEach(async () => { await db.exec('begin') })
afterEach(async () => { await db.exec('rollback') })

const expected = async () => Number((await db.query('select expected_cash from shifts where id = $1', [shiftId])).rows[0].expected_cash)
const movements = async () => (await db.query('select amount::float, description, movement_type from shift_cash_movements order by description')).rows
const sale = (over) => JSON.stringify({ shift_id: shiftId, net_amount: 45, ...over })
const create = (payload) => db.query('select public.create_sale_transaction($1::jsonb)', [payload])
const branchSync = (payload) => db.query("select public.branch_sync_create_sale_transaction('tok', gen_random_uuid(), $1::jsonb)", [payload])

it('patches both REAL production sale functions exactly once', async () => {
  for (const name of ['public.create_sale_transaction(jsonb)', 'public.branch_sync_create_sale_transaction(text,uuid,jsonb)']) {
    const def = await definition(prodDb, name)
    expect(def.split('Cash top-up, sale ').length).toBe(2)
    expect(def).toContain("insurance_top_up_method_value = 'cash'")
    // the original cash-sale posting is still there, after the new block
    expect(def.indexOf('Cash top-up, sale ')).toBeLessThan(def.indexOf("'Cash sale '"))
  }
})

it('re-running the migration changes nothing (idempotent)', async () => {
  const before = await definition(prodDb, 'public.create_sale_transaction(jsonb)')
  await prodDb.exec(stripTx(await readFile(migrationUrl, 'utf8')))
  expect(await definition(prodDb, 'public.create_sale_transaction(jsonb)')).toBe(before)
})

it('fails closed if a sale function is not the expected definition', async () => {
  const bad = new PGlite()
  await bad.exec(`create function public.create_sale_transaction(sale_payload jsonb) returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function public.branch_sync_create_sale_transaction(p_sync_token text, p_local_sale_id uuid, sale_payload jsonb) returns jsonb language sql as $$ select '{}'::jsonb $$;`)
  await expect(bad.exec(stripTx(await readFile(migrationUrl, 'utf8')))).rejects.toThrow(/Unexpected .* definition/)
  await bad.close()
})

for (const [label, run] of [['create_sale_transaction', create], ['branch_sync_create_sale_transaction', branchSync]]) {
  it(`${label}: a cash top-up on an insurance sale enters the drawer (expected cash + 39.12)`, async () => {
    await run(sale({ payment_method: 'insurance', insurance_top_up_amount: 39.12, insurance_top_up_payment_method: 'cash' }))
    expect(await movements()).toEqual([{ amount: 39.12, description: expect.stringContaining('Cash top-up'), movement_type: 'sale_cash' }])
    expect(await expected()).toBe(139.12)
  })

  it(`${label}: momo/card top-ups, fully covered sales and pending sales add nothing`, async () => {
    await run(sale({ payment_method: 'insurance', insurance_top_up_amount: 39.12, insurance_top_up_payment_method: 'momo' }))
    await run(sale({ payment_method: 'insurance', insurance_top_up_amount: 39.12, insurance_top_up_payment_method: 'card' }))
    await run(sale({ payment_method: 'insurance', insurance_top_up_amount: 0, insurance_top_up_payment_method: '' }))
    await run(sale({ payment_method: 'insurance', payment_status: 'pending_payment', insurance_top_up_amount: 9, insurance_top_up_payment_method: 'cash' }))
    expect(await movements()).toEqual([])
    expect(await expected()).toBe(100)
  })

  it(`${label}: an ordinary cash sale still posts the whole sale once`, async () => {
    await run(sale({ payment_method: 'cash', net_amount: 45 }))
    expect(await movements()).toEqual([{ amount: 45, description: expect.stringContaining('Cash sale'), movement_type: 'sale_cash' }])
    expect(await expected()).toBe(145)
  })

  it(`${label}: a non-insurance sale with a stray top-up field is not posted twice`, async () => {
    await run(sale({ payment_method: 'momo', net_amount: 45, insurance_top_up_amount: 5, insurance_top_up_payment_method: 'cash' }))
    expect(await movements()).toEqual([])
  })
}
