// Internal HealthFlow extension points, not an NHIA wire contract.
export const NEHFAMS_PRODUCTION_ORIGIN = 'https://nehfams.nhia.gov.gh'
export type NehfamsOperation = 'authenticate' | 'manageAccessToken' | 'verifyMember' | 'generateAttendance' | 'retrieveAttendance' | 'validateRequest' | 'validateResponse' | 'validateFacility' | 'classifyError'
export interface NehfamsContext { organizationId: string; branchId: string | null; credentialVersion: number }
export interface NehfamsAdapter {
 readonly live: boolean
 execute(operation: NehfamsOperation, context: NehfamsContext, input: unknown): Promise<unknown>
}
// No transport or credential decoder is accepted until the contract is verified.
export const nehfamsAdapter: NehfamsAdapter = Object.freeze({
 live: false,
 async execute(_operation: NehfamsOperation, _context: NehfamsContext, _input: unknown): Promise<never> {
  throw new Error('NeHFAMS is not available: official API validation is pending')
 },
})
