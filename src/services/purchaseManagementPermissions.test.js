// @vitest-environment node
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'

it('allows delegated purchase managers while enforcing facility isolation and revoked access', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role authenticated; create role anon; create schema auth;
      create function auth.uid() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
      create function user_organization_id() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000002'::uuid $$;
      create table users(id uuid, role text, assigned_roles text[], is_active boolean, can_manage_purchases boolean);
      insert into users values(auth.uid(),'assistant','{}',true,true);
    `)
    for (const table of ['suppliers', 'purchases']) {
      await db.exec(`
        create table ${table}(organization_id uuid default user_organization_id(), name text);
        alter table ${table} enable row level security;
        grant select,insert,update on ${table} to authenticated;
        create policy ${table}_select on ${table} for select to authenticated using(organization_id=user_organization_id());
        create policy ${table}_insert on ${table} for insert to authenticated with check(false);
        create policy ${table}_update on ${table} for update to authenticated using(false);
      `)
    }
    const migration = readFileSync('supabase/migrations/20260930110000_align_purchase_management_permissions.sql', 'utf8')
    await db.exec(migration)
    await db.exec(migration)
    for (const [role, assigned, privilege] of [
      ['assistant', [], true], ['inventory_officer', [], true],
      ['admin', [], false], ['assistant', ['admin'], false],
    ]) {
      await db.query('update users set role=$1,assigned_roles=$2,can_manage_purchases=$3', [role, assigned, privilege])
      await db.exec('truncate suppliers,purchases; set role authenticated')
      for (const table of ['suppliers', 'purchases']) {
        await db.exec(`insert into ${table}(name) values('original'); update ${table} set name='updated'`)
        expect((await db.query(`select name from ${table}`)).rows).toEqual([{ name: 'updated' }])
        await expect(db.exec(`insert into ${table} values('00000000-0000-0000-0000-000000000099','foreign')`)).rejects.toThrow(/row-level security/)
        await expect(db.exec(`update ${table} set organization_id='00000000-0000-0000-0000-000000000099'`)).rejects.toThrow(/row-level security/)
      }
      await db.exec('reset role')
    }
    for (const [role, active, privilege] of [['assistant', true, false], ['pharmacist', true, false], ['admin', false, true]]) {
      await db.query("update users set role=$1,is_active=$2,can_manage_purchases=$3,assigned_roles='{}'", [role, active, privilege])
      await db.exec('set role authenticated')
      for (const table of ['suppliers', 'purchases']) {
        await expect(db.exec(`insert into ${table}(name) values('blocked')`)).rejects.toThrow(/row-level security/)
        await db.exec(`update ${table} set name='blocked'`)
        expect((await db.query(`select name from ${table}`)).rows[0].name).toBe('updated')
      }
      await db.exec('reset role')
    }
  } finally { await db.close() }
}, 30000)
