// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('rolls back earlier chunks when the last chunk fails and orders locks consistently', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql as $$select '00000000-0000-0000-0000-000000000001'::uuid$$;
      create table recorded(id uuid);
      create function record_nhis_cxf_export(uuid[],jsonb,text,text) returns void language plpgsql as $$
      begin
        if $3='fail-last' and cardinality($1)=1 then raise exception 'Last batch rejected'; end if;
        insert into recorded select unnest($1);
      end $$;`)
    const migration=readFileSync('supabase/migrations/20260920130000_atomic_claimit_export_audit.sql','utf8')
    await db.exec(migration)
    await db.exec(migration)
    const ids=Array.from({length:501},(_,i)=>`00000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`).reverse()
    await expect(db.query('select record_nhis_cxf_export_atomic($1,$2,$3)',[ids,{},'fail-last'])).rejects.toThrow('Last batch rejected')
    expect((await db.query('select count(*)::int as count from recorded')).rows[0].count).toBe(0)
    await db.query('select record_nhis_cxf_export_atomic($1,$2,$3)',[ids,{},'success'])
    expect((await db.query('select id from recorded')).rows.map((r)=>r.id)).toEqual([...ids].sort())
    await expect(db.query('select record_nhis_cxf_export_atomic($1,$2,$3)',[[ids[0],ids[0]],{},'success'])).rejects.toThrow('Duplicate')
    await expect(db.query('select record_nhis_cxf_export_atomic($1,$2,$3)',[[ids[0],null],{},'success'])).rejects.toThrow('null claim')
    await expect(db.query('select record_nhis_cxf_export_atomic($1,$2,$3)',[[],{},'success'])).rejects.toThrow('between 1 and 10000')
  } finally { await db.close() }
},30000)
