// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, expect, it } from 'vitest'

let db
const org = '00000000-0000-0000-0000-000000000001'
const actor = '00000000-0000-0000-0000-000000000002'
const claim = '00000000-0000-0000-0000-000000000003'
const migration = readFileSync('supabase/migrations/20260920120000_claimit_signing_and_export_gate.sql', 'utf8')
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.actor',true),'')::uuid $$;
    create table organizations(id uuid primary key);
    create table users(id uuid primary key,organization_id uuid,role text,assigned_roles text[],is_active boolean,full_name text);
    create table nhis_claims(id uuid primary key,organization_id uuid,branch_id uuid,claim_number text,status text,ccc_no text,member_no text,
      hin text,service_date_from date,service_date_to date,total_amount numeric,prescription_file_path text,updated_at timestamptz);
    create table nhis_claim_medicines(id uuid primary key,claim_id uuid,drug_code text,duration text,unit_price numeric,dispensed_qty numeric,total_amount numeric);
    create table nhis_claim_services(id uuid primary key,claim_id uuid,gdrg_code text,unit_price numeric,quantity numeric,total_amount numeric,tariff_version text);
    create table nhis_claim_payments(nhis_claim_id uuid,paid_amount numeric);
    create table nhia_configuration(organization_id uuid,branch_id uuid,is_active boolean,updated_at timestamptz,credential_code text,
      provider_id text,facility_type text,accreditation_date_generated date,accreditation_expiry_date date);
    insert into organizations values('${org}');
    insert into users values('${actor}','${org}','claims_officer','{}',true,'Real Officer');
    insert into nhis_claims values('${claim}','${org}',null,'TEST-001','served','12345','12345678',null,'2026-05-01','2026-05-01',251.87,'org/rx.pdf',now());
    insert into nhis_claim_medicines values
      ('00000000-0000-0000-0000-000000000011','${claim}','A','1 day',10.25,1,10.25),
      ('00000000-0000-0000-0000-000000000012','${claim}','B','1 day',20.10,1,20.10),
      ('00000000-0000-0000-0000-000000000013','${claim}','C','1 day',221.52,1,221.52);
    insert into nhia_configuration values('${org}',null,true,now(),'03-05-001-02-00001-11-P1-2-010125','TEST','Pharmacy','2025-01-01','2027-01-01');
    set test.actor='${actor}';`)
  await db.exec(`alter table nhis_claims add column surname text default 'Synthetic',
    add column folder_no text default 'TEST-FOLDER', add column referring_facility text default 'Synthetic Facility',
    add column physician_name text default 'Synthetic Prescriber', add column diagnosis_details jsonb;
    alter table nhis_claim_medicines add column dose text default '1 tablet', add column frequency text default 'OD';`)
  await db.exec(migration)
  await db.exec(migration)
}, 30000)
afterAll(async () => { await db?.close() })

it('dry-runs legacy claims without inventing a signer and persists flags idempotently', async () => {
  const preview = (await db.query('select audit_nhis_claimit() as report')).rows[0].report
  expect(preview).toMatchObject({ scanned: 1, would_update: 0, would_flag: 1, automatically_repaired: 0 })
  expect(preview.rows[0].issues).toEqual(['LEGACY_MISSING_SIGNER'])
  expect((await db.query('select count(*)::int as count from nhis_claim_signatures')).rows[0].count).toBe(0)
  expect((await db.query('select audit_nhis_claimit(null,100,true) as report')).rows[0].report.flags_written).toBe(1)
  expect((await db.query('select audit_nhis_claimit(null,100,true) as report')).rows[0].report.flags_written).toBe(0)
})

it('rejects unsigned exports and atomically signs with authenticated identity', async () => {
  await expect(db.query('select claimit_export_claims($1)', [[claim]])).rejects.toThrow('MISSING_OR_STALE_SIGNER')
  const signature = (await db.query('select sign_nhis_claim($1,$2) as signature', [claim, 'Reviewed original prescription'])).rows[0].signature
  expect(signature).toMatchObject({ status: 'VALID', signed_by_user_id: actor, signed_by_name: 'Real Officer', signed_by_role: 'claims_officer' })
  expect(signature.signed_on).toBeTruthy()
  const repeat = (await db.query('select sign_nhis_claim($1,$2) as signature', [claim, 'Reviewed again'])).rows[0].signature
  expect(repeat.id).toBe(signature.id)
  expect((await db.query("select count(*)::int as count from nhis_cxf_events where event_type='CLAIM_SIGNED'")).rows[0].count).toBe(1)
})

it('enforces precise totals and invalidates signatures after clinical edits', async () => {
  await db.exec("update nhis_claim_medicines set duration='2 days' where drug_code='A'")
  await expect(db.query('select claimit_export_claims($1)', [[claim]])).rejects.toThrow('MISSING_OR_STALE_SIGNER')
  await db.exec('update nhis_claims set total_amount=251.88')
  await expect(db.query('select sign_nhis_claim($1,$2)', [claim, 'Review'])).rejects.toThrow('INVALID_TOTALS')
  await db.exec('update nhis_claims set total_amount=251.87')
  await db.query('select sign_nhis_claim($1,$2)', [claim, 'Reviewed correction'])
})

it('retains old export evidence and requires an explicit corrected re-export reason', async () => {
  const rows = (await db.query('select claimit_export_claims($1) as claims', [[claim]])).rows[0].claims
  const fingerprints = { [claim]: rows[0].claimit_fingerprint }
  await db.query('select record_nhis_cxf_export($1,$2,$3)', [[claim], fingerprints, 'a'.repeat(64)])
  await expect(db.query('select claimit_export_claims($1)', [[claim]])).rejects.toThrow('REEXPORT_REASON_REQUIRED')
  await db.query('select record_nhis_cxf_export($1,$2,$3,$4)', [[claim], fingerprints, 'b'.repeat(64), 'Corrected export'])
  expect((await db.query("select artifact_sha256 from nhis_cxf_events where event_type in ('CXF_EXPORTED','CXF_REEXPORTED') order by created_at")).rows.map((r) => r.artifact_sha256)).toEqual(['a'.repeat(64), 'b'.repeat(64)])
  await expect(db.query('select record_nhis_cxf_export($1,$2,$3,$4)', [[claim], { [claim]: 'stale' }, 'c'.repeat(64), 'Retry'])).rejects.toThrow('changed during export')
})

it('blocks suspicious accreditation without overwriting the stored date', async () => {
  await db.exec("update nhia_configuration set accreditation_date_generated='2027-01-01'")
  await expect(db.query('select claimit_export_claims($1,$2)', [[claim], 'Review'])).rejects.toThrow('ACCREDITATION_MAPPING_CONFLICT')
  await db.exec("update nhia_configuration set accreditation_date_generated='2025-01-01'")
})

it('rejects export acknowledgement when provider configuration changed during generation', async () => {
  const rows = (await db.query('select claimit_export_claims($1,$2) as claims', [[claim], 'Review'])).rows[0].claims
  await db.exec("update nhia_configuration set provider_id='CHANGED'")
  await expect(db.query('select record_nhis_cxf_export($1,$2,$3,$4)',
    [[claim], { [claim]: rows[0].claimit_fingerprint }, 'd'.repeat(64), 'Review'])).rejects.toThrow('changed during export')
  await db.exec("update nhia_configuration set provider_id='TEST'")
})

it('flags missing clinical evidence and malformed diagnoses without filling values', async () => {
  await db.exec("update nhis_claims set physician_name=null,diagnosis_details='{}'")
  await expect(db.query('select sign_nhis_claim($1,$2)', [claim, 'Review'])).rejects.toThrow('INVALID_DIAGNOSIS_STRUCTURE')
  const report = (await db.query('select audit_nhis_claimit() as report')).rows[0].report
  expect(report.rows[0].issues).toContain('MISSING_PRESCRIBER')
  expect((await db.query('select physician_name from nhis_claims')).rows[0].physician_name).toBeNull()
  await db.exec("update nhis_claims set physician_name='Synthetic Prescriber',diagnosis_details=null")
})

it('denies inactive, unprivileged, cross-tenant users and direct writes to signing evidence', async () => {
  await db.exec('update users set role=null,assigned_roles=null')
  await expect(db.query('select sign_nhis_claim($1,$2)', [claim, 'Attempt'])).rejects.toThrow('access denied')
  await expect(db.query('select audit_nhis_claimit()')).rejects.toThrow('access denied')
  await db.exec("update users set role='assistant'")
  await expect(db.query('select sign_nhis_claim($1,$2)', [claim, 'Attempt'])).rejects.toThrow('access denied')
  await expect(db.query('select audit_nhis_claimit()')).rejects.toThrow('access denied')
  await db.exec("update users set role='claims_officer',is_active=false")
  await expect(db.query('select claimit_export_claims($1,$2)', [[claim], 'Attempt'])).rejects.toThrow('access denied')
  await db.exec("update users set is_active=true,organization_id='00000000-0000-0000-0000-000000000099'")
  await expect(db.query('select sign_nhis_claim($1,$2)', [claim, 'Attempt'])).rejects.toThrow('access denied')
  await db.exec(`update users set organization_id='${org}'; set role authenticated;`)
  await expect(db.exec('delete from nhis_claim_signatures')).rejects.toThrow('permission denied')
  await expect(db.query('select claimit_snapshot($1)', [claim])).rejects.toThrow('permission denied')
  await db.exec('reset role')
})

it('repairs only provably unexported header totals and retains original financial values in the audit', async () => {
  const fresh='00000000-0000-0000-0000-000000000050'
  await db.exec(`insert into nhis_claims(id,organization_id,claim_number,status,ccc_no,member_no,service_date_from,total_amount)
    values('${fresh}','${org}','NEW-TEST','served','12345','12345678','2026-05-01',9);
    insert into nhis_claim_medicines(id,claim_id,drug_code,duration,unit_price,dispensed_qty,total_amount)
      values('00000000-0000-0000-0000-000000000051','${fresh}','NEW','1 day',10,1,10);`)
  const fingerprint=(await db.query('select claimit_fingerprint(claimit_snapshot($1)) as fingerprint',[fresh])).rows[0].fingerprint
  const preview=(await db.query('select audit_nhis_claimit() as report')).rows[0].report
  expect(preview.repairable).toBe(1)
  expect(preview.rows.find((row) => row.id === fresh).repairable).toBe(true)
  const result=(await db.query('select repair_nhis_claimit_total($1,$2) as result',[fresh,fingerprint])).rows[0].result
  expect(result).toMatchObject({previous:9,corrected:10,changed:true})
  const after=(await db.query('select claimit_fingerprint(claimit_snapshot($1)) as fingerprint',[fresh])).rows[0].fingerprint
  expect((await db.query('select repair_nhis_claimit_total($1,$2) as result',[fresh,after])).rows[0].result.changed).toBe(false)
  expect((await db.query("select details from nhis_cxf_events where claim_id=$1 and event_type='CLAIM_REPAIRED'",[fresh])).rows).toHaveLength(1)
  await expect(db.query('select repair_nhis_claimit_total($1,$2)',[fresh,fingerprint])).rejects.toThrow('Preview is stale')
  await expect(db.query("update nhis_claims set status='submitted' where id=$1",[fresh])).rejects.toThrow('Review and sign')
  await db.query("update nhis_claims set status='rejected' where id=$1",[fresh])
  await expect(db.query('select repair_nhis_claimit_total($1,$2)',[fresh,after])).rejects.toThrow('manual financial review')
})
