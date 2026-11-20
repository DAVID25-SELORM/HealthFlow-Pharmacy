// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const read = (name) => readFileSync(`supabase/migrations/${name}.sql`, 'utf8').replace(/\r\n/g, '\n')
const claimId = '00000000-0000-0000-0000-000000000002'
const actorId = '00000000-0000-0000-0000-000000000001'
const drugA = '00000000-0000-0000-0000-0000000000a1'
const drugB = '00000000-0000-0000-0000-0000000000b2'

const build = async ({ withLedger }) => {
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
    insert into users values(auth.uid(),auth.uid(),'admin','{}',true);
    create table nhis_claims(id uuid primary key,organization_id uuid,claim_number text,created_by uuid,created_at timestamptz,updated_at timestamptz,${fields.map((f) => `${f} ${type(f)}`).join(',')});
    create table nhis_claim_medicines(id uuid default gen_random_uuid(),claim_id uuid,created_at timestamptz default now(),
      nhis_drug_id uuid,drug_code text,description text,unit text,unit_price numeric,dispensed_qty numeric,
      dispensary_date date,dose text,frequency text,duration text,total_amount numeric,medicine_access_level text,
      required_pharmacy_level text,prescribed_qty numeric,served_qty numeric,serving_status text,
      reason_if_not_fully_served text,entered_by_claims_officer uuid,served_by_mca uuid,entered_at timestamptz,served_at timestamptz);
    create table nhis_claim_services(id uuid,claim_id uuid,created_at timestamptz);
    create table nhis_inventory_ledger(claim_id uuid, claim_medicine_key text, quantity_delta numeric);
    create table nhis_claim_corrections(id uuid default gen_random_uuid(),claim_id uuid,organization_id uuid,
      actor_user_id uuid,actor_role text,field_name text,previous_value jsonb,new_value jsonb,reason text,created_at timestamptz default now());
    create table effect_calls(claim_id uuid, idempotency_key text, source text);
    -- Stand-in for the audited deduction function: records the call and deducts the cumulative difference.
    create function public.apply_nhis_inventory_serving_effect(p_claim_id uuid, p_idempotency_key text, p_source text)
    returns jsonb language plpgsql as $$
    begin
      insert into effect_calls values (p_claim_id, p_idempotency_key, p_source);
      insert into nhis_inventory_ledger
        with need as (
          select coalesce(m.nhis_drug_id::text, upper(m.drug_code)) as k, sum(m.served_qty) as required
          from nhis_claim_medicines m where m.claim_id = p_claim_id group by 1
        ), done as (
          select l.claim_medicine_key as k, sum(-l.quantity_delta) as applied
          from nhis_inventory_ledger l where l.claim_id = p_claim_id group by 1
        )
        select p_claim_id, need.k, -(need.required - coalesce(done.applied, 0))
        from need left join done on done.k = need.k
        where need.required > coalesce(done.applied, 0);
      return '{}'::jsonb;
    end $$;
    insert into nhis_claims(id,organization_id,updated_at,status) values('${claimId}',auth.uid(),now(),'served');
    insert into nhis_claim_medicines(claim_id,nhis_drug_id,drug_code,description,unit_price,served_qty,prescribed_qty,dispensed_qty,total_amount)
      values('${claimId}','${drugA}','DRUGA','Paclitaxel',10,4,4,4,40),('${claimId}','${drugB}','DRUGB','Sodium Chloride',2,2,2,2,4);
    ${withLedger ? `insert into nhis_inventory_ledger values('${claimId}','${drugA}',-4),('${claimId}','${drugB}',-2);` : ''}`)
  await db.exec(original.slice(original.indexOf('create or replace function public.correct_nhis_claim_privileged('), original.indexOf('comment on table public.nhis_claim_corrections')))
  const guard = read('20260907105000_guard_nhis_inventory_medicine_corrections')
  await db.exec(guard.slice(0, guard.indexOf('create or replace function public.serve_nhis_claim_medicines')))
  await db.exec(read('20261008213000_preserve_unchanged_nhis_correction_medicines'))
  await db.exec(read('20261120090000_allow_served_quantity_increase_after_stock_deduction'))
  return db
}

const currentRows = async (db) => (await db.query(
  'select nhis_drug_id, drug_code, description, unit_price, served_qty, prescribed_qty, dispensed_qty, total_amount from nhis_claim_medicines order by description'
)).rows

const save = async (db, rows, patch = { notes: 'corrected' }) => {
  const timestamp = (await db.query('select updated_at from nhis_claims')).rows[0].updated_at
  return db.query('select correct_nhis_claim_privileged($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6::timestamptz)',
    [claimId, JSON.stringify(patch), JSON.stringify(rows), '[]', 'Serve correct quantity', timestamp])
}

it('allows raising a served quantity after stock was deducted and deducts only the extra', { timeout: 60000 }, async () => {
  const db = await build({ withLedger: true })
  try {
    const rows = await currentRows(db)
    const raised = rows.map((r) => (r.description === 'Sodium Chloride' ? { ...r, served_qty: 3, dispensed_qty: 3, total_amount: 6 } : r))
    await save(db, raised)
    expect((await db.query("select served_qty from nhis_claim_medicines where description='Sodium Chloride'")).rows[0].served_qty).toBe('3')
    const calls = (await db.query('select * from effect_calls')).rows
    expect(calls).toHaveLength(1)
    expect(calls[0].idempotency_key).toMatch(/^correction:/)
    expect(calls[0].source).toBe('cloud_serve')
    // Only the extra unit was deducted: 4 + 2 + 1.
    expect(Number((await db.query('select sum(-quantity_delta) as s from nhis_inventory_ledger')).rows[0].s)).toBe(7)
    // The replacement switch is switched back off, so ordinary edits stay guarded.
    expect((await db.query("select current_setting('healthflow.nhis_serving_replacement', true) as v")).rows[0].v).not.toBe('true')
    await expect(db.query("update nhis_claim_medicines set served_qty = 9 where description='Sodium Chloride'")).rejects.toThrow(/inventory movement/)
  } finally {
    await db.close()
  }
})

it('still refuses to reduce or remove a served medicine after stock was deducted', { timeout: 60000 }, async () => {
  const db = await build({ withLedger: true })
  try {
    const rows = await currentRows(db)
    const reduced = rows.map((r) => (r.description === 'Sodium Chloride' ? { ...r, served_qty: 1, dispensed_qty: 1, total_amount: 2 } : r))
    await expect(save(db, reduced)).rejects.toThrow(/cannot be reduced or removed/)
    await expect(save(db, rows.filter((r) => r.description !== 'Sodium Chloride'))).rejects.toThrow(/cannot be reduced or removed/)
    expect((await db.query('select count(*) as n from effect_calls')).rows[0].n).toBe(0)
    expect((await currentRows(db)).map((r) => r.served_qty)).toEqual(['4', '2'])
  } finally {
    await db.close()
  }
})

it('leaves header-only corrections and claims without stock movements as they were', { timeout: 60000 }, async () => {
  const withLedger = await build({ withLedger: true })
  try {
    await save(withLedger, await currentRows(withLedger), { notes: 'header only' })
    expect((await withLedger.query('select count(*) as n from effect_calls')).rows[0].n).toBe(0)
  } finally {
    await withLedger.close()
  }
  const noLedger = await build({ withLedger: false })
  try {
    const rows = (await currentRows(noLedger)).map((r) => (r.description === 'Sodium Chloride' ? { ...r, served_qty: 1, dispensed_qty: 1, total_amount: 2 } : r))
    await save(noLedger, rows)
    expect((await noLedger.query('select count(*) as n from effect_calls')).rows[0].n).toBe(0)
    expect((await noLedger.query("select served_qty from nhis_claim_medicines where description='Sodium Chloride'")).rows[0].served_qty).toBe('1')
  } finally {
    await noLedger.close()
  }
})
