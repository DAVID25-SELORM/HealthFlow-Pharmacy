// Contract source: NHIA HFAMS - HMIS Vanilla Postman collection.
// No transport is exposed until success/error schemas and facility identity are validated.
export const NEHFAMS_BASE_URL = 'https://nehfams.nhia.gov.gh'
export const NEHFAMS_PATHS = Object.freeze({
 facility: '/api/hmis/auth/hpinfo', values: '/api/hmis/lovs',
 attendance: '/api/hmis/auth/attendance',
 referralRequest: '/api/hmis/auth/referral/request',
 referralConfirm: '/api/hmis/auth/referral/confirm',
})
export const nehfamsAdapter = Object.freeze({ live: false, baseUrl: NEHFAMS_BASE_URL })
export function requireLiveCccProvider(provider: unknown): 'existing' | 'otac' {
 if (provider === 'nehfams') throw new Error('NeHFAMS attendance generation is not available until NHIA response and connection validation is complete.')
 if (provider !== 'existing' && provider !== 'otac') throw new Error('Unsupported CCC provider')
 return provider
}
