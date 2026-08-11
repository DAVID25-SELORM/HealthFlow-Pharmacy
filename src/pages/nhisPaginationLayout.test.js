import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('NHIS claims pagination layout', () => {
  it('offers only CLAIM-it-compatible day duration presets', () => {
    const source = readSource('./Nhis.jsx')
    const durationOptions = source.slice(
      source.indexOf('const DURATION_OPTIONS = ['),
      source.indexOf('const makeBlankClaim')
    )

    expect(durationOptions).toContain('Array.from({ length: 14 }')
    expect(durationOptions).toContain("'30 days'")
    expect(durationOptions).toContain("'60 days'")
    expect(durationOptions).toContain("'90 days'")
    expect(durationOptions).toContain("'120 days'")
    expect(durationOptions).toContain("'180 days'")
    expect(durationOptions).toContain("'365 days'")
    expect(durationOptions).not.toContain("'1 month'")
    expect(durationOptions).not.toContain("'1 week'")
  })

  it('renders page controls above and below the claims table', () => {
    const source = readSource('./Nhis.jsx')
    expect(source).toContain("{renderClaimsPagination('top')}")
    expect(source).toContain("{renderClaimsPagination('bottom')}")
  })

  it('scrolls to the claims table after changing pages', () => {
    const source = readSource('./Nhis.jsx')
    expect(source).toContain("scrollIntoView({ behavior: 'smooth', block: 'start' })")
  })

  it('keeps the known-patient directory out of the claims page flow', () => {
    const source = readSource('./Nhis.jsx')
    expect(source).toContain('className="nhis-known-patients-summary"')
    expect(source).toContain("onClick={() => setPageTab('patients')}")
    expect(source).not.toContain('className="nhis-patient-list-section"')
  })

  it('turns duration review counts into inline correction filters', () => {
    const source = readSource('./Nhis.jsx')
    expect(source).toContain("selectDurationRepairFilter('manual')")
    expect(source).toContain('data-duration-unresolved={isUnresolved')
    expect(source).toContain('Show all / Clear filter')
    expect(source).toContain('All duration issues resolved — Ready to export')
    expect(source).toContain('Apply Corrections & Continue')
    expect(source).toContain('[30, 60, 90, 180].map')
    expect(source).toContain('normalizeNhisManualDurationCorrection(enteredValue)')
    expect(source).toContain('onBlur={() => {')
  })
})
