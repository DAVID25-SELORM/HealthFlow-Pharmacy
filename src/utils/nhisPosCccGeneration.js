import { getNhiaMemberFeedbackMessage } from './nhiaFeedback'
import { cccResultMessage } from './cccResultMessage'
import { isGhanaCardNumber } from './nhiaMemberNumber'
import { normalizeAttendanceNewCcc, normalizeAttendanceVerification } from './nhiaAttendanceValues'

// NHIS-008: the till can ask NHIA for a CC code with an explicit click, for claims
// staff only, through the branch server's existing CC route. Nothing is generated
// automatically: no effect, timer or sale step calls it.
//
// The route itself is the authority. It identifies the organization and branch from the
// branch server's own credentials (never from this request) and refuses anyone who is not
// claims staff. These helpers only decide when the button is shown and enabled, and how
// the reply is read. The reply handling mirrors the NHIS claim form.

// Mirrors requireBranchClaimsAccess on the branch server. An assistant is never allowed.
export const NHIS_POS_CCC_GENERATION_ROLES = Object.freeze([
  'admin',
  'super_admin',
  'pharmacist',
  'billing',
  'claims_officer',
  'records_officer',
])

const normalizeRole = (role) => String(role ?? '').trim().toLowerCase()
const normalizeCode = (value) => String(value ?? '').replace(/\D/g, '')

export const canGenerateNhisCccAtPos = ({ role = '', canManageClaims = false } = {}) => {
  const activeRole = normalizeRole(role)
  if (activeRole === 'assistant') return false
  return NHIS_POS_CCC_GENERATION_ROLES.includes(activeRole) || canManageClaims === true
}

// Only the live providers can be used from the till. The legacy "existing" provider is
// configured through NHIS settings and is generated from the NHIS page instead.
export const canUseNhisPosCccGeneration = (policy) => {
  if (!policy?.enabled) return false
  if (policy.provider === 'nehfams') return ['test_configured', 'production_configured'].includes(policy.status)
  if (policy.provider === 'otac') return policy.status === 'configured'
  return false
}

export const getNhisPosCccUnavailableReason = (policy) => {
  const typeInstead = 'You can still type the 5-digit code.'
  if (!policy) return `CCC settings are loading or could not be loaded. Check the connection. ${typeInstead}`
  if (!policy.enabled) return `CCC generation is disabled for this facility. ${typeInstead}`
  if (policy.provider === 'otac') {
    return `The facility OTAC token needs configuration or renewal. Ask the platform administrator. ${typeInstead}`
  }
  if (policy.provider === 'nehfams') {
    return `NHIA NeHFAMS is not validated and active for this facility yet. Ask the platform administrator. ${typeInstead}`
  }
  return `Generate the code from the NHIS page for this facility. ${typeInstead}`
}

export const getNhisPosCccCardType = (memberNumber = '') => (isGhanaCardNumber(memberNumber) ? 'GHANACARD' : 'NHISCARD')

// The request sent to the branch server. No claim id: a sale has no claim yet, and the
// server then keys the attendance by member and date, so an attendance already confirmed
// for this member today (for example from the NHIS page) is reused, not requested again.
export const buildNhisPosCccContext = ({
  memberNumber = '',
  hin = '',
  patientName = '',
  serviceDate = '',
  totalAmount = 0,
  organizationType = '',
} = {}) => ({
  memberNumber,
  cardType: getNhisPosCccCardType(memberNumber),
  hin: String(hin ?? ''),
  patientName: String(patientName ?? '').trim(),
  serviceDate,
  organizationType,
  totalAmount: Number.isFinite(Number(totalAmount)) ? Number(totalAmount) : 0,
})

// The shared feedback text tells the claim form user to "save the claim details and retry
// later", which does not apply at a till where the sale needs the code.
const NETWORK_FEEDBACK_START = 'HealthFlow could not connect to the NHIA verification service.'
export const NHIS_POS_CCC_NETWORK_MESSAGE =
  'HealthFlow could not connect to the NHIA verification service. No CC code was generated. ' +
  'Type the code if you already have it, or ask a manager, admin or claims officer to complete the sale.'

// Reads the reply exactly as the NHIS claim form does.
export const interpretNhisPosCccResult = (result) => {
  if (result?.environment === 'test') {
    return {
      status: 'test',
      message: 'NHIA test attendance recorded in the test ledger. It cannot be used for a production sale.',
    }
  }
  if (result?.eligibilityError) {
    const feedback = getNhiaMemberFeedbackMessage(result.eligibilityError)
    return {
      status: 'eligibility',
      message: feedback.startsWith(NETWORK_FEEDBACK_START) ? NHIS_POS_CCC_NETWORK_MESSAGE : feedback,
    }
  }
  if (result?.status === 'pending' || result?.source === 'pending') {
    return { status: 'pending', message: result.message || 'Pending NHIA CCC verification.' }
  }

  const code = normalizeCode(result?.ccCode)
  if (!code) return { status: 'error', message: 'No CCC/CC code was returned.' }
  if (code.length !== 5) return { status: 'error', message: 'NHIA returned a CCC/CC code that is not exactly 5 digits.' }
  return { status: 'success', code, message: cccResultMessage(result) }
}

