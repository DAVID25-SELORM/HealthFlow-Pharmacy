// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, expect, it } from 'vitest'
let db
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon; create role authenticated;
    create table nhis_claims(id uuid primary key, status text, serving_status text);
    create table nhis_claim_medicines(id uuid primary key, claim_id uuid references nhis_claims, duration text, served_qty numeric, serving_status text);
    insert into nhis_claims values ('00000000-0000-0000-0000-000000000001', 'draft', 'pending');`)
  await db.exec(readFileSync('supabase/migrations/20260913160000_enforce_nhis_duration_integrity.sql', 'utf8'))
}, 30000)
afterAll(async () => { await db?.close() })
it('allows incomplete Draft, blocks progression/direct serving, and preserves valid clinical duration on reload', async () => {
  await db.exec(`insert into nhis_claim_medicines values ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', null, 0, 'pending')`)
  for (const invalid of [null, '', ' ', '60', '2W']) {
    await db.query('update nhis_claim_medicines set duration = $1', [invalid])
    await expect(db.exec("update nhis_claims set status = 'served'")).rejects.toThrow('Valid medicine duration')
    await expect(db.exec('update nhis_claim_medicines set served_qty = 1')).rejects.toThrow('Valid medicine duration')
  }
  await db.exec("update nhis_claim_medicines set duration = '2 weeks'; update nhis_claims set status = 'served';")
  await db.exec('update nhis_claim_medicines set served_qty = 2')
  expect((await db.query('select duration from nhis_claim_medicines')).rows[0].duration).toBe('2 weeks')
  await expect(db.exec("update nhis_claim_medicines set duration = ''")).rejects.toThrow('Valid medicine duration')
  // Delete/recreate payload omission cannot remove a saved duration atomically.
  await expect(db.exec(`begin; delete from nhis_claim_medicines;
    insert into nhis_claim_medicines values ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', null, 0, 'pending'); commit;`)).rejects.toThrow('Valid medicine duration')
  await db.exec('rollback')
})
