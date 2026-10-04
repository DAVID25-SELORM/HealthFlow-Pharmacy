// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('ignores nested administrative changes but detects clinical and configuration changes', async () => {
 const db = new PGlite()
 try {
  await db.exec(readFileSync('supabase/migrations/20261004170000_stable_claim_export_fingerprints.sql','utf8'))
  const hash = async (value) => (await db.query('select claimit_fingerprint($1::jsonb) as hash',[JSON.stringify(value)])).rows[0].hash
  const claim = { amount: 20, status: 'ready', updated_at: 'before', nhis_claim_medicines: [{ quantity: 2 }] }
  const wrapped = { claim, config: { provider: 'A' } }
  const initial = await hash(wrapped)
  expect(await hash({ ...wrapped, claim: { ...claim, status: 'submitted', updated_at: 'after', rejection_reason: 'administrative' } })).toBe(initial)
  expect(await hash({ ...wrapped, claim: { ...claim, amount: 21 } })).not.toBe(initial)
  expect(await hash({ ...wrapped, claim: { ...claim, nhis_claim_medicines: [{ quantity: 3 }] } })).not.toBe(initial)
  expect(await hash({ ...wrapped, config: { provider: 'B' } })).not.toBe(initial)
  const old = (await db.query("select encode(sha256(convert_to(($1::jsonb-array['status','updated_at','rejection_reason'])::text,'UTF8')),'hex') as hash",[JSON.stringify(claim)])).rows[0].hash
  expect(await hash(claim)).toBe(old)
 } finally { await db.close() }
},30000)