// NHIS-008: the attendance details NHIA returns with a generated code (the NHIA portal's
// "Attendance Result" screen: HIN, CCC, date, attendance ID, new CCC, attendance type,
// member, gender, date of birth, start and end dates) are carried into the NHIS review
// claim, as the NHIS claim form does. They are trusted only when this till generated the
// code just now: a code typed by hand, a test attendance or a reply for another member
// carries nothing.
const clean = (value) => String(value ?? '').trim()
const cleanDate = (value) => clean(value).slice(0, 10)

export const buildNhisPosAttendanceDetails = (result, { memberNumber = '' } = {}) => {
  if (!result || result.environment === 'test' || result.eligibilityError) return null
  if (result.status === 'pending' || result.source === 'pending') return null

  const details = result.memberDetails
  if (!details || typeof details !== 'object') return null

  const code = normalizeCode(result.ccCode)
  if (code.length !== 5) return null
  // The reply must describe the member this sale was for, when NHIA says which member that is.
  const repliedMember = clean(details.memberNumber).toUpperCase()
  const requestedMember = clean(memberNumber).toUpperCase()
  if (repliedMember && requestedMember && repliedMember !== requestedMember) return null

  return {
    ccCode: code,
    hin: clean(details.hin),
    memberName: clean(details.memberName),
    gender: clean(details.gender),
    dateOfBirth: cleanDate(details.dateOfBirth),
    eligibilityStartDate: cleanDate(details.eligibilityStartDate),
    eligibilityEndDate: cleanDate(details.eligibilityEndDate),
    attendanceDate: cleanDate(details.attendanceDate),
    authId: clean(details.authId),
    authType: clean(details.authType) || 'NHIS',
    newCcc: normalizeAttendanceNewCcc(details.newCcc),
    attendanceRequestId: clean(details.attendanceRequestId),
    transactionId: clean(details.transactionId),
    attendanceVerificationStatus: normalizeAttendanceVerification(details.attendanceVerificationStatus),
    attendanceVerificationSource: clean(details.attendanceVerificationSource),
  }
}

// The fields added to the review claim. Only while the code in the box is still the one NHIA
// generated: once the cashier changes the code, the details no longer describe it.
// The patient's own record stays the identity of the sale: NHIA's gender and date of birth fill
// only blanks, and the name is never replaced. NHIA's HIN fills a blank HIN only, so a
// different HIN never overwrites the patient record (the claim save writes the HIN back to it).
// Nothing is carried when the attendance date is not the sale's service date.
export const getNhisPosAttendanceClaimFields = (details, { currentCode = '', patient = {}, serviceDate = '' } = {}) => {
  if (!details || normalizeCode(currentCode) !== details.ccCode) return {}
  // The attendance belongs to one day. A sale completed on another day (for example after
  // midnight) must not claim it as its own attendance.
  if (details.attendanceDate && cleanDate(serviceDate) && details.attendanceDate !== cleanDate(serviceDate)) return {}

  const fields = {}
  if (details.hin && !clean(patient?.nhis_hin)) fields.hin = details.hin
  if (!clean(patient?.gender) && details.gender) fields.gender = details.gender
  if (!clean(patient?.date_of_birth) && details.dateOfBirth) fields.dateOfBirth = details.dateOfBirth
  if (details.authId) fields.authId = details.authId
  if (details.authType) fields.authType = details.authType
  if (details.newCcc) fields.newCcc = details.newCcc
  if (details.attendanceRequestId) fields.attendanceRequestId = details.attendanceRequestId
  if (details.attendanceDate) fields.nhiaAttendanceDate = details.attendanceDate
  if (details.eligibilityStartDate) fields.nhiaEligibilityStartDate = details.eligibilityStartDate
  if (details.eligibilityEndDate) fields.nhiaEligibilityEndDate = details.eligibilityEndDate
  if (details.transactionId) fields.nhiaTransactionId = details.transactionId
  if (details.attendanceVerificationStatus) fields.attendanceVerificationStatus = details.attendanceVerificationStatus
  if (details.attendanceVerificationSource) fields.attendanceVerificationSource = details.attendanceVerificationSource
  return fields
}

// A line for the review claim notes when NHIA and the patient record disagree, so the
// claims officer sees it before submission.
export const buildNhisPosAttendanceMismatchNote = (details, { currentCode = '', patient = {} } = {}) => {
  if (!details || normalizeCode(currentCode) !== details.ccCode) return ''
  const differences = []
  const recordedHin = clean(patient?.nhis_hin)
  if (recordedHin && details.hin && recordedHin.toUpperCase() !== details.hin.toUpperCase()) differences.push('HIN')
  const recordedDob = cleanDate(patient?.date_of_birth)
  if (recordedDob && details.dateOfBirth && recordedDob !== details.dateOfBirth) differences.push('date of birth')
  const recordedGender = clean(patient?.gender).charAt(0).toUpperCase()
  const nhiaGender = details.gender.charAt(0).toUpperCase()
  if (recordedGender && nhiaGender && recordedGender !== nhiaGender) differences.push('gender')
  if (!differences.length) return ''
  return `NHIA attendance differs from the patient record: ${differences.join(', ')}. Check before submission.`
}
