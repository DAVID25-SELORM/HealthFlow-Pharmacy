import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NHIS_POS_CCC_GENERATION_ROLES,
  NHIS_POS_CCC_NETWORK_MESSAGE,
  buildNhisPosCccContext,
  canGenerateNhisCccAtPos,
  canUseNhisPosCccGeneration,
  getNhisPosCccCardType,
  getNhisPosCccUnavailableReason,
  interpretNhisPosCccResult,
  buildNhisPosAttendanceDetails,
  getNhisPosAttendanceClaimFields,
  buildNhisPosAttendanceMismatchNote,
} from './nhisPosCccGeneration'

describe('who sees the Generate button (NHIS-008)', () => {
  it.each(NHIS_POS_CCC_GENERATION_ROLES)('shows it to %s', (role) => {
    expect(canGenerateNhisCccAtPos({ role })).toBe(true)
  })

  it('treats the role case-insensitively', () => {
    expect(canGenerateNhisCccAtPos({ role: ' Pharmacist ' })).toBe(true)
    expect(canGenerateNhisCccAtPos({ role: 'ADMIN' })).toBe(true)
  })

  it.each(['cashier', 'technician', 'inventory_officer', '', undefined, null])('hides it from %s', (role) => {
    expect(canGenerateNhisCccAtPos({ role })).toBe(false)
  })

  it('allows a non-listed role that has the claims permission, but never an assistant', () => {
    expect(canGenerateNhisCccAtPos({ role: 'cashier', canManageClaims: true })).toBe(true)
    expect(canGenerateNhisCccAtPos({ role: 'assistant', canManageClaims: true })).toBe(false)
    expect(canGenerateNhisCccAtPos({ role: 'cashier', canManageClaims: 'yes' })).toBe(false)
  })
})

describe('when the button is enabled', () => {
  it('needs an enabled, configured live provider', () => {
    expect(canUseNhisPosCccGeneration({ enabled: true, provider: 'nehfams', status: 'production_configured' })).toBe(true)
    expect(canUseNhisPosCccGeneration({ enabled: true, provider: 'nehfams', status: 'test_configured' })).toBe(true)
    expect(canUseNhisPosCccGeneration({ enabled: true, provider: 'otac', status: 'configured' })).toBe(true)
  })

  it('stays off while a provider is not validated, expired, disabled, legacy or unknown', () => {
    expect(canUseNhisPosCccGeneration({ enabled: true, provider: 'nehfams', status: 'validation_pending' })).toBe(false)
    expect(canUseNhisPosCccGeneration({ enabled: true, provider: 'otac', status: 'needs_renewal' })).toBe(false)
    expect(canUseNhisPosCccGeneration({ enabled: true, provider: 'otac', status: 'needs_token' })).toBe(false)
    expect(canUseNhisPosCccGeneration({ enabled: false, provider: 'nehfams', status: 'production_configured' })).toBe(false)
    expect(canUseNhisPosCccGeneration({ enabled: true, provider: 'existing', status: 'existing_configuration' })).toBe(false)
    expect(canUseNhisPosCccGeneration({ enabled: true, provider: 'other', status: 'configured' })).toBe(false)
    expect(canUseNhisPosCccGeneration(null)).toBe(false)
    expect(canUseNhisPosCccGeneration(undefined)).toBe(false)
  })

  it('always tells staff they can still type the code', () => {
    const policies = [
      null,
      { enabled: false },
      { enabled: true, provider: 'otac', status: 'needs_renewal' },
      { enabled: true, provider: 'nehfams', status: 'validation_pending' },
      { enabled: true, provider: 'existing', status: 'existing_configuration' },
    ]
    for (const policy of policies) {
      expect(getNhisPosCccUnavailableReason(policy)).toMatch(/type the 5-digit code/)
    }
    expect(getNhisPosCccUnavailableReason(null)).toMatch(/loading or could not be loaded/)
    expect(getNhisPosCccUnavailableReason({ enabled: false })).toMatch(/disabled/)
    expect(getNhisPosCccUnavailableReason({ enabled: true, provider: 'otac' })).toMatch(/OTAC/)
    expect(getNhisPosCccUnavailableReason({ enabled: true, provider: 'nehfams' })).toMatch(/NeHFAMS/)
    expect(getNhisPosCccUnavailableReason({ enabled: true, provider: 'existing' })).toMatch(/NHIS page/)
  })
})

