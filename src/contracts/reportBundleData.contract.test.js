import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fetchCappedRows, mapCccRequestToLog, mapExportAlertToHistory } from '../../supabase/functions/_shared/reportData.ts'

const source = readFileSync('supabase/functions/tier-access/index.ts', 'utf8').split('\r\n').join('\n')
const between = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)))
const bundle = between('const getReportBundle = async (', 'const getReportDrugMatches = async (')

// a table of `size` rows that answers range requests the way the database does
const table = (size) => {
  const ranges = []
  const createQuery = () => ({
    range: async (from, to) => {
      ranges.push([from, to])
      const data = Array.from({ length: Math.max(0, Math.min(to + 1, size) - from) }, (_, index) => ({ id: from + index }))
      return { data, error: null }
    },
  })
  return { createQuery, ranges }
}

describe('reading report lists past one page', () => {
  it.each([
    [0, 0, false],
    [999, 999, false],
    [1000, 1000, false],
    [2400, 2400, false],
    [5000, 5000, false],
    [5001, 5000, true],
    [12000, 5000, true],
  ])('a list of %i rows gives %i and says truncated=%s', async (size, returned, truncated) => {
    const { createQuery } = table(size)
    const result = await fetchCappedRows(createQuery, 5000)
    expect(result.data).toHaveLength(returned)
    expect(result.truncated).toBe(truncated)
    expect(new Set(result.data.map((row) => row.id)).size).toBe(returned)
  })

  it('asks for one row more than the cap and no further', async () => {
    const { createQuery, ranges } = table(12000)
    await fetchCappedRows(createQuery, 2500)
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2500]])
  })

  it('fails as a whole when any page fails', async () => {
    let calls = 0
    const result = await fetchCappedRows(() => ({
      range: async () => {
        calls += 1
        return calls === 1 ? { data: Array.from({ length: 1000 }, () => ({})), error: null } : { data: null, error: new Error('timed out') }
      },
    }), 5000)
    expect(result.data).toBeNull()
    expect(result.error.message).toBe('timed out')
  })
})

describe('the export history and CC code records', () => {
  it('shapes an export record without inventing an amount or a file name', () => {
    const row = mapExportAlertToHistory({ id: 'a', artifact_sha256: 'abcdef0123456789abcdef', period: '2026-10-01', claim_count: 12, created_at: '2026-11-02T10:00:00Z' })
    expect(row).toMatchObject({
      batch_number: 'abcdef012345', export_format: 'CXF', status: 'exported', claim_count: 12, total_amount: null,
      file_name: '', branch_name: '-', error_message: 'Claim month 2026-10',
    })
  })

  it('shapes a CC code request with the officer and outcome, and no member number', () => {
    const row = mapCccRequestToLog({
      id: 'r', actor_id: 'u1', status: 'succeeded', error_code: null, created_at: '2026-11-02T10:00:00Z',
      member_number: '99999999', users: { full_name: 'Efua Officer' }, branches: { name: 'North' },
    })
    expect(row).toEqual({
      id: 'r', action: 'cc_code.generate', status: 'succeeded', createdAt: '2026-11-02T10:00:00Z',
      userId: 'Efua Officer', branch_name: 'North', errorMessage: '',
    })
    expect(JSON.stringify(row)).not.toContain('99999999')
  })

  it('falls back safely when the officer or branch is not known', () => {
    expect(mapCccRequestToLog({ actor_id: 'u2', status: 'unknown', error_code: 'reconciliation_required' }))
      .toMatchObject({ userId: 'u2', branch_name: '-', errorMessage: 'reconciliation_required' })
  })
})

describe('the report service reads only this facility', () => {
  it('no longer reads the tables that do not exist', () => {
    expect(source).not.toContain('nhia_submission_logs')
    expect(source).not.toContain('nhia_claim_batches')
  })

  it.each(['claim_export_alerts', 'ccc_attendance_requests'])('filters %s by facility', (name) => {
    const at = bundle.indexOf(`.from('${name}')`)
    expect(at).toBeGreaterThan(0)
    expect(bundle.slice(at, at + 400)).toContain(".eq('organization_id', organizationId)")
  })

  it('does not show facility export records to someone limited to one branch', () => {
    expect(bundle).toMatch(/scopedBranchId\n\s+\? Promise\.resolve\(\{ data: \[\], error: null, truncated: false \}\)\n\s+: fetchCappedRows\(\(\) => adminClient\n\s+\.from\('claim_export_alerts'\)/)
  })

  it('asks for the facility\'s own matching claims in one query, narrowed before the limit', () => {
    const at = bundle.indexOf('drug_match:nhis_claim_medicines!inner(id)')
    expect(at).toBeGreaterThan(0)
    const query = bundle.slice(at, bundle.indexOf('const { data: matchingClaims }', at))
    expect(query).toContain(".eq('organization_id', organizationId)")
    expect(query).toContain("{ referencedTable: 'drug_match' }")
    expect(query).toContain('.limit(nhisClaimLimit)')
    expect(query).toContain("matchingClaimsQuery.eq('branch_id', scopedBranchId)")
    expect(query).toContain("matchingClaimsQuery.gte('service_date_from', startDate)")
    // no medicine list is limited on its own, across every facility, any more
    expect(bundle).not.toContain(".from('nhis_claim_medicines')")
  })

  it('pages NHIS claims in an order with a unique last key', () => {
    const page = between('const getReportNhisPage = async (', 'const getReportBundle = async (')
    expect(page).toMatch(/\.order\('created_at', \{ ascending: false \}\)\n\s+\.order\('id', \{ ascending: false \}\)\n\s+\.range\(offset/)
  })

  it('tells the screen what was cut off and what could not be read', () => {
    expect(bundle).toContain('    unavailable,\n    pagination: {')
    expect(bundle).toContain('      truncated,\n    },')
  })
})
