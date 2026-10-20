#!/usr/bin/env node
// Read-only NeHFAMS TEST connection check. Makes exactly one GET /api/hmis/auth/hpinfo to the NHIA TEST origin.
//
// It cannot create an attendance and cannot reach production: the origin is fixed, any other NEHFAMS_BASE_URL is refused,
// and the only request is the documented read-only facility-information call. Credentials come from environment
// variables, are never printed, never written to disk and never passed as arguments.
//
// It prints the response SHAPE (field names, JSON types, whether names match the documented casing) and yes/no checks,
// never string values. Run it only with NHIA's written authorization for the test credentials.
//
//   PowerShell (prompts without echo; clears the variables afterwards):
//     $k = Read-Host 'Test API key' -AsSecureString
//     $env:NEHFAMS_TEST_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($k))
//     $s = Read-Host 'Test API secret' -AsSecureString
//     $env:NEHFAMS_TEST_API_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
//     $env:NEHFAMS_EXPECTED_HPN = '<facility HPN>'; $env:NEHFAMS_EXPECTED_NAME = '<facility name>'   # optional identity check
//     node scripts/nehfams-hpinfo-shape-check.mjs --confirm-test-authorized
//     Remove-Item Env:NEHFAMS_TEST_API_KEY, Env:NEHFAMS_TEST_API_SECRET, Env:NEHFAMS_EXPECTED_HPN, Env:NEHFAMS_EXPECTED_NAME
//
// Exit codes: 0 ok and matches the documented contract, 1 request ok but contract differences found,
// 2 refused (missing confirmation/credentials or disallowed origin), 3 request or response failure.
import { pathToFileURL } from 'node:url'

export const TEST_ORIGIN = 'https://elig.nhia.gov.gh:5007'
export const HPINFO_PATH = '/api/hmis/auth/hpinfo'
const DOCUMENTED_FIELDS = ['HPN', 'HPName', 'UserName', 'DeviceType', 'SchemeCode', 'UserType', 'AuthMode', 'OTACAuthEnabled']
// The fields HealthFlow actually relies on, with the type it requires.
const RELIED_ON = { HPN: 'string', HPName: 'string', AuthMode: 'string', OTACAuthEnabled: 'boolean' }

const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

export function summarizeShape(value, depth = 0) {
  const type = typeOf(value)
  if (type === 'array') return { type, length: value.length, item: value.length && depth < 3 ? summarizeShape(value[0], depth + 1) : null }
  if (type === 'object') {
    if (depth >= 3) return { type, keys: Object.keys(value).length }
    return { type, fields: Object.fromEntries(Object.keys(value).map((key) => [key, summarizeShape(value[key], depth + 1)])) }
  }
  return { type }
}

export function checkDocumentedFields(body) {
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : []
  return Object.fromEntries(DOCUMENTED_FIELDS.map((name) => {
    if (keys.includes(name)) {
      const type = typeOf(body[name])
      return [name, { presence: 'exact', type, ...(RELIED_ON[name] ? { expectedType: RELIED_ON[name], typeOk: type === RELIED_ON[name] } : {}) }]
    }
    const other = keys.find((key) => key.toLowerCase() === name.toLowerCase())
    if (other) return [name, { presence: 'different_case', actualKey: other, type: typeOf(body[other]) }]
    return [name, { presence: 'missing' }]
  }))
}

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0
const sameName = (a, b) => a.trim().replace(/\s+/g, ' ').toUpperCase() === b.trim().replace(/\s+/g, ' ').toUpperCase()

// Documented field names are matched ignoring case, exactly as the adapter does.
const field = (source, name) => {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined
  if (Object.hasOwn(source, name)) return source[name]
  const key = Object.keys(source).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : source[key]
}

// Mirrors validateNehfamsFacility in supabase/functions/_shared/nehfamsAdapter.ts (kept equal by a test).
export function evaluateFacility(body, expected) {
  if (!nonEmpty(expected?.hpn) || !nonEmpty(expected?.name)) return { checked: false, accepted: null, reason: 'expected_identity_not_supplied' }
  const hpn = field(body, 'HPN'), name = field(body, 'HPName'), mode = field(body, 'AuthMode'), otac = field(body, 'OTACAuthEnabled')
  const hpnMatches = hpn === expected.hpn
  const nameMatches = nonEmpty(name) && sameName(name, expected.name)
  const base = { checked: true, hpnMatches, nameMatches }
  if (!hpnMatches || !nameMatches) return { ...base, accepted: false, reason: 'identity_mismatch' }
  if (typeof otac !== 'boolean' || !['1FA', '2FA'].includes(mode)) return { ...base, accepted: false, reason: 'unsupported_configuration' }
  if (mode === '2FA' && !otac) return { ...base, accepted: false, reason: 'requires_unimplemented_workflow' }
  return { ...base, accepted: true, reason: 'ok' }
}

