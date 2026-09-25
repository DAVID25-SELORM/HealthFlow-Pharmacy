// @vitest-environment node
// Replays the reliability migration on top of the production RPC baseline (captured 2026-09-25) and checks:
// slim evidence parity with the legacy RPC, non-blocking legacy claims, parameter and tenant guards, atomic
// per-call recording, and idempotent retries (no duplicate events, no wrongly-flagged re-exports).
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let db
const orgA = '20000000-0000-4000-8000-00000000000a'
const orgB = '20000000-0000-4000-8000-00000000000b'
const userA = '10000000-0000-4000-8000-00000000000a'
const userB = '10000000-0000-4000-8000-00000000000b'
const claimId = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SHA1 = 'a'.repeat(64)
const SHA2 = 'b'.repeat(64)
const migrationUrl = new URL('../../supabase/migrations/20260925130000_nhis_cxf_export_recording_reliability.sql', import.meta.url)
const asUser = (id) => db.exec(`select set_config('test.uid', '${id}', false)`)
const evidence = async (ids, fn = 'claimit_export_signing_evidence') =>
  (await db.query(`select ${fn}($1::uuid[], null) as r`, [ids])).rows[0].r
const fingerprints = (rows) => Object.fromEntries(rows.map((row) => [row.id, row.claimit_fingerprint]))
const events = async (sha) =>
  (await db.query('select claim_id, event_type from nhis_cxf_events where artifact_sha256 = $1 order by claim_id, event_type', [sha])).rows
