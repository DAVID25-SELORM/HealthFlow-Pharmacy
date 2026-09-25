import fs from 'node:fs/promises'
import path from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
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

describe('tier-access platform actions', () => {
  it('allows the super-admin active-organization check without a tenant selection', async () => {
    const source = await fs.readFile(functionSourcePath, 'utf8')
    const platformActions = source.slice(
      source.indexOf('const PLATFORM_ACTIONS_WITHOUT_ORGANIZATION'),
      source.indexOf('// âœ… NHIS PHARMACY LEVEL PATCH START')
    )
    const tenantGuard = source.indexOf(
      "if (!organizationId && !PLATFORM_ACTIONS_WITHOUT_ORGANIZATION.has(action))"
    )
    const activeOrganizationsRoute = source.indexOf("if (action === 'get_active_organizations')")

    expect(platformActions).toContain("'get_active_organizations'")
    expect(tenantGuard).toBeGreaterThan(-1)
    expect(activeOrganizationsRoute).toBeGreaterThan(tenantGuard)
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

    expect(source).toContain('const POSTGREST_FILTER_CHUNK_SIZE = 40')
    expect(source).toContain('size = POSTGREST_FILTER_CHUNK_SIZE')
    expect(reportBundle).toContain('chunkValues(matchingDrugIds)')
    expect(reportBundle).toContain('chunkValues(matchingSaleIds)')
    expect(reportBundle).not.toContain("salesQuery.in('id', matchingSaleIds)")
    expect(reportBundle).not.toContain(".in('drug_id', matchingDrugIds)")
  })

  it('chunks every NHIS report ID lookup to keep PostgREST URLs bounded', async () => {
    const source = await fs.readFile(functionSourcePath, 'utf8')
    const attachLines = source.slice(
      source.indexOf('const attachNhisClaimLines = async'),
      source.indexOf('const getReportBundle = async')
    )
    const reportBundle = source.slice(
      source.indexOf('const getReportBundle = async'),
      source.indexOf('const getReportDrugMatches = async')
    )

    expect(attachLines).toContain('chunkValues(claimIds)')
    expect(attachLines).toContain('chunkValues(servingUserIds)')
    expect(attachLines).not.toContain(".in('claim_id', claimIds)")
    expect(attachLines).not.toContain(".in('id', servingUserIds)")
    expect(reportBundle).toContain('chunkValues(missingClaimIds)')
    expect(reportBundle).not.toContain(".in('id', missingClaimIds)")
  })
})

describe('tier-access drug target stock level (Reorder Centre phase 1)', () => {
  it('accepts an optional target stock level on create and validates it against the reorder level', async () => {
    const source = await fs.readFile(functionSourcePath, 'utf8')
    const createPayload = source.slice(
      source.indexOf('const buildDrugCreatePayload'),
      source.indexOf('const findDrugByIdentity')
    )

    expect(createPayload).toContain("parseOptionalNonNegativeNumber(drugData.targetStockLevel, 'Target stock level')")
    expect(createPayload).toContain('assertTargetStockAtLeastReorderLevel(targetStockLevel, reorderLevel)')
    expect(createPayload).toContain('target_stock_level: targetStockLevel')
  })

  it.each([
    [12, 12], [0, 0], [12.5, 12.5], ['12', 12], [' 12 ', 12],
    [undefined, null], [null, null], ['', null], ['   ', null],
  ])('parses target stock level %s as %s without discarding JSON numbers', async (value, expected) => {
    const source = await fs.readFile(functionSourcePath, 'utf8')
    const helpers = source.slice(
      source.indexOf('const parseNonNegativeNumber'),
      source.indexOf('const assertTargetStockAtLeastReorderLevel')
    )
    // Execute the server's actual parser, not a source-string assertion that can
    // accidentally endorse the bug. The browser sends targetStockLevel as JSON number.
    const parse = new Function('normalizeText', `${stripTypeScriptTypes(helpers)}; return parseOptionalNonNegativeNumber`)(
      (input) => typeof input === 'string' ? input.trim() : ''
    )
    expect(parse(value, 'Target stock level')).toBe(expected)
    for (const invalid of [-1, NaN, Infinity, 'invalid']) {
      expect(() => parse(invalid, 'Target stock level')).toThrow('valid non-negative number')
    }
  })

  it('only updates target stock level when the request includes it, and re-validates against the effective reorder level', async () => {
    const source = await fs.readFile(functionSourcePath, 'utf8')
    const updatePayloadBlock = source.slice(
      source.indexOf('const updatePayload: Record<string, unknown> = {'),
      source.indexOf("if (Object.prototype.hasOwnProperty.call(drugData, 'unit'))")
    )

    expect(updatePayloadBlock).toContain("hasOwnProperty.call(drugData, 'targetStockLevel')")
    expect(updatePayloadBlock).toContain('updatePayload.target_stock_level = parseOptionalNonNegativeNumber')
    expect(updatePayloadBlock).toContain('assertTargetStockAtLeastReorderLevel(effectiveTargetStockLevel, effectiveReorderLevel)')
    // Falls back to the existing row's reorder/target level when this request doesn't touch it.
    expect(updatePayloadBlock).toContain('Number(existingDrug.reorder_level ?? 0)')
    expect(updatePayloadBlock).toContain('existingDrug.target_stock_level')
  })

  it('returns target_stock_level from get_drugs, the read path the Reorder Centre uses', async () => {
    const source = await fs.readFile(functionSourcePath, 'utf8')
    const selectFields = source.slice(
      source.indexOf('const INVENTORY_DRUG_SELECT_FIELDS'),
      source.indexOf('const REPORT_NHIS_CLAIM_SELECT_FIELDS')
    )

    expect(selectFields).toContain('reorder_level')
    expect(selectFields).toContain('target_stock_level')
  })
})