describe('the request sent to the branch server', () => {
  it('detects the card type from the number, including a foreign national country-code card', () => {
    expect(getNhisPosCccCardType('GHA-123456789-0')).toBe('GHANACARD')
    expect(getNhisPosCccCardType('KEN-729238252-0')).toBe('GHANACARD')
    expect(getNhisPosCccCardType('12345678')).toBe('NHISCARD')
    expect(getNhisPosCccCardType('')).toBe('NHISCARD')
  })

  it('builds the context without a claim id and never carries identity or branch', () => {
    const context = buildNhisPosCccContext({
      memberNumber: 'GHA-123456789-0',
      hin: '0031120339',
      patientName: '  Ama Mensah ',
      serviceDate: '2026-11-15',
      totalAmount: '42.5',
      organizationType: 'pharmacy',
    })

    expect(context).toEqual({
      memberNumber: 'GHA-123456789-0',
      cardType: 'GHANACARD',
      hin: '0031120339',
      patientName: 'Ama Mensah',
      serviceDate: '2026-11-15',
      organizationType: 'pharmacy',
      totalAmount: 42.5,
    })
    for (const key of ['claimId', 'claim_id', 'organizationId', 'branchId', 'actorId', 'activeRole']) {
      expect(context).not.toHaveProperty(key)
    }
  })

  it('tolerates missing values', () => {
    expect(buildNhisPosCccContext({ memberNumber: '12345678', totalAmount: 'abc' })).toMatchObject({
      memberNumber: '12345678',
      cardType: 'NHISCARD',
      hin: '',
      patientName: '',
      totalAmount: 0,
    })
  })
})

describe('reading the NHIA reply', () => {
  it('returns a 5-digit code with the usual confirmation message', () => {
    const outcome = interpretNhisPosCccResult({ ccCode: '48689', source: 'nehfams' })
    expect(outcome).toEqual({ status: 'success', code: '48689', message: 'CCC received from NHIA NeHFAMS.' })
  })

  it('says when a saved attendance was reused', () => {
    expect(interpretNhisPosCccResult({ ccCode: '48689', source: 'nehfams', reused: true }).message)
      .toMatch(/reused from an earlier confirmed attendance/)
  })

  it('strips non-digits from the code and rejects a code that is not 5 digits', () => {
    expect(interpretNhisPosCccResult({ ccCode: ' 4-8689 ' }).code).toBe('48689')
    expect(interpretNhisPosCccResult({ ccCode: '1234' })).toMatchObject({ status: 'error', message: expect.stringMatching(/not exactly 5 digits/) })
    expect(interpretNhisPosCccResult({ ccCode: '123456' })).toMatchObject({ status: 'error' })
    expect(interpretNhisPosCccResult({})).toMatchObject({ status: 'error', message: 'No CCC/CC code was returned.' })
    expect(interpretNhisPosCccResult(null)).toMatchObject({ status: 'error' })
  })

  it('never lets a test-environment attendance fill a production sale', () => {
    const outcome = interpretNhisPosCccResult({ environment: 'test', ccCode: '48689' })
    expect(outcome.status).toBe('test')
    expect(outcome).not.toHaveProperty('code')
  })

  it('does not use a code that came with an eligibility error', () => {
    const outcome = interpretNhisPosCccResult({ eligibilityError: 'Member status: inactive', ccCode: '48689' })
    expect(outcome.status).toBe('eligibility')
    expect(outcome).not.toHaveProperty('code')
    expect(outcome.message).toMatch(/inactive/i)
  })

  it('treats a pending reply as not ready, with no code', () => {
    expect(interpretNhisPosCccResult({ status: 'pending', message: 'Waiting for NHIA.', ccCode: '48689' }))
      .toEqual({ status: 'pending', message: 'Waiting for NHIA.' })
    expect(interpretNhisPosCccResult({ source: 'pending' }).status).toBe('pending')
  })

  it('uses till wording for a network failure, not the claim form wording', () => {
    const outcome = interpretNhisPosCccResult({ eligibilityError: 'dns error: failed to lookup address information' })
    expect(outcome).toEqual({ status: 'eligibility', message: NHIS_POS_CCC_NETWORK_MESSAGE })
    expect(outcome.message).not.toMatch(/save the claim details/)
    expect(outcome.message).toMatch(/complete the sale/)
  })
})

