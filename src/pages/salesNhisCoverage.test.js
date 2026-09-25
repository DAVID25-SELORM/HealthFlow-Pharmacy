import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The POS page is too large to mount here; these pin the wiring that keeps a listed medicine with a
// missing tariff from being silently billed as private, and keep coverage line-level.
const source = readFileSync('src/pages/Sales.jsx', 'utf8').replace(/\r\n/g, '\n')

describe('POS NHIS coverage wiring', () => {
  it('carries the NHIS listing flag on the cart line, separate from the tariff', () => {
    expect(source).toContain('nhisListed: Boolean(drug.is_nhis_listed)')
    // covered-ness is still derived from code + tariff only, never from the listing flag
    expect(source).toContain("nhisCode: nhisPrice > 0 ? drug.nhis_code || null : null")
  })

  it('refuses to complete an NHIA claim sale while any line has a missing NHIS tariff', () => {
    const guard = source.slice(source.indexOf('nhisSettlement.unresolvedLines.length) {'))
    expect(guard.slice(0, 500)).toContain('NHIS tariff is missing for')
    expect(guard.slice(0, 600)).toContain('return')
  })

  it('shows each line\'s coverage in NHIA claim mode and warns about unresolved lines', () => {
    expect(source).toContain('NHIS tariff missing')
    expect(source).toContain('NHIS_LINE_COVERAGE.PARTIALLY_COVERED')
    expect(source).toContain('data-coverage={line.coverage}')
  })

  it('still sources the summary buckets from the shared settlement calculator (no second pricing path)', () => {
    expect(source).toContain('calculateNhisSplitSettlement({')
    expect(source).not.toMatch(/nhisCoveredAmount:\s*item\.price/)
  })
})