export function resolveOrigin(env) {
  const requested = env.NEHFAMS_BASE_URL
  if (requested === undefined || String(requested).trim() === '') return TEST_ORIGIN
  if (String(requested).trim().replace(/\/+$/, '') !== TEST_ORIGIN) throw new Error('refused_origin')
  return TEST_ORIGIN
}

const USAGE = 'Read-only NeHFAMS TEST facility check. Requires --confirm-test-authorized, NEHFAMS_TEST_API_KEY and NEHFAMS_TEST_API_SECRET. See the header of scripts/nehfams-hpinfo-shape-check.mjs.'

export async function runCheck({ argv = [], env = {}, fetcher = fetch, now = () => new Date() } = {}) {
  if (argv.includes('--help')) return { exitCode: 0, report: { ok: true, usage: USAGE } }
  if (!argv.includes('--confirm-test-authorized')) {
    return { exitCode: 2, report: { ok: false, stage: 'not_confirmed', message: 'Pass --confirm-test-authorized only when NHIA has authorized these test credentials.' } }
  }
  let origin
  try { origin = resolveOrigin(env) } catch { return { exitCode: 2, report: { ok: false, stage: 'refused_origin', message: 'Only the NHIA test origin is allowed.' } } }
  const key = String(env.NEHFAMS_TEST_API_KEY ?? '').trim()
  const secret = String(env.NEHFAMS_TEST_API_SECRET ?? '').trim()
  const missing = [!key && 'NEHFAMS_TEST_API_KEY', !secret && 'NEHFAMS_TEST_API_SECRET'].filter(Boolean)
  if (missing.length || /[\r\n]/.test(key + secret)) return { exitCode: 2, report: { ok: false, stage: 'credentials', missingVariables: missing, invalidCharacters: /[\r\n]/.test(key + secret) } }

  const checkedAt = now().toISOString()
  let response
  try {
    response = await fetcher(origin + HPINFO_PATH, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-nhia-apikey': key, 'x-nhia-apisecret': secret },
    })
  } catch (error) {
    return { exitCode: 3, report: { ok: false, stage: 'network', checkedAt, errorName: typeof error?.name === 'string' ? error.name : 'Error' } }
  }
  let text = ''
  try { text = await response.text() } catch { return { exitCode: 3, report: { ok: false, stage: 'read', checkedAt, httpStatus: response.status } } }
  const contentType = response.headers?.get?.('content-type') ?? null
  let body
  let parsed = true
  try { body = text ? JSON.parse(text) : undefined } catch { parsed = false }
  const topLevelKeys = parsed && body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null

  if (!response.ok) return { exitCode: 3, report: { ok: false, stage: 'http_status', checkedAt, httpStatus: response.status, contentType, bodyLength: text.length, jsonBody: parsed, topLevelKeys } }
  if (!parsed || body === undefined) return { exitCode: 3, report: { ok: false, stage: 'json', checkedAt, httpStatus: response.status, contentType, bodyLength: text.length } }

  const fields = checkDocumentedFields(body)
  const reliedOnOk = Object.keys(RELIED_ON).every((name) => fields[name].presence === 'exact' && fields[name].typeOk === true)
  const facility = evaluateFacility(body, { hpn: env.NEHFAMS_EXPECTED_HPN, name: env.NEHFAMS_EXPECTED_NAME })
  const rawMode = field(body, 'AuthMode')
  const authMode = ['1FA', '2FA', '3FA'].includes(rawMode) ? rawMode : null
  const rawOtac = field(body, 'OTACAuthEnabled')
  const report = {
    ok: true, checkedAt, origin, path: HPINFO_PATH, httpStatus: response.status, contentType,
    shape: summarizeShape(body), documentedFields: fields, reliedOnFieldsMatchContract: reliedOnOk,
    configuration: { authMode, otacAuthEnabled: typeof rawOtac === 'boolean' ? rawOtac : null },
    healthflowFacilityCheck: facility,
    note: 'Values other than AuthMode and OTACAuthEnabled are deliberately not printed.',
  }
  return { exitCode: reliedOnOk && facility.accepted !== false ? 0 : 1, report }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode, report } = await runCheck({ argv: process.argv.slice(2), env: process.env })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = exitCode
}
