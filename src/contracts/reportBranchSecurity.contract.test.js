import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'supabase/functions/tier-access/index.ts'),
  'utf8'
)

describe('report branch and organisation security contract', () => {
  it('derives report branch scope from the authenticated profile before request input', () => {
    expect(source).toContain(
      ") => requesterProfile.branch_id || normalizeText(payload.branchId || payload.branch_id)"
    )
  })

  it('applies organisation and resolved branch scope to report parents', () => {
    expect(source).toContain(".eq('organization_id', organizationId)")
    expect(source.match(/if \(scopedBranchId\).*\.eq\('branch_id', scopedBranchId\)/g)?.length).toBeGreaterThanOrEqual(5)
  })

  it('keeps patient, prescriber, and serving-staff filters separate on the server', () => {
    expect(source).toContain('const patientTerm = toIlikeSearchTerm(payload.patient)')
    expect(source).toContain('const prescriberTerm = toIlikeSearchTerm(payload.prescriber)')
    expect(source).toContain('const servedByTerm = toIlikeSearchTerm(payload.servedBy || payload.staff || payload.userId)')
  })

  it('counts only completed POS transactions in medicine search results', () => {
    expect(source).toContain("normalizeText(row.payment_status) === 'completed'")
  })
})
