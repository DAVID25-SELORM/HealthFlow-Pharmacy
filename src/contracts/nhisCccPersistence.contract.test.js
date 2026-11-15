import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const nhisPage = readFileSync(resolve(process.cwd(), 'src/pages/Nhis.jsx'), 'utf8')
const salesPage = readFileSync(resolve(process.cwd(), 'src/pages/Sales.jsx'), 'utf8')

describe('NHIS CCC persistence contract', () => {
  it('waits for CCC operations before claim submission and rejects stale responses', () => {
    expect(nhisPage).toContain('if (generatingCcCode || lookingUpMember) {')
    expect(nhisPage).toContain('Wait for CCC verification to finish before saving this claim.')
    expect(nhisPage).toContain('requestRevision !== cccFormRevisionRef.current')
    expect(nhisPage).toContain('claimSubmitting || generatingCcCode || lookingUpMember || !canSaveCommunityPharmacyClaim')
    expect(nhisPage).toContain('if (claimSubmittingRef.current) return')
    expect(nhisPage).toContain('claimSubmittingRef.current = true')
    expect(nhisPage).toContain('claimSubmittingRef.current = false')
  })
  it('does not erase a manually entered CCC when automatic NHIA validation is unavailable or pending', () => {
    expect(nhisPage).not.toContain("setClaimForm((prev) => ({ ...prev, cccNo: '' }))")
    expect(nhisPage).not.toContain("setClaimForm((prev) => ({ ...prev, cccNo: '', ccCode: '' }))")
  })

  it('allows a CCC captured at NHIA POS checkout to be copied to the review claim', () => {
    expect(salesPage).toContain('const [nhiaCccNo, setNhiaCccNo] = useState(\'\')')
    expect(salesPage).toContain('cccNo: normalizeNhisCcCode(nhiaCccNo).slice(0, 5)')
    expect(salesPage).toContain('id="nhia-ccc-no"')
  })

  // NHIS-006 replaces the earlier behaviour where the POS code box was optional and a
  // blank code was "left for claims-officer review". The code is now required; a manager,
  // admin or claims officer may complete the sale without it by giving a recorded reason.
  it('requires a CCC at NHIA POS checkout, with a recorded reason for the senior-staff override', () => {
    expect(salesPage).not.toContain('or be left blank for claims-officer review')
    expect(salesPage).toContain('getNhisPosCccIssue({ cccNo: nhiaCccNo, role, overrideReason: nhiaCccOverrideReason })')
    expect(salesPage).toContain('buildNhisPosCccOverrideNote(')
  })
})
