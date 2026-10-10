// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { inspectOtacToken, mapOtacResponse, publicCccPolicy, runCccRequest } from '../../supabase/functions/_shared/cccProvider.ts'

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
  it('keeps existing-provider routing and never sends its credentials to OTAC', async () => {
    const { db } = database({ provider:'existing' }); const options=args(db); const fetcher=vi.fn()
    options.existing.mockResolvedValue({ ccCode:'12345', memberDetails:{ hpName:'Test Facility', attendanceDate:'2026-10-10', raw:{ sensitive:'data' } } })
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
    expect(updates.at(-1).status).toBe('unknown')
  })
})
