// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { CccFailure, inspectOtacToken, mapOtacResponse, publicCccPolicy, runCccRequest } from '../../supabase/functions/_shared/cccProvider.ts'

const token = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
const good = { statusCode: 0, attendanceData: { ccc: '12345', authID: 'attendance-id', hpName: 'Test Facility', attendanceDate: '2026-10-10T00:00:00' } }
function database({ cached = false, saveError = false, provider = 'otac' } = {}) {
  const updates = []
  const policy = { provider, enabled: true, token_encrypted: 'encrypted', expected_hpn: '123', expected_facility_name: 'Test Facility' }
  const db = {
    rpc: vi.fn(async () => ({ data: { cached, result: { ccCode: '12345' }, request_id: 'request-id', policy } })),
    from: vi.fn(() => {
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: policy }),
        update: values => { updates.push(values); return chain }, single: async () => ({ data: saveError ? null : { id: 'request-id' }, error: saveError }) }
      return chain
    }),
  }
  return { db, updates }
}
const args = (db) => ({ db, org: 'org', actor: 'actor', branch: null, payload: { memberNumber: '12345678', serviceDate: '2026-10-10' }, decode: async () => token({ HPN: '123', exp: Math.floor(Date.now()/1000)+3600 }), existing: vi.fn(), preflightExisting: vi.fn() })
describe('CCC provider safety', () => {
  it('releases existing-provider failures before transmission', async () => {
    const { db, updates } = database({ provider: 'existing' })
    const options = args(db)
    options.existing.mockResolvedValue({ ok: false, error: 'private configuration detail' })
    await expect(runCccRequest(options)).rejects.toThrow(/No request was sent/)
    expect(updates.at(-1).status).toBe('not_created')
  })
  it('keeps an existing-provider failure after transmission unresolved', async () => {
    const { db, updates } = database({ provider: 'existing' })
    const options = args(db)
    options.existing.mockImplementation(async (_payload, onDispatch) => {
      onDispatch()
      return { ok: false, error: 'private upstream detail' }
    })
    await expect(runCccRequest(options)).rejects.toThrow(/unresolved/)
    expect(updates.at(-1)).toMatchObject({ status: 'unknown', error_code: 'existing_attendance_unconfirmed' })
    expect(options.existing).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['a clear NHIA eligibility message', { ok: true, ccCode: '', eligibilityError: 'NHIA member lookup did not return a CC code: NOT FOUND.' }, 'existing_member_rejected', /NOT FOUND/],
    ['a 200 reply with no code', { status: 'pending', source: 'pending', message: 'Pending CLAIM-it validation' }, 'existing_no_code_issued', /did not issue a CCC/],
  ])('lets the user retry after NHIA refuses with %s', async (_label, reply, code, message) => {
    const { db, updates } = database({ provider: 'existing' })
    const options = args(db)
    options.existing.mockImplementation(async (_payload, onDispatch) => { onDispatch(); return reply })
    const failure = await runCccRequest(options).catch(e => e)
    expect(failure.message).toMatch(message)
    expect(failure.message).not.toMatch(/unresolved|administrator/)
    expect(updates.at(-1)).toMatchObject({ status: 'not_created', error_code: code })
  })
  it('still locks when NHIA returns a malformed code, because an attendance may exist', async () => {
    const { db, updates } = database({ provider: 'existing' })
    const options = args(db)
    options.existing.mockImplementation(async (_payload, onDispatch) => { onDispatch(); return { ccCode: '1234567890123', memberDetails: { hpName: 'Test Facility' } } })
    await expect(runCccRequest(options)).rejects.toThrow(/unresolved/)
    expect(updates.at(-1)).toMatchObject({ status: 'unknown', error_code: 'existing_attendance_unconfirmed' })
  })
  it('treats an NHIA HTTP 4xx refusal as retryable but a timeout or 5xx as unresolved', async () => {
    const { db, updates } = database({ provider: 'existing' })
    const refused = args(db)
    refused.existing.mockImplementation(async (_payload, onDispatch) => { onDispatch(); throw new CccFailure('existing_http_404', 'NHIA rejected this request (HTTP 404). Check the NHIS number and card type, then try again.', true) })
    await expect(runCccRequest(refused)).rejects.toThrow(/Check the NHIS number/)
    expect(updates.at(-1)).toMatchObject({ status: 'not_created', error_code: 'existing_http_404' })
    const unsure = args(db)
    unsure.existing.mockImplementation(async (_payload, onDispatch) => { onDispatch(); throw new CccFailure('existing_http_503', 'The existing NHIA provider returned HTTP 503.') })
    await expect(runCccRequest(unsure)).rejects.toThrow(/unresolved/)
    expect(updates.at(-1)).toMatchObject({ status: 'unknown', error_code: 'existing_http_503' })
  })
  it('keeps existing-provider routing and never sends its credentials to OTAC', async () => {
    const { db } = database({ provider:'existing' }); const options=args(db); const fetcher=vi.fn()
    options.existing.mockImplementation(async (_payload, onDispatch) => {
      onDispatch()
      return { ccCode:'12345', memberDetails:{ hpName:'Test Facility', attendanceDate:'2026-10-10T00:00:00', raw:{ sensitive:'data' } } }
    })
    const result=await runCccRequest({ ...options, fetcher })
    expect(result.source).toBe('api'); expect(result.memberDetails.raw).toBeUndefined()
    expect(options.preflightExisting).toHaveBeenCalledTimes(1); expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects expired and wrong-facility tokens', () => {
    expect(() => inspectOtacToken(token({ HPN: '123', exp: 1 }), '123')).toThrow(/expired/)
    expect(() => inspectOtacToken(token({ HPN: '456', exp: Date.now()/1000+3600 }), '123')).toThrow(/HPN/)
  })
  it('does not expose encrypted tokens in policy readback', () => {
    expect(JSON.stringify(publicCccPolicy({ provider:'otac', enabled:true, token_encrypted:'secret' }))).not.toContain('secret')
  })
  it('requires a genuine complete response for the expected facility and date', () => {
    expect(mapOtacResponse(good, 'Test Facility', '2026-10-10').ccCode).toBe('12345')
    expect(() => mapOtacResponse(good, 'Other Facility', '2026-10-10')).toThrow(/facility/)
    expect(() => mapOtacResponse(good, 'Test Facility', '2026-10-11')).toThrow(/date/)
    expect(() => mapOtacResponse({ ...good, statusCode:1 }, 'Test Facility', '2026-10-10')).toThrow()
  })
  it('returns recorded attendance without another request or token refresh', async () => {
    const { db } = database({ cached:true }); const fetcher=vi.fn(); const options=args(db)
    options.decode=vi.fn(() => { throw new Error('expired') })
    expect((await runCccRequest({ ...options, fetcher })).reused).toBe(true)
    expect(fetcher).not.toHaveBeenCalled(); expect(options.decode).not.toHaveBeenCalled()
  })
  it('records success before returning and strips raw upstream data', async () => {
    const { db, updates } = database()
    const result=await runCccRequest({ ...args(db), fetcher:vi.fn(async () => ({ ok:true, json:async () => good })) })
    expect(result.attendanceRequestId).toBe('request-id'); expect(updates[0].status).toBe('succeeded')
    expect(result.memberDetails.raw).toBeUndefined()
  })
  it('does not retry or fall back after a timeout', async () => {
    const { db, updates } = database(); const options=args(db); const fetcher=vi.fn(async () => { throw new Error('timeout') })
    await expect(runCccRequest({ ...options, fetcher })).rejects.toThrow(/unresolved/)
    expect(fetcher).toHaveBeenCalledTimes(1); expect(options.existing).not.toHaveBeenCalled(); expect(updates[0].status).toBe('unknown')
  })
  it('does not report success when ledger persistence fails', async () => {
    const { db, updates } = database({saveError:true})
    await expect(runCccRequest({ ...args(db), fetcher:async () => ({ok:true,json:async()=>good}) })).rejects.toThrow(/unresolved/)
    expect(updates.at(-1)).toMatchObject({ status: 'unknown', error_code: 'attendance_recording_failed' })
  })
  it.each([
    [401, 'otac_auth_rejected'], [403, 'otac_auth_rejected'],
    [429, 'otac_http_429'], [500, 'otac_http_500'],
  ])('records HTTP %s without disclosing upstream content or retrying', async (status, code) => {
    const { db, updates } = database(); const options = args(db)
    const json = vi.fn(async () => ({ secret: 'private upstream content' }))
    const fetcher = vi.fn(async () => ({ ok: false, status, json }))
    await expect(runCccRequest({ ...options, fetcher })).rejects.toThrow(/Request: request-id/)
    expect(updates[0]).toMatchObject({ status: 'unknown', error_code: code })
    expect(json).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1); expect(options.existing).not.toHaveBeenCalled()
  })
  it.each([
    ['TimeoutError', 'otac_timeout'], ['TypeError', 'otac_network_error'],
  ])('classifies %s without exposing exception contents', async (name, code) => {
    const { db, updates } = database()
    const error = new Error('secret token and patient data'); error.name = name
    const failure = await runCccRequest({ ...args(db), fetcher: async () => { throw error } }).catch(e => e)
    expect(failure.message).not.toContain('secret')
    expect(updates[0]).toMatchObject({ status: 'unknown', error_code: code })
  })
  it('records invalid JSON as unresolved without exposing the response', async () => {
    const { db, updates } = database()
    await expect(runCccRequest({ ...args(db), fetcher: async () => ({ ok: true, json: async () => { throw new SyntaxError('private body') } }) })).rejects.toThrow(/unreadable response/)
    expect(updates[0]).toMatchObject({ status: 'unknown', error_code: 'otac_invalid_response' })
  })
  it('marks a failed token preflight as not sent and never calls OTAC', async () => {
    const { db, updates } = database(); const fetcher = vi.fn()
    await expect(runCccRequest({ ...args(db), decode: async () => 'invalid', fetcher })).rejects.toThrow(/No request was sent/)
    expect(fetcher).not.toHaveBeenCalled()
    expect(updates[0]).toMatchObject({ status: 'not_created', error_code: 'preflight_failed' })
  })

})


