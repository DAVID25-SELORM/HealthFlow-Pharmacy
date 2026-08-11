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

  it('keeps organization-owned patients free of invalid branch predicates', () => {
    const reportBundle = source.slice(
      source.indexOf('const getReportBundle = async'),
      source.indexOf('const getReportDrugMatches = async')
    )
    const patientQueryStart = reportBundle.indexOf(".from('patients')")
    const patientQuery = reportBundle.slice(
      patientQueryStart,
      reportBundle.indexOf(".from('drugs')", patientQueryStart)
    )

    expect(patientQuery).toContain(".eq('organization_id', organizationId)")
    expect(patientQuery).not.toContain('branch_id')
  })

  it('keeps patient, prescriber, and serving-staff filters separate on the server', () => {
    expect(source).toContain('const patientTerm = toIlikeSearchTerm(payload.patient)')
    expect(source).toContain('const prescriberTerm = toIlikeSearchTerm(payload.prescriber)')
    expect(source).toContain('const servedByTerm = toIlikeSearchTerm(payload.servedBy || payload.staff || payload.userId)')
  })

  it('counts only completed POS transactions in medicine search results', () => {
    expect(source).toContain("normalizeText(row.payment_status) === 'completed'")
  })

  it('matches punctuated medicine names consistently and resolves NHIS serving staff', () => {
    expect(source).toContain('matchesReportSearchTokens')
    expect(source).toContain("drugSearchTerm.split(' ')[0]")
    expect(source).toContain(".select('id, full_name')")
    expect(source).toContain(".eq('organization_id', organizationId)")
    expect(source).toContain('served_by_user: servingUsersById.get(servingUserId) || null')
  })

  it('uses only columns available on the production inventory drugs table', () => {
    expect(source).not.toContain('drugs (name, generic_name, strength, dosage_form')
    const reportDrugSelect = source.match(/const REPORT_DRUG_SELECT_FIELDS = `([\s\S]*?)`/)?.[1] || ''
    expect(reportDrugSelect).not.toMatch(/^\s*strength,?\s*$/m)
    expect(reportDrugSelect).not.toMatch(/^\s*dosage_form,?\s*$/m)
  })
})
