// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const read = (name) => readFileSync(`supabase/migrations/${name}.sql`, 'utf8')
const claimId = '00000000-0000-0000-0000-000000000002'
const actorId = '00000000-0000-0000-0000-000000000001'

it('saves an attachment after deduction without replacing medicines; rejects real medicine edits atomically', async () => {
  const db = new PGlite()
  try {
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
      insert into users values(auth.uid(),auth.uid(),'claims_officer','{}',true);
      create table nhis_claims(id uuid primary key,organization_id uuid,claim_number text,created_by uuid,created_at timestamptz,updated_at timestamptz,${fields.map((f) => `${f} ${type(f)}`).join(',')});
      create table nhis_claim_medicines(id uuid default gen_random_uuid(),claim_id uuid,created_at timestamptz default now(),
        nhis_drug_id uuid,drug_code text,description text,unit text,unit_price numeric,dispensed_qty numeric,
        dispensary_date date,dose text,frequency text,duration text,total_amount numeric,medicine_access_level text,
        required_pharmacy_level text,prescribed_qty numeric,served_qty numeric,serving_status text,
        reason_if_not_fully_served text,entered_by_claims_officer uuid,served_by_mca uuid,entered_at timestamptz,served_at timestamptz);
      create table nhis_claim_services(id uuid,claim_id uuid,created_at timestamptz);
      create table nhis_inventory_ledger(claim_id uuid,quantity numeric);
      create table nhis_claim_corrections(id uuid default gen_random_uuid(),claim_id uuid,organization_id uuid,
        actor_user_id uuid,actor_role text,field_name text,previous_value jsonb,new_value jsonb,reason text,created_at timestamptz default now());
      insert into nhis_claims(id,organization_id,updated_at,status) values('${claimId}',auth.uid(),now(),'served');
      insert into nhis_claim_medicines(claim_id,description,served_qty,duration,served_at)
        values('${claimId}','Infusion',1,'1 day','2026-10-08T10:00:00Z'),('${claimId}','Second medicine',2,'2 days',null);
      insert into nhis_inventory_ledger values('${claimId}',3);`)
    await db.exec(original.slice(original.indexOf('create or replace function public.correct_nhis_claim_privileged('), original.indexOf('comment on table public.nhis_claim_corrections')))
    const guard = read('20260907105000_guard_nhis_inventory_medicine_corrections')
    await db.exec(guard.slice(0, guard.indexOf('create or replace function public.serve_nhis_claim_medicines')))
    const medicines = (await db.query('select * from nhis_claim_medicines order by description')).rows
    const payload = medicines.map(({ id: _id, claim_id: _claimId, created_at: _createdAt, ...row }) => row).reverse()
    payload.find((row) => row.served_at).served_at = '2026-10-08T10:00:00.000+00:00'
    const save = async (rows, patch = { prescription_file_name: 'prescription.pdf', prescription_verified: true }) => {
      const timestamp = (await db.query('select updated_at from nhis_claims')).rows[0].updated_at
      return db.query('select correct_nhis_claim_privileged($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6::timestamptz)',
        [claimId, JSON.stringify(patch), JSON.stringify(rows), '[]', 'Attach prescription', timestamp])
    }
    await expect(save(payload)).rejects.toThrow('NHIS inventory movement')
    const migration = read('20261008213000_preserve_unchanged_nhis_correction_medicines')
    await db.exec(migration)
    await db.exec(migration)
    await save(payload)
    expect((await db.query('select prescription_file_name,prescription_verified from nhis_claims')).rows[0])
      .toEqual({ prescription_file_name: 'prescription.pdf', prescription_verified: true })
    expect((await db.query('select * from nhis_claim_medicines order by description')).rows).toEqual(medicines)
    expect((await db.query('select * from nhis_inventory_ledger')).rows).toEqual([{ claim_id: claimId, quantity: '3' }])
    expect((await db.query("select field_name from nhis_claim_corrections where field_name='medicines'")).rows).toHaveLength(0)
    expect((await db.query("select field_name from nhis_claim_corrections where field_name='prescription_file_name'")).rows).toHaveLength(1)
    for (const changed of [payload.slice(1), [...payload, payload[0]], payload.map((r) => ({ ...r, served_qty: 5 })), payload.map((r) => ({ ...r, dose: 'changed' }))]) {
      await expect(save(changed, { prescription_file_name: 'must-rollback.pdf' })).rejects.toThrow('NHIS inventory movement')
    }
    expect((await db.query('select prescription_file_name from nhis_claims')).rows[0].prescription_file_name).toBe('prescription.pdf')
    expect((await db.query('select * from nhis_claim_medicines order by description')).rows).toEqual(medicines)
  } finally { await db.close() }
}, 30000)
