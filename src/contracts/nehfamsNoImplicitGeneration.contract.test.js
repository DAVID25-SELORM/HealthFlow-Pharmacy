// @vitest-environment node
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// Normalize line endings: working trees on Windows check files out with CRLF.
const source = readFileSync('supabase/functions/tier-access/index.ts', 'utf8').replace(/\r\n/g, '\n')

it('never generates NeHFAMS attendance as a side effect of saving an NHIS claim', () => {
  const start = source.indexOf('const submitNhisPharmacyClaim = async')
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('// Persist claim to nhis_claims.', start))
  expect(body).toContain("implicitCccProvider !== 'nehfams'")
  expect(body.indexOf("implicitCccProvider !== 'nehfams'")).toBeLessThan(body.indexOf('generateNhiaCcCode('))
})

it('keeps explicit, reserved generation as the only other route to a NeHFAMS attendance', () => {
  const callers = [...source.matchAll(/generateNhiaCcCode\(/g)].length
  // claim-save path (guarded above), branch route, explicit NHIA_CC_CODE_ACTIONS route.
  // A new caller must be reviewed for implicit attendance creation before this count is raised.
  expect(callers).toBe(3)
})
