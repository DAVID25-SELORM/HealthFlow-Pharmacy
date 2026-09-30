// @vitest-environment node
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'
import { getNhisDirectServingIssue } from '../../local-branch-server/src/nhisCccValidation.js'

it('requires both folder number and a five digit CCC before direct serving', () => {
  expect(getNhisDirectServingIssue({ folderNo: ' ', cccNo: '12345' })).toContain('Folder number')
  expect(getNhisDirectServingIssue({ folderNo: 'F1', cccNo: '' })).toContain('required')
  expect(getNhisDirectServingIssue({ folderNo: 'F1', cccNo: '1234' })).toContain('5 digits')
  expect(getNhisDirectServingIssue({ folderNo: 'F1', cccNo: '12345' })).toBe('')
})

it('rejects direct serving without identifiers and rolls back earlier medicine changes', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated;
      create table nhis_claims(id int,folder_no text,ccc_no text,direct_served_at timestamptz);
      create table medicines(served_qty int); insert into medicines values(0);
      insert into nhis_claims values(1,null,null,null);`)
    const migration = readFileSync('supabase/migrations/20260930120000_require_direct_serving_identifiers.sql','utf8')
    await db.exec(migration)
    await db.exec(migration)
    await db.exec('begin; update medicines set served_qty=5;')
    await expect(db.exec('update nhis_claims set direct_served_at=now()')).rejects.toThrow('Folder number')
    await db.exec('rollback')
    expect((await db.query('select served_qty from medicines')).rows[0].served_qty).toBe(0)
    await db.exec("update nhis_claims set folder_no='F1'")
    await expect(db.exec('update nhis_claims set direct_served_at=now()')).rejects.toThrow('CCC/CC')
    await db.exec("update nhis_claims set ccc_no='12345',direct_served_at=now()")
    await expect(db.exec("update nhis_claims set folder_no=' '")).rejects.toThrow('Folder number')
  } finally { await db.close() }
},30000)
