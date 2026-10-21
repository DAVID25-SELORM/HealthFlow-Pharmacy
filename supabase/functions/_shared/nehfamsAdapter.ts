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
// The workbook documents PascalCase names, but NHIA's own web systems and staff messages show lower-camelCase
// (for example authMode, otacAuthEnabled, attendanceData). Only the documented field NAMES are matched, ignoring case;
// every type and format check stays strict and no other field is invented.
export function field(source: any, name: string): any {
 if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined
 if (Object.hasOwn(source, name)) return source[name]
 const key = Object.keys(source).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
 return key === undefined ? undefined : source[key]
}
// YYYY-MM-DD, or the same calendar day serialized at midnight (as NHIA's web portal does). Any other time is rejected.
export function attendanceDay(value: unknown): string | undefined {
 return typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0+)?)?$/.exec(value)?.[1] : undefined
}
export function validateNehfamsFacility(body: any, expected: { hpn: string; name: string }): Facility {
 const hpn = field(body, 'HPN'), name = field(body, 'HPName'), mode = field(body, 'AuthMode'), otac = field(body, 'OTACAuthEnabled')
 if (!string(expected.hpn) || !string(expected.name) || hpn !== expected.hpn || !string(name) || !sameName(name, expected.name)) throw new Error('NeHFAMS facility identity mismatch.')
 if (typeof otac !== 'boolean' || !['1FA', '2FA'].includes(mode)) throw new Error('Unsupported NeHFAMS authentication configuration.')
 // 2FA without OTAC may require a different authentication mechanism; do not bypass it.
 if (mode === '2FA' && !otac) throw new Error('NeHFAMS authentication requires an unimplemented workflow.')
 return { hpn, name, authMode: mode, otacRequired: otac }
}
// Read-only. NHIA changes OTAC and authentication settings during its rollout, so the saved copy is never trusted
// for a request; callers read the facility again immediately before each attendance.
export async function fetchNehfamsFacility(input: { environment: Environment; apiKey: string; apiSecret: string; fetcher: typeof fetch }) {
 if (!Object.hasOwn(NEHFAMS_ORIGINS, input.environment)) throw new Error('Select an explicit NeHFAMS environment.')
 if (!string(input.apiKey) || !string(input.apiSecret) || /[\r\n]/.test(input.apiKey + input.apiSecret)) throw new Error('Invalid NeHFAMS credentials.')
 const response = await input.fetcher(NEHFAMS_ORIGINS[input.environment] + NEHFAMS_PATHS.facility, {
  method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
  headers: { 'x-nhia-apikey': input.apiKey, 'x-nhia-apisecret': input.apiSecret, 'Content-Type': 'application/json' },
 })
 if (!response.ok) throw new Error('NeHFAMS facility lookup failed.')
 return await response.json()
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
 const status = field(body, 'StatusCode')
 if (status !== 0) throw new NehfamsOutcomeError(status === 1 ? 'application_failure' : 'invalid_response')
 const d = field(body, 'AttendanceData')
 const hpName = field(d, 'HPName')
 if (!d || !string(hpName) || !sameName(hpName, expected.facilityName)) throw new NehfamsOutcomeError('facility_mismatch')
 const hin = field(d, 'HIN'), ccc = field(d, 'CCC'), memberName = field(d, 'MemberName'), umn = field(d, 'UMN'), isNew = field(d, 'newCCC')
 const authId = field(d, 'AuthID'), day = attendanceDay(field(d, 'AttendanceDate'))
 if (!string(hin) || typeof ccc !== 'string' || !/^\d{5}$/.test(ccc) || !string(memberName) || typeof umn !== 'string' || !/^\d{8}$/.test(umn) || typeof isNew !== 'boolean' || typeof authId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(authId) || day !== expected.date) throw new NehfamsOutcomeError('invalid_attendance')
 if (expected.cardType === 'NHISCARD' && umn !== expected.cardNo) throw new NehfamsOutcomeError('member_mismatch')
 const text = (name: string) => { const value = field(d, name); return typeof value === 'string' ? value : '' }
 return { ok: true, source: 'nehfams', ccCode: ccc, memberDetails: {
  ccCode: ccc, hin, memberName, memberNumber: umn,
  attendanceDate: day, authId, hpName, newCcc: isNew,
  authType: text('AttendanceType'), gender: text('Gender'), dateOfBirth: text('DOB').slice(0, 10),
  eligibilityStartDate: text('StartDate').slice(0, 10), eligibilityEndDate: text('EndDate').slice(0, 10),
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
// Each environment has its own server-side switch; enabling one never enables the other. The production switch is a
// deployment kill switch on top of the per-facility database approval.
export function requireLiveCccProvider(provider: unknown, testEnabled = false, environment = 'production', productionEnabled = false): 'existing' | 'otac' | 'nehfams' {
 if (provider === 'nehfams' && testEnabled && environment === 'test') return 'nehfams'
 if (provider === 'nehfams' && productionEnabled && environment === 'production') return 'nehfams'
 if (provider === 'nehfams') throw new Error('NeHFAMS attendance generation is not available until NHIA response and connection validation is complete.')
 if (provider !== 'existing' && provider !== 'otac') throw new Error('Unsupported CCC provider')
 return provider
}
