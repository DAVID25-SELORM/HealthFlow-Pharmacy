import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const salesSource = readFileSync(resolve(process.cwd(), 'src/pages/Sales.jsx'), 'utf8')
const nhisServiceSource = readFileSync(resolve(process.cwd(), 'src/services/nhisService.js'), 'utf8')

describe('NHIS sales POS contract', () => {
  it('accepts the NHIA POS tender only for an NHIS-insured patient', () => {
    expect(salesSource).toContain('const isNhisPatient = (patient)')
    expect(salesSource).toContain('if (!isNhisPatient(selectedPatientForSale))')
  })

  it('uses the Ghana clinical calendar day and preserves actual serving metadata', () => {
    expect(salesSource).toContain("timeZone: 'Africa/Accra'")
    expect(salesSource).toContain('const serviceDate = getNhisCalendarDate(servedAt)')
    expect(salesSource).toContain('dispensaryDate: serviceDate')
    expect(salesSource).toContain('servedAt')
    expect(salesSource).toContain("servingStatus: 'fully_served'")
  })

  it('keeps POS-created claims out of submission until a claims officer reviews them', () => {
    expect(salesSource).toContain('allowIncompleteReview: true')
    expect(salesSource).toContain("status: 'returned_for_review'")
    expect(salesSource).toContain('Pending claims officer review before CLAIM-it submission.')
    expect(nhisServiceSource).toContain("if (!allowIncompleteReview) {")
  })

  it('blocks the sale before stock movement when cross-facility coverage cannot be cleared', () => {
    expect(salesSource).toContain('const assertNhiaPosMedicationCoverage = async')
    expect(salesSource).toContain('allowCloudWhenBranch: true')
    expect(salesSource).toContain('await assertNhiaPosMedicationCoverage(getNhisCalendarDate(saleTimestamp), nhisSettlement.lines)')
    expect(salesSource).toContain('NHIS active-medication verification is unavailable.')
    expect(nhisServiceSource).toContain('allowCloudWhenBranch = false')
    expect(nhisServiceSource).toContain('shouldUseBranchServer() && !allowCloudWhenBranch')
  })
})
