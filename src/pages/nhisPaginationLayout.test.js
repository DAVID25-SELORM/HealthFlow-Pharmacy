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

    expect(durationOptions).toContain('Array.from({ length: 60 }')
    expect(durationOptions).toContain("'90 days'")
    expect(durationOptions).toContain("'120 days'")
    expect(durationOptions).toContain("'180 days'")
    expect(durationOptions).toContain("'365 days'")
    expect(durationOptions).not.toContain("'1 month'")
    expect(durationOptions).not.toContain("'1 week'")
  })

  it('shows prescribed quantity zero as a replaceable placeholder', () => {
    const source = readSource('./Nhis.jsx')
    const blankMedicine = source.slice(
      source.indexOf('const makeBlankMedicine = () => ({'),
      source.indexOf('const makeBlankMedicineForDate')
    )

    expect(blankMedicine).toContain("dispensedQty:  ''")
    expect(source).toContain('value={medForm.dispensedQty}')
    expect(source).toContain('placeholder="0"')
  })

  it('keeps the privileged correction reason optional', () => {
    const source = readSource('./Nhis.jsx')
    expect(source).toContain('Reason for correction (optional)')
    expect(source).not.toContain('Enter a reason for correction before saving this previously saved claim.')
  })

  it('recalculates claim serving status after a privileged medicine correction', () => {
    const source = readSource('./Nhis.jsx')
    const correctionFallback = source.slice(
      source.indexOf("payload.status = editingClaim.status"),
      source.indexOf('payload.expectedUpdatedAt')
    )

    expect(correctionFallback).toContain(
      'payload.servingStatus = getClaimServingStatus(effectiveClaimMedicines)'
    )
  })

  it('allows only privileged claim correctors to amend an existing medicine dispensing date', () => {
    const source = readSource('./Nhis.jsx')

    expect(source).toContain("' (privileged correction)'")
    expect(source).toMatch(/!isMedicineCounterAssistant\s+&&\s+editingMedicineIndex !== null\s+&&\s+!canEditNhisClaimAnytime/)
    expect(source).toContain('This correction is recorded in the claim audit history.')
  })

  it('keeps a new medicine pending when it is added after direct serving', () => {
    const source = readSource('./Nhis.jsx')

    expect(source).toContain('const isNewMedicineOnDirectlyServedClaim =')
    expect(source).toContain("editingMedicineIndex === null && isNhisClaimDirectlyServed(editingClaim)")
    expect(source).toContain("? 'pending'\n      : normalizeMedicineServingStatus")
    expect(source).toContain("servedQty = isNewMedicineOnDirectlyServedClaim\n      ? 0")
  })

  it('offers common dose choices while preserving custom dose entry', () => {
    const source = readSource('./Nhis.jsx')

    expect(source).toContain('const DOSE_OPTIONS = [')
    expect(source).toContain("'1 tablet'")
    expect(source).toContain('options={DOSE_OPTIONS}')
    expect(source).toContain('placeholder="Select or type dose"')
    expect(source).toContain('ariaLabel="Medicine dose"')
  })

  it('aligns manual CCC entry with privileged Admin and Claims Officer correction access', () => {
    const source = readSource('./Nhis.jsx')

    expect(source).toContain('const canManuallyEditCcCode = canEditNhisClaimAnytime ||')
    expect(source).toContain("assignedRole || '').trim().toLowerCase() === 'super_admin'")
    expect(source).toContain('Manual CC/CCC entry is restricted to an Admin, Claims Officer, or Super Admin.')
    expect(source).not.toContain("const canManuallyEditCcCode = role === 'admin' || role === 'super_admin'")
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
