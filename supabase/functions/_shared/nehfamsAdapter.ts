// Contract source: NHIA HFAMS - HMIS Vanilla Postman collection.
// Production attendance remains blocked; transport is only used after server-side reservation.
export const NEHFAMS_BASE_URL = 'https://nehfams.nhia.gov.gh'
export const NEHFAMS_PATHS = Object.freeze({
 facility: '/api/hmis/auth/hpinfo', values: '/api/hmis/lovs',
 attendance: '/api/hmis/auth/attendance',
 referralRequest: '/api/hmis/auth/referral/request',
 referralConfirm: '/api/hmis/auth/referral/confirm',
})
export const nehfamsAdapter = Object.freeze({ live: false, baseUrl: NEHFAMS_BASE_URL })

export const NEHFAMS_ORIGINS = Object.freeze({
 test: 'https://elig.nhia.gov.gh:5007', production: NEHFAMS_BASE_URL,
})
type Environment = keyof typeof NEHFAMS_ORIGINS
type Facility = { hpn: string; name: string; authMode: string; otacRequired: boolean }
const string = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toUpperCase() === b.trim().replace(/\s+/g, ' ').toUpperCase()
export function validateNehfamsFacility(body: any, expected: { hpn: string; name: string }): Facility {
 if (!string(expected.hpn) || !string(expected.name) || body?.HPN !== expected.hpn || !string(body?.HPName) || !sameName(body.HPName, expected.name)) throw new Error('NeHFAMS facility identity mismatch.')
 if (typeof body.OTACAuthEnabled !== 'boolean' || !['1FA', '2FA'].includes(body.AuthMode)) throw new Error('Unsupported NeHFAMS authentication configuration.')
 // 2FA without OTAC may require a different authentication mechanism; do not bypass it.
 if (body.AuthMode === '2FA' && !body.OTACAuthEnabled) throw new Error('NeHFAMS authentication requires an unimplemented workflow.')
 return { hpn: body.HPN, name: body.HPName, authMode: body.AuthMode, otacRequired: body.OTACAuthEnabled }
}
export function prepareNehfamsAttendance(input: {
 environment: Environment; apiKey: string; apiSecret: string; cardType: string; cardNo: string; otac?: string; facility: Facility
}) {
 if (!Object.hasOwn(NEHFAMS_ORIGINS, input.environment)) throw new Error('Select an explicit NeHFAMS environment.')
 if (!string(input.apiKey) || !string(input.apiSecret) || /[\r\n]/.test(input.apiKey + input.apiSecret)) throw new Error('Invalid NeHFAMS credentials.')
 validateNehfamsFacility({ HPN: input.facility?.hpn, HPName: input.facility?.name, AuthMode: input.facility?.authMode, OTACAuthEnabled: input.facility?.otacRequired }, {hpn: input.facility?.hpn, name: input.facility?.name})
 if (input.cardType === 'NHISCARD' ? !/^\d{8}$/.test(input.cardNo) : input.cardType !== 'GHANACARD' || !/^GHA-\d{9}-\d$/.test(input.cardNo)) throw new Error('Invalid NeHFAMS card number or type.')
 if (input.facility.otacRequired && !/^\d{4}$/.test(input.otac || '')) throw new Error('Enter the four-digit OTAC provided by the NHIS client.')
 return {
  url: NEHFAMS_ORIGINS[input.environment] + NEHFAMS_PATHS.attendance,
  method: 'POST' as const, redirect: 'error' as const,
  headers: { 'x-nhia-apikey': input.apiKey, 'x-nhia-apisecret': input.apiSecret, 'Content-Type': 'application/json' },
  body: JSON.stringify({ CardType: input.cardType, CardNo: input.cardNo, ...(input.facility.otacRequired ? { OTAC: input.otac } : {}) }),
 }
}
export class NehfamsOutcomeError extends Error {
 constructor(public code: string) { super('NeHFAMS attendance was not confirmed. Check the recorded outcome before retrying.') }
}
export function mapNehfamsAttendance(body: any, expected: { facilityName: string; date: string; cardType: string; cardNo: string }) {
 if (body?.StatusCode !== 0) throw new NehfamsOutcomeError(body?.StatusCode === 1 ? 'application_failure' : 'invalid_response')
 const d = body.AttendanceData
 if (!d || !string(d.HPName) || !sameName(d.HPName, expected.facilityName)) throw new NehfamsOutcomeError('facility_mismatch')
 if (!string(d.HIN) || typeof d.CCC !== 'string' || !/^\d{5}$/.test(d.CCC) || !string(d.MemberName) || typeof d.UMN !== 'string' || !/^\d{8}$/.test(d.UMN) || typeof d.newCCC !== 'boolean' || typeof d.AuthID !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.AuthID) || d.AttendanceDate !== expected.date) throw new NehfamsOutcomeError('invalid_attendance')
 if (expected.cardType === 'NHISCARD' && d.UMN !== expected.cardNo) throw new NehfamsOutcomeError('member_mismatch')
 return { ok: true, source: 'nehfams', ccCode: d.CCC, memberDetails: {
  ccCode: d.CCC, hin: d.HIN, memberName: d.MemberName, memberNumber: d.UMN,
  attendanceDate: d.AttendanceDate, authId: d.AuthID, hpName: d.HPName, newCcc: d.newCCC,
  authType: typeof d.AttendanceType === 'string' ? d.AttendanceType : '',
  gender: typeof d.Gender === 'string' ? d.Gender : '',
  dateOfBirth: typeof d.DOB === 'string' ? d.DOB : '',
  eligibilityStartDate: typeof d.StartDate === 'string' ? d.StartDate : '',
  eligibilityEndDate: typeof d.EndDate === 'string' ? d.EndDate : '',
  attendanceVerificationSource: 'nehfams_api', attendanceVerificationStatus: 'confirmed',
 } }
}
// Injected transport supports isolated tests; callers must reserve in the ledger first.
// No retries, alternate origins or response bodies in errors.
export async function sendNehfamsAttendance(request: ReturnType<typeof prepareNehfamsAttendance>, fetcher: typeof fetch) {
 try {
  const response = await fetcher(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: 'error', signal: AbortSignal.timeout(25000) })
  if (!response.ok) throw new NehfamsOutcomeError('http_failure')
  return await response.json()
 } catch (error) {
  if (error instanceof NehfamsOutcomeError) throw error
  throw new NehfamsOutcomeError('unknown_outcome')
 }
}
export function requireLiveCccProvider(provider: unknown, testEnabled = false, environment = 'production'): 'existing' | 'otac' | 'nehfams' {
 if (provider === 'nehfams' && testEnabled && environment === 'test') return 'nehfams'
 if (provider === 'nehfams') throw new Error('NeHFAMS attendance generation is not available until NHIA response and connection validation is complete.')
 if (provider !== 'existing' && provider !== 'otac') throw new Error('Unsupported CCC provider')
 return provider
}
