import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const functionSourcePath = path.resolve('supabase/functions/tier-access/index.ts')

const extractArrayLiteral = (source, name) => {
  const pattern = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]\\.join`)
  const match = source.match(pattern)
  if (!match) throw new Error(`${name} not found`)
  return match[1]
}

describe('tier-access patient workspace compatibility', () => {
  it('only selects columns that belong to the live patients table', async () => {
    const source = await fs.readFile(functionSourcePath, 'utf8')
    const patientSelect = extractArrayLiteral(source, 'PATIENT_WORKSPACE_PATIENT_SELECT_FIELDS')

    expect(patientSelect).not.toContain("'branch_id'")
    expect(patientSelect).not.toContain("'folder_no'")
    expect(patientSelect).not.toContain("'last_visit_at'")
    expect(patientSelect).not.toContain("'nhis_member_no'")
    expect(patientSelect).not.toContain("'nhis_hin'")
    expect(patientSelect).toContain("'organization_id'")
    expect(patientSelect).toContain("'full_name'")
    expect(patientSelect).toContain("'insurance_id'")
  })
})

describe('tier-access report query bounds', () => {
  it('does not branch-filter patients because the live patients table has no branch_id', async () => {
    const source = await fs.readFile(functionSourcePath, 'utf8')
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

  it('chunks large report medicine and sale ID filters', async () => {
    const source = await fs.readFile(functionSourcePath, 'utf8')
    const reportBundle = source.slice(
      source.indexOf('const getReportBundle = async'),
      source.indexOf('const getReportDrugMatches = async')
    )

    expect(source).toContain('const chunkValues = <T,>(values: T[], size = 100)')
    expect(reportBundle).toContain('chunkValues(matchingDrugIds)')
    expect(reportBundle).toContain('chunkValues(matchingSaleIds)')
    expect(reportBundle).not.toContain("salesQuery.in('id', matchingSaleIds)")
    expect(reportBundle).not.toContain(".in('drug_id', matchingDrugIds)")
  })
})
