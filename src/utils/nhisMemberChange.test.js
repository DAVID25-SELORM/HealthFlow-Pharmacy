import { describe, expect, it } from 'vitest'
import { clearMemberDependentDetails, memberChangeInvalidatesDetails } from './nhisMemberChange'

const blank = { patientId: '', hin: '', surname: '', otherNames: '', folderNo: '', gender: '', dateOfBirth: '', patientAddress: '', cccNo: '', authId: '', authType: 'NHIS', newCcc: '', otacCode: '', attendanceVerificationStatus: '', attendanceVerificationSource: 'nehfams_manual', nhiaTransactionId: '', nhiaEligibilityStartDate: '', nhiaEligibilityEndDate: '', nhiaAttendanceDate: '', nhiaMemberStatus: '', nhiaMemberLookupPayload: null }

describe('clearing details when the member number changes', () => {
  it('clears the previous patient and attendance details but keeps the typed number and unrelated claim data', () => {
    const filled = {
      ...blank, memberNo: '93081041', surname: 'DZAMESHIE', otherNames: 'HAKEEMA', dateOfBirth: '2002-11-26', gender: 'FEMALE',
      hin: '0019996255', cccNo: '89697', ccCode: '89697', authId: 'auth-1', newCcc: true, nhiaMemberLookupPayload: { secret: 'x' },
      serviceDate: '2026-10-13', diagnosis: 'Malaria', notes: 'keep me',
    }
    const cleared = clearMemberDependentDetails(filled, blank)
    expect(cleared).toMatchObject({ memberNo: '93081041', serviceDate: '2026-10-13', diagnosis: 'Malaria', notes: 'keep me' })
    expect(cleared).toMatchObject({ surname: '', otherNames: '', dateOfBirth: '', gender: '', hin: '', cccNo: '', ccCode: '', authId: '', newCcc: '', nhiaMemberLookupPayload: null, authType: 'NHIS' })
  })

  it('does not mutate the original form', () => {
    const filled = { ...blank, surname: 'DZAMESHIE' }
    clearMemberDependentDetails(filled, blank)
    expect(filled.surname).toBe('DZAMESHIE')
  })

  it('only invalidates when details were loaded for a different number', () => {
    expect(memberChangeInvalidatesDetails('93081044', '93081041')).toBe(true)
    expect(memberChangeInvalidatesDetails('93081044', '93081044')).toBe(false)
    expect(memberChangeInvalidatesDetails('', '93081041')).toBe(false)
  })
})
