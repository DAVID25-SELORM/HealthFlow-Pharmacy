// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('rolls back payment and status together and retries without duplicate payment', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$select '00000000-0000-0000-0000-000000000001'::uuid$$;
      create table nhis_claims(id uuid primary key,organization_id uuid,branch_id uuid,total_amount numeric,status text,updated_at timestamptz);
      create table nhis_claim_payments(organization_id uuid,branch_id uuid,nhis_claim_id uuid,insurer_name text,approved_amount numeric,paid_amount numeric check(paid_amount<100),payment_date date,payment_method text,notes text,created_by uuid);
      insert into nhis_claims values ('00000000-0000-0000-0000-000000000002',auth.uid(),null,100,'submitted',now());`)
    await db.exec(readFileSync('supabase/migrations/20260913170000_atomic_nhis_paid_status.sql','utf8'))
    await expect(db.exec("select mark_nhis_claim_paid('00000000-0000-0000-0000-000000000002')")).rejects.toThrow()
    expect((await db.query('select status from nhis_claims')).rows[0].status).toBe('submitted')
    expect((await db.query('select * from nhis_claim_payments')).rows).toHaveLength(0)
    await db.exec('update nhis_claims set total_amount=50')
    await db.exec("select mark_nhis_claim_paid('00000000-0000-0000-0000-000000000002'); select mark_nhis_claim_paid('00000000-0000-0000-0000-000000000002');")
    expect((await db.query('select * from nhis_claim_payments')).rows).toHaveLength(1)
    expect((await db.query('select status from nhis_claims')).rows[0].status).toBe('paid')
  } finally { await db.close() }
},30000)