describe('NeHFAMS preparation dispatch safety', () => {
 it.each(['nehfams','unexpected'])('rejects %s before reservation or network activity', async provider => {
  const { db } = database({ provider })
  const options = args(db), fetcher = vi.fn()
  await expect(runCccRequest({ ...options, fetcher })).rejects.toThrow(/not available|Unsupported/)
  expect(db.rpc).not.toHaveBeenCalled()
  expect(options.existing).not.toHaveBeenCalled()
  expect(fetcher).not.toHaveBeenCalled()
 })
})

describe('NeHFAMS reserved test dispatch', () => {
 function setup({ failSave=false, failNetwork=false, statusCode=0 }={}) {
  const c={organization_id:'org',environment:'test',version:1,validated_version:1,validated_at:new Date().toISOString(),expected_hpn:'123',expected_name:'Test Facility',auth_mode:'1FA',otac_required:false,api_key_encrypted:'key',api_secret_encrypted:'secret'}
  const policy={provider:'nehfams',environment:'test',enabled:true}
  const updates=[]
  const db={rpc:vi.fn(async()=>({data:{request_id:'request-id',policy,connection:c}})),from:vi.fn(table=>{
   const chain={select:()=>chain,eq:()=>chain,maybeSingle:async()=>({data:table==='organization_nehfams_connection'?c:policy}),update:value=>{updates.push(value);return chain},single:async()=>({data:failSave?null:{id:'request-id'},error:failSave})};return chain
  })}
  const fetcher=vi.fn(async()=>{if(failNetwork) throw new Error('private');return {ok:true,json:async()=>({StatusCode:statusCode,AttendanceData:{HIN:'hin',CCC:'01234',MemberName:'Test Member',UMN:'12345678',newCCC:false,AuthID:'00000000-0000-4000-8000-000000000001',AttendanceDate:'2026-10-10',HPName:'Test Facility'}})}})
  return {db,updates,fetcher,options:{...args(db),decode:async x=>x,allowNehfamsTest:true,fetcher}}
 }
 it('reserves, maps and persists without legacy fallback',async()=>{
  const {options,db,updates,fetcher}=setup(); const r=await runCccRequest(options)
  expect(db.rpc).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();expect(options.existing).not.toHaveBeenCalled()
  expect(r).toMatchObject({ccCode:'01234',environment:'test',attendanceRequestId:'request-id',memberDetails:{attendanceRequestId:'request-id'}})
  expect(updates[0].status).toBe('succeeded')
 })
 it.each([{failNetwork:true},{failSave:true},{statusCode:1}])('keeps uncertain outcomes unresolved without replay',async behavior=>{
  const {options,updates,fetcher}=setup(behavior)
  await expect(runCccRequest(options)).rejects.toThrow(/unresolved/)
  expect(updates.at(-1).status).toBe('unknown');expect(fetcher).toHaveBeenCalledOnce();expect(options.existing).not.toHaveBeenCalled()
 })
})

it('marks a cached test result as test even when reconciled result omitted environment', async () => {
 const {db}=database({provider:'nehfams',cached:true})
 const policy={provider:'nehfams',environment:'test',enabled:true}
 db.from=vi.fn(()=>{const c={select:()=>c,eq:()=>c,maybeSingle:async()=>({data:policy})};return c})
 db.rpc.mockResolvedValue({data:{cached:true,result:{ccCode:'01234'},request_id:'cached-test'}})
 const options={...args(db),allowNehfamsTest:true}
 expect(await runCccRequest(options)).toMatchObject({environment:'test',attendanceRequestId:'cached-test'})
 expect(options.existing).not.toHaveBeenCalled()
})
it('retains reconciliation reference when outcome persistence itself throws',async()=>{
 const {db}=database()
 const normal=db.from
 db.from=vi.fn(table=>table==='ccc_attendance_requests'?{update:()=>{throw new Error('private database transport')}}:normal(table))
 const options=args(db);options.fetcher=vi.fn(async()=>{throw new Error('network lost')})
 await expect(runCccRequest(options)).rejects.toThrow(/Request: request-id/)
 expect(options.fetcher).toHaveBeenCalledOnce()
})