// A failing statement aborts the surrounding transaction; run it in a savepoint so the test can go on.
const failsWith = async (run, pattern) => {
  await db.exec('savepoint expected_failure')
  try {
    await expect(run()).rejects.toThrow(pattern)
  } finally {
    await db.exec('rollback to savepoint expected_failure')
  }
}
const record = (ids, fps, sha, reason = null) =>
  db.query('select record_nhis_cxf_export_atomic($1::uuid[], $2::jsonb, $3, $4)', [ids, JSON.stringify(fps), sha, reason])

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role authenticated; create role anon; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create table users (id uuid primary key, organization_id uuid, full_name text, role text, assigned_roles text[], is_active boolean);
    create table nhis_claims (id uuid primary key, organization_id uuid, branch_id uuid, claim_number text, status text, surname text, folder_no text,
      referring_facility text, physician_name text, diagnosis text, diagnosis_details jsonb, ccc_no text, member_no text, hin text,
      service_date_from date, service_date_to date, total_amount numeric, prescription_file_path text, claimit_attachment_base64 text,
      rejection_reason text, updated_at timestamptz default now());
    create table nhis_claim_medicines (id uuid primary key default gen_random_uuid(), claim_id uuid references nhis_claims(id), drug_code text, dose text,
      frequency text, duration text, unit_price numeric, dispensed_qty numeric, total_amount numeric);
    create table nhis_claim_services (id uuid primary key default gen_random_uuid(), claim_id uuid references nhis_claims(id), gdrg_code text,
      unit_price numeric, quantity numeric, total_amount numeric, tariff_version text);
    create table nhia_configuration (id uuid primary key default gen_random_uuid(), organization_id uuid, branch_id uuid, is_active boolean default true,
      updated_at timestamptz default now(), credential_code text, provider_id text, provider_number text, accreditation_date_generated text,
      accreditation_expiry_date text, facility_type text, pharmacy_facility_level text, provider_class_level text);
    create table nhis_claim_signatures (id uuid primary key default gen_random_uuid(), claim_id uuid not null references nhis_claims(id), organization_id uuid not null,
      claim_fingerprint text not null, signed_on timestamptz not null default now(), signed_by_user_id uuid not null, signed_by_name text not null,
      signed_by_role text not null, unique(claim_id, claim_fingerprint));
    create table nhis_cxf_events (id uuid primary key default gen_random_uuid(), organization_id uuid not null, claim_id uuid not null references nhis_claims(id),
      actor_id uuid not null references users(id), event_type text not null, reason text, signature_id uuid references nhis_claim_signatures(id),
      serializer_version text, compatibility_profile text, artifact_sha256 text, details jsonb not null default '{}', created_at timestamptz not null default now());
    insert into users values ('${userA}','${orgA}','Officer A','claims_officer','{}',true), ('${userB}','${orgB}','Officer B','claims_officer','{}',true);
    insert into nhia_configuration(organization_id, credential_code, provider_id, accreditation_date_generated, accreditation_expiry_date, facility_type)
      values ('${orgA}','03-05-001-02-01954-11-P1-2-011225','03-05-01954','2025-12-29','2026-12-29','Pharmacy'),
             ('${orgB}','03-05-001-02-01954-11-P1-2-011225','03-05-01954','2025-12-29','2026-12-29','Pharmacy');
    -- 5 claims in org A (1 and 2 legacy-unsigned; 3 signed), 1 in org B. Each carries a large base64 attachment like production.
    insert into nhis_claims select ('30000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, case when g = 6 then '${orgB}'::uuid else '${orgA}'::uuid end, null,
      'NHIS-' || g, 'served', 'Mensah', 'F' || g, 'Westpoint', 'Dr Test', 'Malaria', '[{"label":"Malaria"}]'::jsonb, '12345', '4000000' || g, '4000000' || g,
      current_date - 5, current_date - 5, 10, 'org/claim-' || g || '.pdf', repeat('QUJD', 50000), null, now() from generate_series(1, 6) g;
    insert into nhis_claim_medicines(claim_id, drug_code, dose, frequency, duration, unit_price, dispensed_qty, total_amount)
      select id, 'NH001', '1 tablet', 'BD', '3', 1, 10, 10 from nhis_claims;
  `)
  await db.exec(await readFile(new URL('./fixtures/claimitProductionRpcBaseline.sql', import.meta.url), 'utf8'))
  await db.exec(await readFile(migrationUrl, 'utf8'))
  await db.exec(`insert into nhis_claim_signatures(claim_id, organization_id, claim_fingerprint, signed_by_user_id, signed_by_name, signed_by_role)
    select id, organization_id, claimit_fingerprint(claimit_snapshot(id)), '${userA}', 'Officer A', 'claims_officer' from nhis_claims where id = '${claimId(3)}'`)
}, 120000)
afterAll(async () => { await db?.close() })
beforeEach(async () => { await db.exec('begin'); await asUser(userA) })
afterEach(async () => { await db.exec('rollback') })

it('slim evidence carries the same fingerprints, signer and warnings as the legacy RPC, without the snapshot', async () => {
  const ids = [claimId(1), claimId(3)]
  const slim = await evidence(ids)
  const legacy = await evidence(ids, 'claimit_export_claims')
  expect(fingerprints(slim)).toEqual(fingerprints(legacy))
  expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(legacy).length / 100)
  expect(JSON.stringify(slim)).not.toContain('QUJDQUJD')
  const signed = slim.find((row) => row.id === claimId(3))
  expect(signed).toMatchObject({ signed_by_name: 'Officer A', signed_by_role: 'claims_officer', organization_id: orgA })
  expect(signed.claimit_signature_id).toBeTruthy()
})

it('legacy unsigned claims never block: unsigned fields are null and LEGACY_UNSIGNED_CLAIM is only a warning', async () => {
  const [row] = await evidence([claimId(1)])
  expect(row.signed_by_name).toBeNull()
  expect(row.claimit_signature_id).toBeNull()
  expect(row.claimit_warnings).toContain('LEGACY_UNSIGNED_CLAIM')
})

it('rejects empty, oversized and duplicate claim lists and another organization\'s claims', async () => {
  await failsWith(() => evidence([]), /between 1 and 500/)
  const many = Array.from({ length: 501 }, (_, i) => `40000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
  await failsWith(() => evidence(many), /between 1 and 500/)
  await failsWith(() => evidence([claimId(1), claimId(1)]), /Duplicate/)
  await failsWith(() => evidence([claimId(6)]), /access denied/i) // org B claim as an org A user
  await failsWith(() => evidence([claimId(1), '40000000-0000-4000-8000-0000000000ff']), /not found or access denied/)
})

