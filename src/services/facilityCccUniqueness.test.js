// @vitest-environment node
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { it, expect } from 'vitest'

it('blocks new facility duplicates, preserves historical claims and permits other facilities', async () => {
  const db = new PGlite()
  const org = '00000000-0000-0000-0000-000000000001'
  const other = '00000000-0000-0000-0000-000000000002'
  const id = (n) => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`
  const add = (n, facility, code) => db.query('insert into nhis_claims values ($1,$2,$3)', [id(n), facility, code])
  try {
    await db.exec('create role anon; create role authenticated; create table nhis_claims(id uuid primary key, organization_id uuid, ccc_no text);')
    await add(1, org, '12345'); await add(2, org, '12345')
    await db.exec(readFileSync('supabase/migrations/20260930130000_prevent_new_facility_ccc_duplicates.sql', 'utf8'))
    await db.query('update nhis_claims set ccc_no=ccc_no where id=$1', [id(1)])
    await expect(add(3, org, '12-345')).rejects.toThrow('already used')
    await add(3, other, '12345')
    await add(4, org, '54321')
    await expect(add(5, org, '54321')).rejects.toThrow('already used')
    await db.query('update nhis_claims set ccc_no=$1 where id=$2', ['44444', id(4)])
    await add(5, org, '54321')
    await expect(db.query('update nhis_claims set ccc_no=$1 where id=$2', ['44444', id(5)])).rejects.toThrow('already used')
    await db.query('delete from nhis_claims where id=$1', [id(4)])
    await add(6, org, '44444')
    await add(7, org, ''); await add(8, org, '')
  } finally { await db.close() }
}, 60000)

it('permits undated equipment while retaining medicine expiry requirements', async () => {
  const db = new PGlite()
  try {
    await db.exec('create table drugs(category text, expiry_date date not null);')
    await db.exec(readFileSync('supabase/migrations/20260930140000_optional_non_medicine_expiry.sql', 'utf8'))
    await db.exec("insert into drugs values ('medical_equipment', null)")
    await expect(db.exec("insert into drugs values ('medicine', null)")).rejects.toThrow()
  } finally { await db.close() }
}, 60000)