describe('attendance details carried into the review claim (NHIS-008)', () => {
  const memberDetails = {
    ccCode: '60597',
    hin: '47128067',
    memberName: 'Test Member',
    memberNumber: '12345678',
    gender: 'Female',
    dateOfBirth: '1980-10-31T00:00:00',
    eligibilityStartDate: '2026-10-05',
    eligibilityEndDate: '2027-10-04',
    attendanceDate: '2026-11-15',
    authId: 'E87A711E-ECE0-F111-9E6F-E0071BF203B7',
    authType: 'NHIS',
    newCcc: true,
    attendanceVerificationSource: 'nehfams_api',
    attendanceVerificationStatus: 'confirmed',
  }
  const reply = { ok: true, source: 'nehfams', ccCode: '60597', memberDetails }
  const details = buildNhisPosAttendanceDetails(reply, { memberNumber: '12345678' })

  it('reads every field on the NHIA attendance result', () => {
    expect(details).toMatchObject({
      ccCode: '60597',
      hin: '47128067',
      memberName: 'Test Member',
      gender: 'Female',
      dateOfBirth: '1980-10-31',
      eligibilityStartDate: '2026-10-05',
      eligibilityEndDate: '2027-10-04',
      attendanceDate: '2026-11-15',
      authId: 'E87A711E-ECE0-F111-9E6F-E0071BF203B7',
      authType: 'NHIS',
      newCcc: 'yes',
      attendanceVerificationStatus: 'confirmed',
      attendanceVerificationSource: 'nehfams_api',
    })
  })

  it.each([
    ['a test attendance', { ...reply, environment: 'test' }],
    ['an eligibility error', { ...reply, eligibilityError: 'Member not eligible' }],
    ['a pending reply', { ...reply, status: 'pending' }],
    ['a code that is not 5 digits', { ...reply, ccCode: '1234' }],
    ['a reply without member details', { ok: true, ccCode: '60597' }],
    ['a reply for another member', { ...reply, memberDetails: { ...memberDetails, memberNumber: '99999999' } }],
    ['nothing', null],
  ])('carries nothing from %s', (_label, result) => {
    expect(buildNhisPosAttendanceDetails(result, { memberNumber: '12345678' })).toBeNull()
  })

  it('defaults the attendance type to NHIS and ignores an unreadable new-CCC value', () => {
    const minimal = buildNhisPosAttendanceDetails(
      { ccCode: '60597', memberDetails: { ...memberDetails, authType: '', newCcc: 'maybe' } },
      { memberNumber: '12345678' }
    )
    expect(minimal.authType).toBe('NHIS')
    expect(minimal.newCcc).toBe('')
  })

  const claimContext = { currentCode: '60597', patient: { nhis_hin: '47128067', gender: 'F', date_of_birth: '1980-10-31' }, serviceDate: '2026-11-15' }

  it('adds the attendance fields to the review claim while the code is the generated one', () => {
    expect(getNhisPosAttendanceClaimFields(details, claimContext)).toEqual({
      authId: 'E87A711E-ECE0-F111-9E6F-E0071BF203B7',
      authType: 'NHIS',
      newCcc: 'yes',
      nhiaAttendanceDate: '2026-11-15',
      nhiaEligibilityStartDate: '2026-10-05',
      nhiaEligibilityEndDate: '2027-10-04',
      attendanceVerificationStatus: 'confirmed',
      attendanceVerificationSource: 'nehfams_api',
    })
  })

  it('adds nothing once the cashier has changed the code or there are no details', () => {
    expect(getNhisPosAttendanceClaimFields(details, { ...claimContext, currentCode: '60598' })).toEqual({})
    expect(getNhisPosAttendanceClaimFields(details, { ...claimContext, currentCode: '' })).toEqual({})
    expect(getNhisPosAttendanceClaimFields(null, claimContext)).toEqual({})
  })

  it('adds nothing when the attendance is for another day than the sale', () => {
    expect(getNhisPosAttendanceClaimFields(details, { ...claimContext, serviceDate: '2026-11-16' })).toEqual({})
  })

  it('fills the patient HIN, gender and date of birth only when the record has none, and never the name', () => {
    const blank = getNhisPosAttendanceClaimFields(details, { ...claimContext, patient: {} })
    expect(blank.hin).toBe('47128067')
    expect(blank.gender).toBe('Female')
    expect(blank.dateOfBirth).toBe('1980-10-31')
    expect(blank).not.toHaveProperty('surname')
    expect(blank).not.toHaveProperty('otherNames')

    const recorded = getNhisPosAttendanceClaimFields(details, claimContext)
    expect(recorded).not.toHaveProperty('hin')
    expect(getNhisPosAttendanceClaimFields(details, { ...claimContext, patient: { nhis_hin: '11111111' } })).not.toHaveProperty('hin')
    expect(recorded).not.toHaveProperty('gender')
    expect(recorded).not.toHaveProperty('dateOfBirth')
  })

  it('notes a difference between NHIA and the patient record for the claims officer', () => {
    expect(buildNhisPosAttendanceMismatchNote(details, claimContext)).toBe('')
    const note = buildNhisPosAttendanceMismatchNote(details, {
      ...claimContext,
      patient: { nhis_hin: '11111111', gender: 'M', date_of_birth: '1979-01-01' },
    })
    expect(note).toContain('HIN')
    expect(note).toContain('date of birth')
    expect(note).toContain('gender')
    expect(buildNhisPosAttendanceMismatchNote(details, { ...claimContext, currentCode: '00000', patient: { nhis_hin: '1' } })).toBe('')
  })
})

