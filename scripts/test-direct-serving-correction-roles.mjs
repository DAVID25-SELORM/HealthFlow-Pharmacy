import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const db = new PGlite()
try {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql as
      'select nullif(current_setting(''test.actor'', true), '''')::uuid';
    create table public.users (id uuid primary key, organization_id uuid, role text, assigned_roles text[], is_active boolean);
    create table public.nhis_claims (id uuid primary key, organization_id uuid, direct_served_at timestamptz);
    create table public.nhis_claim_medicines (id integer primary key, claim_id uuid, duration text);
    insert into public.users values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'assistant', '{}', true);
    insert into public.nhis_claims values ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', now());
    select set_config('test.actor', '00000000-0000-0000-0000-000000000001', false);
  `)
  const migration = await readFile(new URL('../supabase/migrations/20260918110000_fix_direct_serving_assigned_role_corrections.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  await db.exec(migration)
  await db.exec(`create trigger guard_direct before insert or update or delete on public.nhis_claim_medicines for each row execute function public.prevent_mca_changes_to_direct_nhis_serving();`)
  const cases = [
    ['assistant only', 'assistant', [], true, false, false, false],
    ['assigned claims officer', 'assistant', ['claims_officer'], true, false, false, true],
    ['assigned admin', 'assistant', ['admin'], true, false, false, true],
    ['primary claims officer', 'claims_officer', [], true, false, false, true],
    ['primary admin', 'admin', [], true, false, false, true],
    ['inactive assigned officer', 'assistant', ['claims_officer'], false, false, false, false],
    ['other tenant assigned officer', 'assistant', ['claims_officer'], true, true, false, false],
    ['null assigned roles', 'assistant', null, true, false, false, false],
    ['unrelated assigned role', 'assistant', ['pharmacist'], true, false, false, false],
    ['ordinary dispensary claim', 'assistant', [], true, false, true, true],
  ]
  let checked = 0
  for (const [name, role, assigned, active, otherTenant, ordinary, allowed] of cases) {
    await db.query('update public.users set role=$1, assigned_roles=$2, is_active=$3, organization_id=$4', [role, assigned, active, otherTenant ? '00000000-0000-0000-0000-000000000004' : '00000000-0000-0000-0000-000000000002'])
    await db.query('update public.nhis_claims set direct_served_at=$1', [ordinary ? null : '2026-07-01T00:00:00Z'])
    for (const operation of ['insert', 'update', 'delete']) {
      await db.exec(`alter table public.nhis_claim_medicines disable trigger guard_direct;
        truncate public.nhis_claim_medicines;
        insert into public.nhis_claim_medicines values (1,'00000000-0000-0000-0000-000000000003','30 days');
        alter table public.nhis_claim_medicines enable trigger guard_direct;`)
      const sql = operation === 'insert'
        ? "insert into public.nhis_claim_medicines values (2,'00000000-0000-0000-0000-000000000003','30 days')"
        : operation === 'update' ? "update public.nhis_claim_medicines set duration='31 days' where id=1"
          : 'delete from public.nhis_claim_medicines where id=1'
      if (allowed) await db.exec(sql)
      else await assert.rejects(db.exec(sql), (error) => error.code === 'P0001' && error.message.includes('does not require dispensary input'), name)
      checked++
    }
  }
  console.log(`Passed ${checked} database trigger checks; migration also applied twice successfully.`)
} finally {
  await db.close()
}
