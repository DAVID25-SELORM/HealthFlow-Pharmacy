// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { prepareNehfamsAttendance, requireLiveCccProvider, validateNehfamsFacility, mapNehfamsAttendance, sendNehfamsAttendance, fetchNehfamsFacility, field, attendanceDay } from '../../supabase/functions/_shared/nehfamsAdapter.ts'
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
it('allows each NeHFAMS environment only with its own server switch, never the other one', () => {
 expect(requireLiveCccProvider('nehfams', true, 'test', false)).toBe('nehfams')
 expect(requireLiveCccProvider('nehfams', false, 'production', true)).toBe('nehfams')
 expect(() => requireLiveCccProvider('nehfams', true, 'production', false)).toThrow(/not available/)
 expect(() => requireLiveCccProvider('nehfams', false, 'test', true)).toThrow(/not available/)
 expect(() => requireLiveCccProvider('nehfams', false, 'production', false)).toThrow(/not available/)
 expect(() => requireLiveCccProvider('nehfams', true, 'other', true)).toThrow(/not available/)
 expect(requireLiveCccProvider('existing')).toBe('existing'); expect(requireLiveCccProvider('otac')).toBe('otac')
})

const toCamelBody = () => ({ statusCode: 0, attendanceData: { hin: 'synthetic', ccc: '01234', memberName: 'Test Member', umn: input.cardNo, newCCC: false, authID: '00000000-0000-4000-8000-000000000001', attendanceDate: expected.date, hpName: facility.name } })

it('matches documented field names ignoring case, and nothing else', () => {
 expect(field({ HPN: 'a' }, 'HPN')).toBe('a')
 expect(field({ hpn: 'b' }, 'HPN')).toBe('b')
 expect(field({ OtacAuthEnabled: true }, 'OTACAuthEnabled')).toBe(true)
 expect(field({ hpnumber: 'c' }, 'HPN')).toBeUndefined()
 expect(field(null, 'HPN')).toBeUndefined(); expect(field([1], 'HPN')).toBeUndefined()
})
it('accepts lower-camelCase facility and attendance responses with the same strict checks', () => {
 const camelFacility = { hpn: facility.hpn, hpName: facility.name, authMode: '1FA', otacAuthEnabled: false }
 expect(validateNehfamsFacility(camelFacility, facility)).toEqual(facility)
 expect(() => validateNehfamsFacility({ ...camelFacility, otacAuthEnabled: 'false' }, facility)).toThrow(/Unsupported/)
 expect(mapNehfamsAttendance(toCamelBody(), expected)).toMatchObject({ ccCode: '01234', memberDetails: { newCcc: false, attendanceDate: expected.date } })
 expect(() => mapNehfamsAttendance({ ...toCamelBody(), attendanceData: { ...toCamelBody().attendanceData, ccc: 1234 } }, expected)).toThrow(/not confirmed/)
 expect(() => mapNehfamsAttendance({ ...toCamelBody(), attendanceData: { ...toCamelBody().attendanceData, umn: '87654321' } }, expected)).toThrow(/not confirmed/)
})
it('accepts the requested day with or without a midnight time, and nothing else', () => {
 expect(attendanceDay('2026-10-20')).toBe('2026-10-20')
 expect(attendanceDay('2026-10-20T00:00:00')).toBe('2026-10-20')
 expect(attendanceDay('2026-10-20T00:00:00.000')).toBe('2026-10-20')
 for (const rejected of ['2026-10-20T13:45:00', '2026-10-20T00:00:00Z', '20/10/2026', '2026-10-20 00:00:00', 20261020, null, undefined]) expect(attendanceDay(rejected)).toBeUndefined()
 const withTime = { ...body, AttendanceData: { ...body.AttendanceData, AttendanceDate: expected.date + 'T00:00:00' } }
 expect(mapNehfamsAttendance(withTime, expected).memberDetails.attendanceDate).toBe(expected.date)
 expect(() => mapNehfamsAttendance({ ...body, AttendanceData: { ...body.AttendanceData, AttendanceDate: expected.date + 'T13:45:00' } }, expected)).toThrow(/not confirmed/)
 expect(() => mapNehfamsAttendance({ ...body, AttendanceData: { ...body.AttendanceData, AttendanceDate: '2026-10-19' } }, expected)).toThrow(/not confirmed/)
})
it('reads the facility with one read-only GET to the test origin', async () => {
 const transport = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ HPN: 'x' }) })
 expect(await fetchNehfamsFacility({ environment: 'test', apiKey: 'k', apiSecret: 's', fetcher: transport })).toEqual({ HPN: 'x' })
 expect(transport).toHaveBeenCalledTimes(1)
 const [url, init] = transport.mock.calls[0]
 expect(url).toBe('https://elig.nhia.gov.gh:5007/api/hmis/auth/hpinfo')
 expect(init).toMatchObject({ method: 'GET', redirect: 'error' }); expect(init.body).toBeUndefined()
})
it('fails the facility read on an HTTP error, a bad environment or unsafe credentials without leaking', async () => {
 await expect(fetchNehfamsFacility({ environment: 'test', apiKey: 'k', apiSecret: 's', fetcher: vi.fn().mockResolvedValue({ ok: false, status: 500 }) })).rejects.toThrow(/lookup failed/)
 await expect(fetchNehfamsFacility({ environment: 'other', apiKey: 'k', apiSecret: 's', fetcher: vi.fn() })).rejects.toThrow(/environment/)
 const transport = vi.fn()
 await expect(fetchNehfamsFacility({ environment: 'test', apiKey: 'k\nx', apiSecret: 's', fetcher: transport })).rejects.toThrow(/credentials/)
 expect(transport).not.toHaveBeenCalled()
})
