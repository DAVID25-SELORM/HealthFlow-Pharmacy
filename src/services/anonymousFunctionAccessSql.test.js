// @vitest-environment node
// Rehearses the 2026-11-22 migration that closes three internal functions to signed-out callers.
// Uses stand-in functions with the production signatures, created the way production created them
// (EXECUTE left on PUBLIC), then checks who can run them before and after the migration.
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const migrationUrl = new URL('../../supabase/migrations/20261122150000_restrict_anonymous_execute_on_internal_functions.sql', import.meta.url)
const stripNotify = (sql) => sql.replace(/^notify .*$/gm, '')

const CLOSED = [
  'public.next_nhis_claim_number(uuid)',
  'public.recompute_nhis_claim_total(uuid)',
  'public.branch_belongs_to_organization(uuid, uuid)',
]
// Functions that must NOT be touched (a sample of the intentionally anon-callable ones).
const UNTOUCHED = ['public.branch_sync_ping(text)', 'public.is_super_admin()']

const canRun = async (db, role, fn) =>
  (await db.query('select has_function_privilege($1, $2::regprocedure, \'execute\') as ok', [role, fn])).rows[0].ok

describe('closing internal functions to signed-out callers', () => {
  let db
  let migration

  beforeAll(async () => {
    migration = stripNotify(await readFile(migrationUrl, 'utf8'))
    db = new PGlite()
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create table public.nhis_claim_counters (organization_id uuid primary key, last_number integer not null);
      create function public.next_nhis_claim_number(org_id uuid) returns text language plpgsql security definer set search_path = public as $$
        declare n integer; begin
          insert into public.nhis_claim_counters values (org_id, 1) on conflict (organization_id) do update set last_number = nhis_claim_counters.last_number + 1 returning last_number into n;
          return 'NHIS-' || lpad(n::text, 6, '0'); end $$;
      create function public.recompute_nhis_claim_total(p_claim_id uuid) returns void language sql security definer set search_path = public as $$ select 1 $$;
      create function public.branch_belongs_to_organization(target_branch_id uuid, target_organization_id uuid) returns boolean language sql security definer set search_path = public as $$ select true $$;
      create function public.branch_sync_ping(p_sync_token text) returns text language sql security definer set search_path = public as $$ select 'ok' $$;
      create function public.is_super_admin() returns boolean language sql security definer set search_path = public as $$ select false $$;
      -- a trigger-style caller: another SECURITY DEFINER function that uses the claim number, as in production
      create function public.assign_number(org uuid) returns text language sql security definer set search_path = public as $$ select public.next_nhis_claim_number(org) $$;
      grant execute on function public.assign_number(uuid) to authenticated;
    `)
  }, 120000)

  afterAll(async () => { await db?.close() })

  it('starts like production: everyone, including signed-out callers, can run the three functions', async () => {
    for (const fn of CLOSED) expect(await canRun(db, 'anon', fn)).toBe(true)
  })

  it('stops signed-out callers but keeps signed-in staff and the service role', async () => {
    await db.exec(migration)
    for (const fn of CLOSED) {
      expect(await canRun(db, 'anon', fn)).toBe(false)
      expect(await canRun(db, 'authenticated', fn)).toBe(true)
      expect(await canRun(db, 'service_role', fn)).toBe(true)
    }
  })

  it('does not touch the functions that are meant to stay callable', async () => {
    for (const fn of UNTOUCHED) expect(await canRun(db, 'anon', fn)).toBe(true)
  })

  it('still numbers claims through the definer function that production uses', async () => {
    const org = '20000000-0000-4000-8000-000000000001'
    const first = (await db.query('select public.assign_number($1) as n', [org])).rows[0].n
    const second = (await db.query('select public.assign_number($1) as n', [org])).rows[0].n
    expect([first, second]).toEqual(['NHIS-000001', 'NHIS-000002'])
  })

  it('is safe to run twice, and does not fail where a function does not exist', async () => {
    await db.exec(migration)
    for (const fn of CLOSED) expect(await canRun(db, 'anon', fn)).toBe(false)

    const empty = new PGlite()
    await empty.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin;')
    await expect(empty.exec(migration)).resolves.toBeDefined()
    await empty.close()
  }, 120000)

  it('only changes permissions on the three functions', () => {
    expect(migration).not.toMatch(/\b(drop|delete|truncate|alter\s+table|create\s+or\s+replace)\b/i)
    expect(migration.match(/revoke execute/gi)).toHaveLength(1)
    expect(migration).toMatch(/revoke execute on function %s from public, anon/)
    expect(migration).toMatch(/grant execute on function %s to authenticated, service_role/)
  })
})
