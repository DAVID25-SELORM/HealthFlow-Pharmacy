// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { validateNehfamsFacility } from '../../supabase/functions/_shared/nehfamsAdapter.ts'
import { TEST_ORIGIN, checkDocumentedFields, evaluateFacility, resolveOrigin, runCheck, summarizeShape } from '../../scripts/nehfams-hpinfo-shape-check.mjs'

const KEY = 'synthetic-key-VALUE-1'
const SECRET = 'synthetic-secret-VALUE-2'
const env = { NEHFAMS_TEST_API_KEY: KEY, NEHFAMS_TEST_API_SECRET: SECRET, NEHFAMS_EXPECTED_HPN: '123', NEHFAMS_EXPECTED_NAME: 'Test Facility' }
const good = { HPN: '123', HPName: 'Test Facility', UserName: 'someone', DeviceType: 'API', SchemeCode: 'ABC', UserType: 'API', AuthMode: '1FA', OTACAuthEnabled: false }
const reply = (body, { ok = true, status = 200 } = {}) => vi.fn(async () => ({ ok, status, headers: { get: () => 'application/json' }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }))
const run = (overrides = {}) => runCheck({ argv: ['--confirm-test-authorized'], env, fetcher: reply(good), ...overrides })

describe('hpinfo shape check: guards', () => {
  it('does nothing without the explicit confirmation flag', async () => {
    const fetcher = reply(good)
    const { exitCode, report } = await runCheck({ argv: [], env, fetcher })
    expect(exitCode).toBe(2); expect(report.stage).toBe('not_confirmed'); expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['https://nehfams.nhia.gov.gh', 'https://elig.nhia.gov.gh:5000', 'http://localhost:5007', 'https://example.com'])('refuses origin %s without sending anything', async (origin) => {
    const fetcher = reply(good)
    const { exitCode, report } = await runCheck({ argv: ['--confirm-test-authorized'], env: { ...env, NEHFAMS_BASE_URL: origin }, fetcher })
    expect(exitCode).toBe(2); expect(report.stage).toBe('refused_origin'); expect(fetcher).not.toHaveBeenCalled()
  })
  it('accepts only the test origin, with or without a trailing slash', () => {
    expect(resolveOrigin({})).toBe(TEST_ORIGIN)
    expect(resolveOrigin({ NEHFAMS_BASE_URL: TEST_ORIGIN + '/' })).toBe(TEST_ORIGIN)
  })
  it('names missing credential variables without echoing anything', async () => {
    const { exitCode, report } = await runCheck({ argv: ['--confirm-test-authorized'], env: { NEHFAMS_TEST_API_KEY: KEY }, fetcher: reply(good) })
    expect(exitCode).toBe(2); expect(report.missingVariables).toEqual(['NEHFAMS_TEST_API_SECRET'])
    expect(JSON.stringify(report)).not.toContain(KEY)
  })
  it('rejects credentials containing line breaks', async () => {
    const { exitCode } = await runCheck({ argv: ['--confirm-test-authorized'], env: { ...env, NEHFAMS_TEST_API_KEY: 'a\nb' }, fetcher: reply(good) })
    expect(exitCode).toBe(2)
  })
})

describe('hpinfo shape check: the single request', () => {
  it('sends exactly one GET to hpinfo on the test origin with documented headers and no redirects', async () => {
    const fetcher = reply(good)
    await run({ fetcher })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe('https://elig.nhia.gov.gh:5007/api/hmis/auth/hpinfo')
    expect(options).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(options.body).toBeUndefined()
    expect(Object.keys(options.headers).sort()).toEqual(['Accept', 'Content-Type', 'x-nhia-apikey', 'x-nhia-apisecret'])
  })
  it('never prints credentials or string values, on success or failure', async () => {
    const outputs = [
      (await run()).report,
      (await run({ fetcher: reply({ ...good, UserName: 'PRIVATE-NAME', error: 'PRIVATE-DETAIL' }, { ok: false, status: 400 }) })).report,
      (await run({ fetcher: vi.fn(async () => { throw Object.assign(new Error(`failed with ${KEY} ${SECRET}`), { name: 'TypeError' }) }) })).report,
      (await run({ fetcher: reply('PRIVATE <html>') })).report,
    ]
    const text = JSON.stringify(outputs)
    for (const secret of [KEY, SECRET, 'PRIVATE-NAME', 'PRIVATE-DETAIL', 'PRIVATE <html>', 'someone', 'Test Facility']) expect(text).not.toContain(secret)
  })
  it('does not retry after a failure', async () => {
    const fetcher = vi.fn(async () => { throw new Error('boom') })
    const { exitCode, report } = await run({ fetcher })
    expect(exitCode).toBe(3); expect(report.stage).toBe('network'); expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('reports HTTP failures by status and top-level keys only', async () => {
    const { exitCode, report } = await run({ fetcher: reply({ message: 'secret detail' }, { ok: false, status: 401 }) })
    expect(exitCode).toBe(3); expect(report).toMatchObject({ stage: 'http_status', httpStatus: 401, topLevelKeys: ['message'] })
  })
})

describe('hpinfo shape check: contract comparison', () => {
  it('passes when the documented PascalCase contract is met', async () => {
    const { exitCode, report } = await run()
    expect(exitCode).toBe(0)
    expect(report.reliedOnFieldsMatchContract).toBe(true)
    expect(report.configuration).toEqual({ authMode: '1FA', otacAuthEnabled: false })
    expect(report.healthflowFacilityCheck).toMatchObject({ checked: true, accepted: true, hpnMatches: true, nameMatches: true })
  })
  it('flags camelCase responses as different casing and exits 1', async () => {
    const { exitCode, report } = await run({ fetcher: reply({ hpn: '123', hpName: 'Test Facility', authMode: '1FA', otacAuthEnabled: false }) })
    expect(exitCode).toBe(1)
    expect(report.documentedFields.HPN).toMatchObject({ presence: 'different_case', actualKey: 'hpn' })
    expect(report.reliedOnFieldsMatchContract).toBe(false)
  })
  it('flags wrong types for fields HealthFlow relies on', () => {
    expect(checkDocumentedFields({ ...good, OTACAuthEnabled: 'false' }).OTACAuthEnabled).toMatchObject({ presence: 'exact', type: 'string', typeOk: false })
  })
  it('reports a missing field', () => { expect(checkDocumentedFields({ HPN: '1' }).AuthMode).toEqual({ presence: 'missing' }) })
  it('summarizes types only', () => {
    const shape = summarizeShape({ a: 'text', b: [1, 2], c: { d: null } })
    expect(JSON.stringify(shape)).not.toContain('text')
    expect(shape.fields.b).toMatchObject({ type: 'array', length: 2, item: { type: 'number' } })
  })
  it('does not print AuthMode values outside the documented set', async () => {
    const { report } = await run({ fetcher: reply({ ...good, AuthMode: 'PRIVATE-MODE' }) })
    expect(report.configuration.authMode).toBeNull()
    expect(JSON.stringify(report)).not.toContain('PRIVATE-MODE')
  })
})

describe('facility decision stays identical to the real adapter', () => {
  const expected = { hpn: '123', name: 'Test Facility' }
  it.each([
    good,
    { ...good, HPN: '999' },
    { ...good, HPName: 'Other Place' },
    { ...good, HPName: '  test   facility ' },
    { ...good, AuthMode: '3FA' },
    { ...good, AuthMode: '2FA', OTACAuthEnabled: true },
    { ...good, AuthMode: '2FA', OTACAuthEnabled: false },
    { ...good, OTACAuthEnabled: 'true' },
    { ...good, HPN: 123 },
    { hpn: '123', hpName: 'Test Facility', authMode: '1FA', otacAuthEnabled: false },
    { hpn: '123', hpName: 'Test Facility', authMode: '2FA', otacAuthEnabled: true },
    { hpn: '123', hpName: 'Test Facility', authMode: '2FA', otacAuthEnabled: false },
    { hpn: '123', hpName: 'Test Facility', authMode: '1FA', otacAuthEnabled: 'false' },
    {},
  ])('agrees with validateNehfamsFacility for %j', (body) => {
    let adapterAccepts = true
    try { validateNehfamsFacility(body, expected) } catch { adapterAccepts = false }
    expect(evaluateFacility(body, expected).accepted).toBe(adapterAccepts)
  })
  it('does not decide without an expected identity', () => {
    expect(evaluateFacility(good, {})).toEqual({ checked: false, accepted: null, reason: 'expected_identity_not_supplied' })
  })
})
