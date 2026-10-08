// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('enforces supplier lifecycle permissions, history retention and suspended order protection', async () => {
  const db = new PGlite()
  const org = '00000000-0000-0000-0000-000000000001'
  const supplier = '00000000-0000-0000-0000-000000000002'
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$select '${org}'::uuid$$;
      create function user_organization_id() returns uuid language sql as $$select auth.uid()$$;
      create table users(id uuid, organization_id uuid, is_active boolean, role text, can_manage_purchases boolean);
      insert into users values(auth.uid(),auth.uid(),true,'procurement',true);
      create table suppliers(id uuid primary key,organization_id uuid,name text,is_active boolean,updated_at timestamptz);
      create table purchases(id int,supplier_id uuid references suppliers(id),organization_id uuid,status text);
      insert into suppliers values('${supplier}',auth.uid(),'Test supplier',true,now());`)
    const sql = readFileSync('supabase/migrations/20261008223000_supplier_lifecycle.sql', 'utf8')
    await db.exec(sql)
    await db.exec(sql)
    const action = (name) => db.query('select manage_purchase_supplier($1,$2)', [supplier, name])
    await db.exec(`insert into purchases values(1,'${supplier}',auth.uid(),'draft')`)
    await action('suspend')
    expect((await db.query('select is_active from suppliers')).rows[0].is_active).toBe(false)
    await expect(db.exec(`insert into purchases values(2,'${supplier}',auth.uid(),'draft')`)).rejects.toThrow('active supplier')
    await db.exec("update purchases set status='received'")
    await expect(action('delete')).rejects.toThrow('purchase history')
    await action('reactivate')
    await db.exec(`insert into purchases values(2,'${supplier}',auth.uid(),'draft')`)
    await db.exec('update users set can_manage_purchases=false')
    await expect(action('suspend')).rejects.toThrow('permission')
    await db.exec('update users set can_manage_purchases=true')
    await db.exec("update suppliers set organization_id='00000000-0000-0000-0000-000000000003'")
    await expect(action('delete')).rejects.toThrow('access denied')
    await db.exec('update suppliers set organization_id=auth.uid(); delete from purchases')
    await action('delete')
    expect((await db.query('select * from suppliers')).rows).toHaveLength(0)
  } finally { await db.close() }
}, 30000)
