// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('adds folder storage to legacy patients and preserves saved values on reapplication', async () => {
  const db = new PGlite()
  try {
    await db.exec("create table patients(id int primary key, full_name text, phone text); insert into patients values(1,'Existing patient','0240000000')")
    const sql = readFileSync('supabase/migrations/20261008230000_add_patient_folder_number.sql', 'utf8')
    await db.exec(sql)
    expect((await db.query('select * from patients')).rows).toEqual([{ id: 1, full_name: 'Existing patient', phone: '0240000000', folder_no: null }])
    await db.exec("update patients set folder_no='F001',phone='0200000000' where id=1; insert into patients values(2,'New patient','0241111111','F002')")
    await db.exec(sql)
    expect((await db.query('select id,phone,folder_no from patients order by id')).rows).toEqual([
      { id: 1, phone: '0200000000', folder_no: 'F001' },
      { id: 2, phone: '0241111111', folder_no: 'F002' },
    ])
  } finally { await db.close() }
}, 30000)