describe('point-of-sale wiring (source check)', () => {
  const sales = readFileSync(resolve(process.cwd(), 'src/pages/Sales.jsx'), 'utf8')

  it('only generates from an explicit click on the button', () => {
    expect(sales.match(/generateBranchNhiaCcCode\(/g) || []).toHaveLength(1)
    expect(sales).toContain('onClick={handleGenerateNhiaCcc}')

    const handlerStart = sales.indexOf('const handleGenerateNhiaCcc = async')
    const callIndex = sales.indexOf('generateBranchNhiaCcCode(')
    expect(handlerStart).toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(handlerStart)
  })

  it('shows the button only to claims staff and keeps the typed code box', () => {
    expect(sales).toContain('canGenerateNhisCccAtPos({ role, canManageClaims: profile?.can_manage_claims === true })')
    expect(sales).toContain('id="nhia-ccc-no"')
    expect(sales).toContain('getNhisPosCccIssue({ cccNo: nhiaCccNo, role, overrideReason: nhiaCccOverrideReason })')
  })

  it('carries the NHIA attendance details into the review claim only for the generated code', () => {
    expect(sales).toContain('setNhiaAttendanceDetails(buildNhisPosAttendanceDetails(result, { memberNumber }))')
    expect(sales).toContain('...nhisPosAttendanceFields,')
    expect(sales).toContain('getNhisPosAttendanceClaimFields(nhiaAttendanceDetails, nhisPosAttendanceContext)')
    const clearStart = sales.indexOf('const clearNhiaCccFields = useCallback')
    expect(sales.slice(clearStart, clearStart + 400)).toContain('setNhiaAttendanceDetails(null)')
  })

  it('discards a reply that arrives after the patient or code was cleared', () => {
    expect(sales).toContain('nhiaCccRequestRef.current += 1')
    expect(sales).toContain('requestId !== nhiaCccRequestRef.current')
  })
})
