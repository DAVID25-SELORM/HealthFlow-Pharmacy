// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { prepareNehfamsAttendance, requireLiveCccProvider, validateNehfamsFacility, mapNehfamsAttendance, sendNehfamsAttendance } from '../../supabase/functions/_shared/nehfamsAdapter.ts'
const facility = { hpn: 'test', name: 'Test Facility', authMode: '1FA', otacRequired: false }
const input = { environment: 'test', apiKey: 'synthetic-key', apiSecret: 'synthetic-secret', cardType: 'NHISCARD', cardNo: '12345678', facility }
const expected = { facilityName: facility.name, date: '2026-10-20', cardType: input.cardType, cardNo: input.cardNo }
const body = { StatusCode: 0, AttendanceData: { HIN: 'synthetic', CCC: '01234', MemberName: 'Test Member', UMN: input.cardNo, newCCC: false, AuthID: '00000000-0000-4000-8000-000000000001', AttendanceDate: expected.date, HPName: facility.name } }
it('uses test origin and omits OTAC when disabled', () => {
 const r = prepareNehfamsAttendance(input)
 expect(r.url).toBe('https://elig.nhia.gov.gh:5007/api/hmis/auth/attendance')
 expect(JSON.parse(r.body)).toEqual({ CardType: 'NHISCARD', CardNo: '12345678' })
 expect(r.headers.Authorization).toBeUndefined()
 expect(r.redirect).toBe('error')
})
it('requires a four digit client OTAC only when enabled', () => {
 const required = { ...input, facility: { ...facility, authMode: '2FA', otacRequired: true } }
 expect(() => prepareNehfamsAttendance(required)).toThrow(/four-digit/)
 expect(JSON.parse(prepareNehfamsAttendance({ ...required, otac: '0123' }).body).OTAC).toBe('0123')
})
it('rejects unknown environments', () => { expect(() => prepareNehfamsAttendance({ ...input, environment: 'other' })).toThrow(/environment/) })
it('validates provider identity and authentication modes', () => {
 const b = { HPN: facility.hpn, HPName: facility.name, AuthMode: '1FA', OTACAuthEnabled: false }
 expect(validateNehfamsFacility(b, facility)).toEqual(facility)
 expect(() => validateNehfamsFacility({ ...b, HPN: 'other' }, facility)).toThrow(/identity/)
 expect(() => validateNehfamsFacility({ ...b, AuthMode: '3FA' }, facility)).toThrow(/Unsupported/)
 expect(() => validateNehfamsFacility({ ...b, AuthMode: '2FA' }, facility)).toThrow(/unimplemented/)
})
it('preserves leading zeros and an existing CCC flag', () => {
 expect(mapNehfamsAttendance(body, expected)).toMatchObject({ ccCode: '01234', memberDetails: { newCcc: false, attendanceVerificationSource: 'nehfams_api' } })
})
it.each([{ StatusCode: 1 }, { statusCode: 0 }, { StatusCode: 0 }, { ...body, AttendanceData: { ...body.AttendanceData, UMN: '87654321' } }, { ...body, AttendanceData: { ...body.AttendanceData, CCC: 1234 } }])('rejects unconfirmed or mismatched responses', value => {
 expect(() => mapNehfamsAttendance(value, expected)).toThrow(/not confirmed/)
})
it('never retries an ambiguous transport error or leaks its text', async () => {
 const transport = vi.fn().mockRejectedValue(new Error('private upstream details'))
 await expect(sendNehfamsAttendance(prepareNehfamsAttendance(input), transport)).rejects.toMatchObject({ code: 'unknown_outcome' })
 expect(transport).toHaveBeenCalledTimes(1)
})
it('does not treat HTTP 200 application failure as success', async () => {
 const transport = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ StatusCode: 1 }) })
 const response = await sendNehfamsAttendance(prepareNehfamsAttendance(input), transport)
 expect(() => mapNehfamsAttendance(response, expected)).toThrow(/not confirmed/)
})
it('keeps live dispatch blocked', () => { expect(() => requireLiveCccProvider('nehfams')).toThrow(/validation/) })
