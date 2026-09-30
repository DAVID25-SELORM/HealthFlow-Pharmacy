// @vitest-environment node
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { it, expect } from 'vitest'
it('limits facility CCC conflicts to seven service days and rechecks date edits', async () => {
  const db = new PGlite()
  const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
  const add = (n, day, org = 100, code = '28058') => db.query('insert into nhis_claims(id,organization_id,ccc_no,service_date_from) values($1,$2,$3,$4)', [id(n),id(org),code,day])
  try {
    await db.exec('create role anon; create role authenticated; create table nhis_claims(id uuid primary key, organization_id uuid, ccc_no text, service_date_from date, created_at timestamptz default now());')
    await db.exec(readFileSync('supabase/migrations/20260930130000_prevent_new_facility_ccc_duplicates.sql','utf8'))
    await add(1,'2026-07-20')
    const sql = readFileSync('supabase/migrations/20260930160000_limit_ccc_duplicates_to_seven_days.sql','utf8')
    await db.exec(sql); await db.exec(sql)
    await expect(add(2,'2026-07-20')).rejects.toThrow('within 7 days')
    await expect(add(2,'2026-07-26',100,'28-058')).rejects.toThrow('within 7 days')
    await expect(add(2,'2026-07-14')).rejects.toThrow('within 7 days')
    await add(2,'2026-07-27')
    await add(3,'2026-07-13')
    await add(4,'2026-07-20',101)
    await add(5,'2026-09-30')
    await expect(db.query('update nhis_claims set service_date_from=$1 where id=$2',['2026-07-25',id(5)])).rejects.toThrow('within 7 days')
    await db.query('update nhis_claims set ccc_no=ccc_no where id=$1',[id(1)])
    await add(6,null,100,'12345')
    await expect(add(7,null,100,'12345')).rejects.toThrow('within 7 days')
    await db.query('delete from nhis_claims where id=$1',[id(6)])
    await add(7,null,100,'12345')
  } finally { await db.close() }
},60000)
