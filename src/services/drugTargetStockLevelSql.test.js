// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, expect, it } from 'vitest'

let db
const drug = '00000000-0000-0000-0000-000000000001'

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create table drugs (id uuid primary key, name text, quantity numeric, reorder_level numeric not null default 10);
    insert into drugs (id, name, quantity, reorder_level) values ('${drug}', 'Amoxicillin', 8, 20);
  `)
  await db.exec(readFileSync('supabase/migrations/20260923090000_add_drug_target_stock_level.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20260923090000_add_drug_target_stock_level.sql', 'utf8')) // replay-safe
}, 30000)
afterAll(async () => { await db?.close() })

it('is nullable and does not mass-write a value for an existing drug', async () => {
  const row = (await db.query('select target_stock_level from drugs where id=$1', [drug])).rows[0]
  expect(row.target_stock_level).toBeNull()
})

it('accepts a target at or above the reorder level', async () => {
  await db.exec(`update drugs set target_stock_level = 60 where id='${drug}'`)
  expect((await db.query('select target_stock_level::float from drugs where id=$1', [drug])).rows[0].target_stock_level).toBe(60)
  await db.exec(`update drugs set target_stock_level = 20 where id='${drug}'`) // exactly equal to reorder_level
  expect((await db.query('select target_stock_level::float from drugs where id=$1', [drug])).rows[0].target_stock_level).toBe(20)
})

it('rejects a target below the reorder level', async () => {
  await expect(db.query(`update drugs set target_stock_level = 12 where id='${drug}'`))
    .rejects.toThrow(/drugs_target_at_least_reorder_level/)
})

it('rejects a negative target', async () => {
  // A negative value always violates one of the two check constraints (whichever
  // Postgres evaluates first) because reorder_level itself is never negative.
  await expect(db.query(`update drugs set target_stock_level = -1 where id='${drug}'`))
    .rejects.toThrow(/drugs_target_stock_level_non_negative|drugs_target_at_least_reorder_level/)
})

it('allows clearing the target back to null', async () => {
  await db.exec(`update drugs set target_stock_level = null where id='${drug}'`)
  expect((await db.query('select target_stock_level from drugs where id=$1', [drug])).rows[0].target_stock_level).toBeNull()
})
