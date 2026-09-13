// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Execute the migration in PostgreSQL, not a mocked query builder. This fixture
// contains the columns consumed by the projection; it is not a production clone.
const org = '10000000-0000-4000-8000-000000000001'
const otherOrg = '10000000-0000-4000-8000-000000000002'
const branch = '20000000-0000-4000-8000-000000000001'
const otherBranch = '20000000-0000-4000-8000-000000000002'
const officer = '30000000-0000-4000-8000-000000000001'
const oldOfficer = '30000000-0000-4000-8000-000000000002'
const claim = '40000000-0000-4000-8000-000000000001'
const medicine = '40000000-0000-4000-8000-000000000002'
let db
let migration
const permissions = { claim: true, patient: true, medicine: true, sale: true, staff: true, setting: true }
const query = async (options = {}) => {
  const { rows } = await db.query('select public.get_activity_log_view($1::uuid,$2::uuid,$3::jsonb,$4::date,$5::date,$6::uuid,$7::text,$8::text,$9::integer,$10::integer) as result', [
    options.org || org, options.branch || null, JSON.stringify(options.permissions ?? permissions),
    options.from || '2026-09-01', options.to || '2026-09-30', options.actor || null, options.event || null, options.search || null, options.page || 1, options.pageSize || 100,
  ])
  return rows[0].result
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table users (id uuid primary key, organization_id uuid, branch_id uuid, full_name text, is_active boolean);
    create table nhis_claims (id uuid primary key, organization_id uuid, branch_id uuid, surname text, other_names text, claim_number text, prescription_reference text);
    create table drugs (id uuid primary key, organization_id uuid, branch_id uuid, name text, strength text);
    create table sales (id uuid primary key, organization_id uuid, branch_id uuid, sale_number text);
    create table patients (id uuid primary key, organization_id uuid, full_name text);
    create table audit_logs (id uuid primary key default gen_random_uuid(), organization_id uuid, actor_user_id uuid, actor_email varchar(255), entity_type varchar(50), entity_id uuid, event_type varchar(50), action text, details jsonb default '{}', created_at timestamptz);
    create index idx_audit_logs_organization_actor_created_at on audit_logs(organization_id, actor_user_id, created_at desc);
    create index idx_audit_logs_organization_created_at on audit_logs(organization_id, created_at desc);
    insert into users values ('${officer}','${org}','${branch}','Active Officer',true), ('${oldOfficer}','${org}','${branch}','Historical Officer',false);
    insert into nhis_claims values ('${claim}','${org}','${branch}','Current','Name','NHIS-123','RX-456');
    insert into drugs values ('${medicine}','${org}','${branch}','Paracetamol','500 mg');
    insert into audit_logs (organization_id,actor_user_id,actor_email,entity_type,entity_id,event_type,action,details,created_at)
      select '${org}','${officer}','active@example.test','nhis_claims','${claim}','nhis_claim','update','{"active_role":"claims_officer"}', '2026-09-15T12:00:00Z'::timestamptz + i * interval '1 minute' from generate_series(1,105) i;
    insert into audit_logs (organization_id,actor_user_id,entity_type,entity_id,event_type,action,details,created_at) values
      ('${org}','${oldOfficer}','nhis_claims','${claim}','nhis_claim','update','{"patient_name":"Historical Name","claim_number":"OLD-123","reason":"Corrected date"}','2026-09-01T00:00:00Z'),
      ('${org}','${officer}','nhis_claims','${claim}','nhis_claim','update','{}','2026-08-31T23:59:59Z'),
      ('${org}','${officer}','nhis_claims','${claim}','nhis_claim','update','{}','2026-10-01T00:00:00Z'),
      ('${org}','${officer}','drugs','${medicine}','inventory','update','{}','2026-09-30T23:59:59Z'),
      ('${otherOrg}','${officer}','nhis_claims','${claim}','nhis_claim','update','{"patient_name":"Other tenant secret"}','2026-09-10T00:00:00Z'),
      (null,'${officer}','nhis_claims','${claim}','nhis_claim','update','{"patient_name":"Unknown tenant"}','2026-09-10T00:00:00Z'),
      ('${org}','${oldOfficer}','nhis_claims',null,'deleted','delete','{"patient_name":"Deleted Snapshot","branch_id":"${branch}"}','2026-09-10T00:00:00Z'),
      ('${org}','${oldOfficer}','nhis_claims',null,'missing','delete','{}','2026-09-10T00:00:00Z'),
      ('${org}','${oldOfficer}','nhis_claims',null,'other_branch','delete','{"patient_name":"Other branch secret","branch_id":"${otherBranch}"}','2026-09-10T00:00:00Z');
  `)
  migration = await readFile(new URL('../../migrations/20260913120000_activity_log_subjects_and_scope.sql', import.meta.url), 'utf8')
  await db.exec(migration)
}, 30000)
afterAll(async () => { await db?.close() })

describe('Activity Log database projection', () => {
  it('filters September before pagination, with a complete count on every page', async () => {
    const first = await query({ event: 'nhis_claim' })
    const second = await query({ event: 'nhis_claim', page: 2 })
    const empty = await query({ event: 'nhis_claim', page: 9 })
    expect(first.logs).toHaveLength(100)
    expect(first.total).toBe(106)
    expect(second.logs).toHaveLength(6)
    expect(second.total).toBe(106)
    expect(empty.logs).toEqual([])
    expect(empty.total).toBe(106)
    expect(first.logs.every((log) => log.created_at.startsWith('2026-09'))).toBe(true)
  })
  it('finds an inactive officer absent from the first unfiltered page', async () => {
    const result = await query({ actor: oldOfficer, event: 'nhis_claim' })
    expect(result.total).toBe(1)
    expect(result.logs[0].subject.fields).toMatchObject({ Patient: 'Historical Name', Claim: 'OLD-123' })
    expect(result.actors.filter((a) => a.id === oldOfficer)).toHaveLength(1)
    expect(result.actors.find((a) => a.id === oldOfficer)).toMatchObject({ full_name: 'Historical Officer', is_active: false })
  })
  it('resolves current claim references when snapshots are absent', async () => {
    const result = await query({ actor: officer, event: 'nhis_claim' })
    expect(result.logs[0].subject).toMatchObject({ source: 'current', fields: { Patient: 'Current Name', Claim: 'NHIS-123', Prescription: 'RX-456' } })
  })
  it('resolves medicine names and includes the last instant in September', async () => {
    const result = await query({ search: 'Paracetamol', event: 'inventory' })
    expect(result.total).toBe(1)
    expect(result.logs[0].subject.fields).toEqual({ Medicine: 'Paracetamol', Strength: '500 mg' })
  })
  it('keeps deleted snapshots and reports missing identities without inventing them', async () => {
    expect((await query({ event: 'deleted' })).logs[0].subject.fields.Patient).toBe('Deleted Snapshot')
    expect((await query({ event: 'missing' })).logs[0].subject).toMatchObject({ fields: {}, source: 'unavailable' })
  })
  it('does not disclose clinical identifiers or reasons to audit-only readers, even through search counts', async () => {
    const result = await query({ permissions: {}, event: 'nhis_claim', actor: oldOfficer })
    expect(result.total).toBe(1)
    expect(result.logs[0].subject).toMatchObject({ fields: {}, restricted: true })
    expect(result.logs[0].details).not.toHaveProperty('reason')
    expect(JSON.stringify(result)).not.toContain('Historical Name')
    expect((await query({ permissions: {}, search: 'Historical Name' })).total).toBe(0)
    expect((await query({ permissions: {}, search: 'Corrected date' })).total).toBe(0)
  })
  it('isolates tenants and does not infer historical tenancy from the current actor', async () => {
    expect((await query({ search: 'Other tenant secret' })).total).toBe(0)
    expect((await query({ search: 'Unknown tenant' })).total).toBe(0)
    const result = await query({ org: otherOrg })
    expect(result.logs[0].subject.fields).not.toHaveProperty('Claim')
    expect(result.logs[0].actor_name).toBeNull()
  })
  it('scopes branch records, options, and counts before paging and rejects unscoped history', async () => {
    const result = await query({ branch, search: 'Other branch secret' })
    expect(result.total).toBe(0)
    expect(result.eventTypes).not.toContain('other_branch')
    expect(result.eventTypes).not.toContain('missing')
    expect((await query({ branch, event: 'nhis_claim' })).total).toBe(106)
  })
  it('does not change the historical audit rows', async () => {
    const before = await db.query('select md5(jsonb_agg(to_jsonb(a) order by id)::text) as hash from audit_logs a')
    await query()
    expect(await db.query('select md5(jsonb_agg(to_jsonb(a) order by id)::text) as hash from audit_logs a')).toEqual(before)
  })
  it('grants execution only to service_role', async () => {
    const signature = 'public.get_activity_log_view(uuid,uuid,jsonb,date,date,uuid,text,text,integer,integer)'
    const { rows } = await db.query(`select has_function_privilege('anon', '${signature}', 'execute') as anon, has_function_privilege('authenticated', '${signature}', 'execute') as authenticated, has_function_privilege('service_role', '${signature}', 'execute') as service`)
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service: true })
  })
})


it('executes the complete tenant query plan with PostgreSQL EXPLAIN ANALYZE', async () => {
  let sql = migration.slice(migration.indexOf('with tenant_logs'), migration.indexOf('  return v_result;')).replace(' into v_result;', ';')
  const args = { p_organization_id: [org, 'uuid'], p_branch_id: [branch, 'uuid'], p_permissions: [JSON.stringify(permissions), 'jsonb'], p_from_date: ['2026-09-01', 'date'], p_to_date: ['2026-09-30', 'date'], p_actor_user_id: [oldOfficer, 'uuid'], p_event_type: ['nhis_claim', 'text'], p_search: [null, 'text'], p_page: [1, 'integer'], p_page_size: [100, 'integer'] }
  Object.entries(args).forEach(([key, [, type]], index) => { sql = sql.replace(new RegExp(`\\b${key}\\b`, 'g'), `$${index + 1}::${type}`) })
  const { rows } = await db.query(`explain (analyze, buffers, format json) ${sql}`, Object.values(args).map(([value]) => value))
  const plan = rows[0]['QUERY PLAN'][0]
  expect(plan.Plan['Actual Rows']).toBe(1)
  console.info(`Activity query fixture: PostgreSQL execution ${plan['Execution Time']} ms; existing tenant/actor/time indexes retained, no new indexes.`)
})