it('records CLAIM_EXPORT_VALIDATED + CXF_EXPORTED once per claim and leaves the claims untouched', async () => {
  const ids = [claimId(1), claimId(2), claimId(3)]
  const fps = fingerprints(await evidence(ids))
  const before = (await db.query('select id, status, updated_at from nhis_claims order by id')).rows
  await record(ids, fps, SHA1)
  const rows = await events(SHA1)
  expect(rows).toHaveLength(6)
  expect(rows.filter((row) => row.event_type === 'CXF_EXPORTED')).toHaveLength(3)
  expect(rows.filter((row) => row.event_type === 'CLAIM_EXPORT_VALIDATED')).toHaveLength(3)
  expect((await db.query('select id, status, updated_at from nhis_claims order by id')).rows).toEqual(before)
})

it('is atomic: one changed claim in the chunk records nothing for the whole chunk', async () => {
  const ids = [claimId(1), claimId(2), claimId(3)]
  const fps = fingerprints(await evidence(ids))
  fps[claimId(3)] = 'stale-fingerprint'
  await failsWith(() => record(ids, fps, SHA1), /Claim changed during export/)
  expect(await events(SHA1)).toHaveLength(0)
})

it('is idempotent: retrying after success (or after a lost reply) creates no duplicates and no false re-export', async () => {
  const ids = [claimId(1), claimId(2)]
  const fps = fingerprints(await evidence(ids))
  await record(ids, fps, SHA1)
  await record(ids, fps, SHA1)
  await record(ids, fps, SHA1)
  const rows = await events(SHA1)
  expect(rows).toHaveLength(4)
  expect(rows.some((row) => row.event_type === 'CXF_REEXPORTED')).toBe(false)
  // The claim may legitimately change after the first success; a retry of the same artifact must not fail on it.
  await db.exec(`update nhis_claims set surname = 'Edited later' where id = '${claimId(1)}'`)
  await record(ids, fps, SHA1)
  expect(await events(SHA1)).toHaveLength(4)
})

it('a different artifact for an already exported claim is a re-export, recorded once', async () => {
  const ids = [claimId(1)]
  const fps = fingerprints(await evidence(ids))
  await record(ids, fps, SHA1, 'Corrected metadata')
  await record(ids, fps, SHA2, 'Corrected metadata')
  await record(ids, fps, SHA2, 'Corrected metadata')
  expect((await events(SHA1)).map((row) => row.event_type)).toContain('CXF_EXPORTED')
  expect((await events(SHA2)).map((row) => row.event_type).sort()).toEqual(['CLAIM_EXPORT_VALIDATED', 'CXF_REEXPORTED'])
})

it('the database itself refuses a duplicate event for the same claim, type and artifact', async () => {
  const ids = [claimId(1)]
  await record(ids, fingerprints(await evidence(ids)), SHA1)
  await expect(db.exec(`insert into nhis_cxf_events(organization_id, claim_id, actor_id, event_type, artifact_sha256)
    values ('${orgA}', '${claimId(1)}', '${userA}', 'CXF_EXPORTED', '${SHA1}')`)).rejects.toThrow(/duplicate key|nhis_cxf_events_artifact_once/)
})

it('rejects a malformed artifact hash, another tenant\'s claims and an unauthenticated caller when recording', async () => {
  const ids = [claimId(1)]
  const fps = fingerprints(await evidence(ids))
  await failsWith(() => record(ids, fps, 'not-a-hash'), /Artifact SHA-256 required/)
  await failsWith(() => record([claimId(6)], {}, SHA1), /access denied/i)
  await asUser('')
  await failsWith(() => record(ids, fps, SHA1), /Authentication required/)
  expect(await events(SHA1)).toHaveLength(0)
})

it('the migration replays cleanly a second time', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).replace(/^begin;$/m, '').replace(/^commit;$/m, '')
  await db.exec(sql)
})
