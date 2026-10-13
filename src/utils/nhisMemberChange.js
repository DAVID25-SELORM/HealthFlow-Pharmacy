// Fields filled from a member lookup, a generated CCC or a selected patient. They describe one person and one
// attendance, so they must not survive an edit of the member number that produced them.
export const MEMBER_DEPENDENT_CLAIM_FIELDS = Object.freeze([
  'patientId', 'hin', 'surname', 'otherNames', 'folderNo', 'gender', 'dateOfBirth', 'patientAddress',
  'cccNo', 'ccCode', 'authId', 'authType', 'newCcc', 'otacCode',
  'attendanceVerificationStatus', 'attendanceVerificationSource', 'nhiaTransactionId',
  'nhiaEligibilityStartDate', 'nhiaEligibilityEndDate', 'nhiaAttendanceDate', 'nhiaMemberStatus',
  'nhiaMemberLookupPayload',
])

export const clearMemberDependentDetails = (form, blankForm) => {
  const next = { ...form }
  for (const key of MEMBER_DEPENDENT_CLAIM_FIELDS) next[key] = key in blankForm ? blankForm[key] : ''
  return next
}

// True when the details on the form were loaded for a different member number than the one now typed.
export const memberChangeInvalidatesDetails = (detailsMemberNo, nextMemberNo) =>
  Boolean(detailsMemberNo) && detailsMemberNo !== nextMemberNo
