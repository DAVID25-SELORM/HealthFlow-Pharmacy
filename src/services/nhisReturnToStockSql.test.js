// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const read = (name) => readFileSync(`supabase/migrations/${name}.sql`, 'utf8').replace(/\r\n/g, '\n')
const claimId = '00000000-0000-0000-0000-000000000002'
const actorId = '00000000-0000-0000-0000-000000000001'
const drugA = '00000000-0000-0000-0000-0000000000a1'
const drugB = '00000000-0000-0000-0000-0000000000b2'
const batch1 = '00000000-0000-0000-0000-0000000000c1' // older deduction of drug A (3 units)
const batch2 = '00000000-0000-0000-0000-0000000000c2' // newer deduction of drug A (2 units)
const batchB = '00000000-0000-0000-0000-0000000000c3'

const build = async ({ role = 'admin' } = {}) => {
  const db = new PGlite()
  const original = read('20260810120000_add_privileged_nhis_claim_correction_audit')
  const fields = [...original.match(/v_allowed_fields constant text\[\] := array\[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  const type = (field) => {
    if (field.endsWith('_id') && !['nhia_transaction_id', 'nhia_auth_id'].includes(field)) return 'uuid'
    if (field === 'prescription_verified') return 'boolean'
    if (field.endsWith('_at')) return 'timestamptz'
    if (['total_amount', 'child_weight_kg', 'prescription_file_size'].includes(field)) return 'numeric'
    return 'text'
  }
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql as $$select '${actorId}'::uuid$$;
    create function user_organization_id() returns uuid language sql as $$select auth.uid()$$;
    create table users(id uuid, organization_id uuid, role text, assigned_roles text[], is_active boolean);
    insert into users values(auth.uid(),auth.uid(),'${role}','{}',true);
    create table nhis_claims(id uuid primary key,organization_id uuid,claim_number text,created_by uuid,created_at timestamptz,updated_at timestamptz,${fields.map((f) => `${f} ${type(f)}`).join(',')});
    create table nhis_claim_medicines(id uuid default gen_random_uuid(),claim_id uuid,created_at timestamptz default now(),
      nhis_drug_id uuid,drug_code text,description text,unit text,unit_price numeric,dispensed_qty numeric,
      dispensary_date date,dose text,frequency text,duration text,total_amount numeric,medicine_access_level text,
      required_pharmacy_level text,prescribed_qty numeric,served_qty numeric,serving_status text,
      reason_if_not_fully_served text,entered_by_claims_officer uuid,served_by_mca uuid,entered_at timestamptz,served_at timestamptz);
    create table nhis_claim_services(id uuid,claim_id uuid,created_at timestamptz);
    create table nhis_claim_corrections(id uuid default gen_random_uuid(),claim_id uuid,organization_id uuid,
      actor_user_id uuid,actor_role text,field_name text,previous_value jsonb,new_value jsonb,reason text,created_at timestamptz default now());
    create table drugs(id uuid primary key, organization_id uuid, branch_id uuid, name text, quantity numeric, status text, updated_at timestamptz);
    create table stock_movements(drug_id uuid, movement_type text, source_type text, quantity numeric, previous_quantity numeric,
      new_quantity numeric, reference_id uuid, notes text, created_by uuid, organization_id uuid, branch_id uuid, created_at timestamptz);
    create table nhis_serving_events(id uuid primary key default gen_random_uuid(), organization_id uuid, branch_id uuid, claim_id uuid,
      idempotency_key text, source text, actor_user_id uuid, payload_hash text, unique (organization_id, idempotency_key));
    create table nhis_inventory_ledger(id uuid primary key default gen_random_uuid(), organization_id uuid, branch_id uuid, claim_id uuid,
      serving_event_id uuid, inventory_drug_id uuid, claim_medicine_key text, quantity_delta numeric, movement_type text,
      reversal_of_ledger_id uuid, actor_user_id uuid, created_at timestamptz default clock_timestamp());
    create table nhis_inventory_policy_activations(id uuid primary key default gen_random_uuid(), organization_id uuid, enabled_at timestamptz default now());
    create table nhis_inventory_policy_activation_baselines(activation_id uuid, claim_id uuid, claim_medicine_key text, served_quantity numeric);
    create table effect_calls(claim_id uuid, idempotency_key text);
    -- Stand-in for the audited deduction function: records the call and deducts the cumulative shortfall from drug batch c1.
    create function public.apply_nhis_inventory_serving_effect(p_claim_id uuid, p_idempotency_key text, p_source text)
    returns jsonb language plpgsql as $$
    declare v_line record; v_applied numeric;
    begin
      insert into effect_calls values (p_claim_id, p_idempotency_key);
      for v_line in select coalesce(nhis_drug_id::text, upper(drug_code)) as k, sum(served_qty) as required
                    from nhis_claim_medicines where claim_id = p_claim_id group by 1 loop
        select coalesce(sum(-quantity_delta), 0) into v_applied from nhis_inventory_ledger
          where claim_id = p_claim_id and claim_medicine_key = v_line.k;
        if v_line.required < v_applied then raise exception 'reduction slipped past the return step'; end if;
        if v_line.required > v_applied then
          update drugs set quantity = quantity - (v_line.required - v_applied) where id = '${drugA}';
          insert into nhis_inventory_ledger(claim_id, serving_event_id, inventory_drug_id, claim_medicine_key, quantity_delta, movement_type)
            values (p_claim_id, gen_random_uuid(), '${batch1}', v_line.k, -(v_line.required - v_applied), 'nhis_dispensing');
        end if;
      end loop;
      return '{}'::jsonb;
    end $$;
    insert into drugs values ('${drugA}', auth.uid(), null, 'Drug A', 100, 'active', now()),
                             ('${batch1}', auth.uid(), null, 'Drug A batch 1', 100, 'active', now()),
                             ('${batch2}', auth.uid(), null, 'Drug A batch 2', 50, 'active', now()),
                             ('${drugB}', auth.uid(), null, 'Drug B', 40, 'active', now()),
                             ('${batchB}', auth.uid(), null, 'Drug B batch', 40, 'active', now());
    insert into nhis_claims(id,organization_id,claim_number,updated_at,status) values('${claimId}',auth.uid(),'NHIS-TEST',now(),'served');
    insert into nhis_claim_medicines(claim_id,nhis_drug_id,drug_code,description,unit_price,served_qty,prescribed_qty,dispensed_qty,total_amount)
      values('${claimId}','${drugA}','DRUGA','Drug A',10,5,5,5,50),('${claimId}','${drugB}','DRUGB','Drug B',2,2,2,2,4);
    insert into nhis_serving_events(id, organization_id, claim_id, idempotency_key, source) values (gen_random_uuid(), auth.uid(), '${claimId}', 'seed', 'cloud_serve');
    -- Drug A was deducted in two steps (3 from batch 1, then 2 from batch 2); drug B in one.
    insert into nhis_inventory_ledger(organization_id, claim_id, serving_event_id, inventory_drug_id, claim_medicine_key, quantity_delta, movement_type, created_at)
      select auth.uid(), '${claimId}', (select id from nhis_serving_events limit 1), x.drug, x.k, x.d, 'nhis_dispensing', x.at
      from (values ('${batch1}'::uuid, '${drugA}', -3, now() - interval '2 hours'), ('${batch2}'::uuid, '${drugA}', -2, now() - interval '1 hour'),
                   ('${batchB}'::uuid, '${drugB}', -2, now() - interval '90 minutes')) as x(drug, k, d, at);`)
  // Production made the reason optional (20260816193000 / 20260918100000); mirror that so only the new check applies.
  const withoutReasonGuard = original
    .slice(original.indexOf('create or replace function public.correct_nhis_claim_privileged('), original.indexOf('comment on table public.nhis_claim_corrections'))
    .replace(/if nullif\(btrim\(p_reason\), ''\) is null then\s*raise exception 'Reason for correction is required\.'[^;]*;\s*end if;/, '')
  expect(withoutReasonGuard).not.toMatch(/Reason for correction is required/)
  await db.exec(withoutReasonGuard)
  const guard = read('20260907105000_guard_nhis_inventory_medicine_corrections')
  await db.exec(guard.slice(0, guard.indexOf('create or replace function public.serve_nhis_claim_medicines')))
  await db.exec(read('20261008213000_preserve_unchanged_nhis_correction_medicines'))
  await db.exec(read('20261120090000_allow_served_quantity_increase_after_stock_deduction'))
  await db.exec(read('20261120100000_return_stock_when_served_quantity_is_reduced'))
  return db
}

const lines = async (db) => (await db.query(
  'select nhis_drug_id, drug_code, description, unit_price, served_qty, prescribed_qty, dispensed_qty, total_amount from nhis_claim_medicines order by description'
)).rows
const withServed = (rows, description, qty) => rows.map((r) => (
  r.description === description ? { ...r, served_qty: qty, dispensed_qty: qty, total_amount: qty * Number(r.unit_price) } : r))
const save = async (db, rows, reason = 'Pharmacy served too much') => {
  const timestamp = (await db.query('select updated_at from nhis_claims')).rows[0].updated_at
  return db.query('select correct_nhis_claim_privileged($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6::timestamptz)',
    [claimId, JSON.stringify({ notes: 'fix' }), JSON.stringify(rows), '[]', reason, timestamp])
}
const stock = async (db) => Object.fromEntries((await db.query('select id, quantity from drugs')).rows.map((r) => [r.id, Number(r.quantity)]))
const netDeducted = async (db, key) => Number((await db.query(
  'select coalesce(sum(-quantity_delta),0) as s from nhis_inventory_ledger where claim_medicine_key = $1', [key])).rows[0].s)

it('returns a reduced quantity to the batches it came from, newest deduction first, and audits it', { timeout: 60000 }, async () => {
  const db = await build()
  try {
    await save(db, withServed(await lines(db), 'Drug A', 1)) // 5 -> 1: return 4 = 2 to batch 2, then 2 to batch 1
    const after = await stock(db)
    expect(after[batch2]).toBe(52)
    expect(after[batch1]).toBe(102)
    expect(after[batchB]).toBe(40)
    expect(await netDeducted(db, drugA)).toBe(1)
    const reversals = (await db.query("select * from nhis_inventory_ledger where movement_type = 'nhis_dispensing_reversal' order by quantity_delta, inventory_drug_id")).rows
    expect(reversals).toHaveLength(2)
    expect(reversals.every((r) => r.reversal_of_ledger_id && r.actor_user_id === actorId)).toBe(true)
    const moves = (await db.query("select * from stock_movements where movement_type = 'return' order by quantity")).rows
    expect(moves.map((m) => Number(m.quantity))).toEqual([2, 2])
    expect((await db.query("select served_qty from nhis_claim_medicines where description = 'Drug A'")).rows[0].served_qty).toBe('1')
    expect((await db.query("select count(*) as n from nhis_serving_events where idempotency_key like 'correction-return:%'")).rows[0].n).toBe(1)
    expect((await db.query("select field_name from nhis_claim_corrections where field_name = 'medicines'")).rows).toHaveLength(1)
  } finally {
    await db.close()
  }
})

it('returns everything when a served medicine is removed', { timeout: 60000 }, async () => {
  const db = await build()
  try {
    await save(db, (await lines(db)).filter((r) => r.description !== 'Drug B'))
    expect((await stock(db))[batchB]).toBe(42)
    expect(await netDeducted(db, drugB)).toBe(0)
    expect((await db.query("select count(*) as n from nhis_claim_medicines where description = 'Drug B'")).rows[0].n).toBe(0)
  } finally {
    await db.close()
  }
})

it('handles a reduction and an increase in the same save', { timeout: 60000 }, async () => {
  const db = await build()
  try {
    const rows = withServed(withServed(await lines(db), 'Drug B', 1), 'Drug A', 7)
    await save(db, rows)
    expect((await stock(db))[batchB]).toBe(41) // one unit of drug B returned
    expect(await netDeducted(db, drugB)).toBe(1)
    expect(await netDeducted(db, drugA)).toBe(7) // two more units of drug A deducted by the serving function
  } finally {
    await db.close()
  }
})

it('refuses a reduction without a reason or from a non-admin, and changes nothing', { timeout: 60000 }, async () => {
  const db = await build()
  try {
    const rows = withServed(await lines(db), 'Drug A', 1)
    await expect(save(db, rows, '')).rejects.toThrow(/reason is required/i)
    expect(await stock(db)).toMatchObject({ [batch1]: 100, [batch2]: 50 })
    expect(await netDeducted(db, drugA)).toBe(5)
  } finally {
    await db.close()
  }
  const officer = await build({ role: 'claims_officer' })
  try {
    await expect(save(officer, withServed(await lines(officer), 'Drug A', 1))).rejects.toThrow(/Only an Admin/)
    expect(await netDeducted(officer, drugA)).toBe(5)
    expect((await officer.query("select served_qty from nhis_claim_medicines where description = 'Drug A'")).rows[0].served_qty).toBe('5')
    // Raising a quantity still works for a claims officer and needs no reason.
    await save(officer, withServed(await lines(officer), 'Drug A', 6), '')
    expect(await netDeducted(officer, drugA)).toBe(6)
  } finally {
    await officer.close()
  }
})
