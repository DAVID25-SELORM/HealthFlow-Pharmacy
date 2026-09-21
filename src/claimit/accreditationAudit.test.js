// @vitest-environment node
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260921140000_audit_nhia_accreditation_date_changes.sql', 'utf8')
const org = '00000000-0000-0000-0000-000000000010'
const user = '00000000-0000-0000-0000-000000000020'
const config = '00000000-0000-0000-0000-000000000030'
let db

const audit = async () => (await db.query(
  "select actor_user_id, actor_email, event_type, entity_type, entity_id, organization_id, details from audit_logs order by created_at, id",
)).rows

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.actor', true), '')::uuid $$;
    create function auth.email() returns text language sql stable as $$ select nullif(current_setting('test.email', true), '') $$;
    create table audit_logs (id uuid primary key default gen_random_uuid(), actor_user_id uuid, actor_email text, event_type text, entity_type text,
      entity_id uuid, action text, details jsonb, organization_id uuid, created_at timestamptz default now());
    create table nhia_configuration (id uuid primary key, organization_id uuid, branch_id uuid, credential_code text, api_key_encrypted text,
      accreditation_date_generated date, accreditation_expiry_date date, updated_by uuid);
  `)
  await db.exec(migration)
  await db.exec(migration) // idempotent replay
}, 30000)
afterAll(async () => { await db?.close() })

it('records one row per stored accreditation date on insert with facility, actor and timestamp', async () => {
  await db.exec(`set test.actor='${user}'; set test.email='officer@example.test';`)
  await db.exec(`insert into nhia_configuration (id, organization_id, credential_code, api_key_encrypted, accreditation_date_generated, accreditation_expiry_date, updated_by)
    values ('${config}', '${org}', 'CRED', 'SECRET-VALUE', '2027-08-01', '2027-08-01', '${user}')`)
  const rows = await audit()
  expect(rows).toHaveLength(2)
  expect(rows.map((row) => row.details.field).sort()).toEqual(['accreditation_date_generated', 'accreditation_expiry_date'])
  for (const row of rows) {
    expect(row).toMatchObject({ actor_user_id: user, actor_email: 'officer@example.test', event_type: 'nhia_accreditation_date_changed', entity_type: 'nhia_configuration', entity_id: config, organization_id: org })
    expect(row.details).toMatchObject({ facility_id: org, previous_value: null, new_value: '2027-08-01', operation: 'insert', source: 'authenticated_user' })
    expect(Date.parse(row.details.changed_at)).not.toBeNaN()
  }
})

it('records previous and new value when only the generated date changes, and nothing when unrelated columns change', async () => {
  await db.exec(`update nhia_configuration set accreditation_date_generated = '2025-10-05'`)
  let rows = await audit()
  expect(rows).toHaveLength(3)
  expect(rows.at(-1).details).toMatchObject({ field: 'accreditation_date_generated', previous_value: '2027-08-01', new_value: '2025-10-05', operation: 'update' })
  await db.exec(`update nhia_configuration set credential_code = 'CRED-2', api_key_encrypted = 'OTHER'`)
  await db.exec(`update nhia_configuration set accreditation_expiry_date = '2027-08-01'`) // unchanged value
  rows = await audit()
  expect(rows).toHaveLength(3)
})

it('audits expiry independently and never logs secrets or credentials', async () => {
  await db.exec(`update nhia_configuration set accreditation_expiry_date = '2028-01-01'`)
  const rows = await audit()
  expect(rows.at(-1).details).toMatchObject({ field: 'accreditation_expiry_date', previous_value: '2027-08-01', new_value: '2028-01-01' })
  const serialized = JSON.stringify(rows)
  expect(serialized).not.toMatch(/SECRET-VALUE|OTHER|api_key|CRED-2/)
})

it('marks changes without an authenticated user (offline sync / SQL) and falls back to updated_by', async () => {
  await db.exec(`reset test.actor; reset test.email;`)
  await db.exec(`update nhia_configuration set accreditation_date_generated = '2025-10-06', updated_by = '${user}'`)
  const last = (await audit()).at(-1)
  expect(last.actor_user_id).toBe(user)
  expect(last.actor_email).toBeNull()
  expect(last.details.source).toBe('system_or_branch_sync')
})

it('never blocks a settings save if the audit itself fails', async () => {
  await db.exec('alter table audit_logs rename to audit_logs_offline')
  await db.exec(`update nhia_configuration set accreditation_date_generated = '2025-10-07'`)
  expect((await db.query('select accreditation_date_generated::text as d from nhia_configuration')).rows[0].d).toBe('2025-10-07')
  await db.exec('alter table audit_logs_offline rename to audit_logs')
})

it('does not alter any stored value itself (audit only)', async () => {
  expect((await db.query('select accreditation_date_generated::text g, accreditation_expiry_date::text e from nhia_configuration')).rows[0]).toEqual({ g: '2025-10-07', e: '2028-01-01' })
})
