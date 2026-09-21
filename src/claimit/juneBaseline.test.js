// Regression protection anchored on the ACCEPTED West Point June 2026 HealthFlow export.
//
// Provenance (do not blur these):
//   A. MAY   - genuine Claim-IT export; structural reference only.
//   B. JUNE  - successful West Point HealthFlow export accepted by Claim-IT; the
//              proven compatibility baseline (west-point-june-contract.json).
//   C. CURRENT - the exporter under test.
// The "July" file under investigation belongs to HEALTH LIGHT LTD (provider
// 030509386), a different facility. It is NOT a West Point artifact and its
// differences are facility data, not exporter regressions.
import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import may from './may-reference-contract.json'
import june from './west-point-june-contract.json'
import { decimalUnits, sumAmounts } from './compatibility'
import { readCxf, parsePhp, auditCxf, phpText } from '../../scripts/lib/cxf-reader.mjs'
import { parsePhpStream, readCxfStream, BigPhpString } from '../../scripts/lib/cxf-stream-reader.mjs'
import { profileCxf, contractFromProfile } from '../../scripts/lib/cxf-profile.mjs'
import { classifyContracts, CATEGORY } from '../../scripts/lib/cxf-classify.mjs'
import { buildNhisClaimItCxf, buildNhisClaimItExportPayload } from '../services/nhisService'

vi.mock('../lib/supabase', () => ({ supabase: {} }))

const line = (index, amount) => ({
  drug_code: `SYN-${index}`, description: 'Synthetic medicine', unit: 'tablet', unit_price: amount, dispensed_qty: 1, total_amount: amount,
  dose: '1 tablet', frequency: 'OD', duration: '5 days', dispensary_date: '2026-06-16',
})
const claim = (id, amounts, extra = {}) => ({
  id: `claim-${id}`, claim_number: `SYN-${id}`, status: 'served', organization_type: 'pharmacy',
  claimit_attachment_base64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
  member_no: '12345678', ccc_no: '12345', surname: 'Synthetic', other_names: 'Patient', gender: 'female', date_of_birth: '1990-01-01',
  service_date_from: '2026-06-16', service_date_to: '2026-06-16', total_amount: sumAmounts(amounts),
  nhis_claim_medicines: amounts.map((amount, index) => line(`${id}-${index}`, amount)), ...extra,
})
const options = {
  organizationType: 'pharmacy', facilityType: 'Pharmacy', pharmacyFacilityLevel: 'P1', facilityCode: '03-05-001-02-00001-11-P1-2-010125',
  providerNumber: '03-05-00001', facilityName: 'Synthetic Facility', yearMonth: '2026-06', generatedAt: '2026-06-30T12:00:00Z',
  accreditationDateGenerated: '2025-01-01', accreditationExpiryDate: '2027-01-01',
}
const generate = async (claims, overrides = {}) => readCxf(await buildNhisClaimItCxf(buildNhisClaimItExportPayload(claims, { ...options, ...overrides })))
const contractOf = (bundle) => contractFromProfile(profileCxf(bundle))

describe('accepted June baseline vs current exporter', () => {
  it('has no actual regression for an unsigned legacy claim and classifies every difference from May', async () => {
    const current = contractOf(await generate([claim(1, ['10.25', '20.10', '221.52'])]))
    const outcome = classifyContracts({ may, june, current })
    expect(outcome.regressions).toEqual([])
    const categories = new Set(outcome.results.map((entry) => entry.category))
    expect(categories).toContain(CATEGORY.REQUIRED)
    expect(categories).toContain(CATEGORY.ACCEPTED)
    const accepted = outcome.results.filter((entry) => entry.category === CATEGORY.ACCEPTED).map((entry) => entry.check)
    // The four differences from May that June proved harmless stay exactly as they were.
    expect(accepted).toEqual(expect.arrayContaining([
      'claim field names and order (incl. claimType position)',
      'appVersion keys and values (cpuType absence)',
      'claim.servVersion type',
      'claim.signedOn type',
      'claim.signedByname type',
      'claim.signedByuserID type',
      'claim.signedByrole type',
      'validation sections populated',
    ]))
  })

  it('matches the June claim-level representation directly (not only through the classifier)', async () => {
    const bundle = await generate([claim(1, ['10.25', '20.10', '221.52'])])
    const row = bundle.get('data').get('claims').get(0)
    const keys = [...row.keys()]
    expect(keys).toEqual(june.fields.claims)
    expect(keys.indexOf('claimType')).toBe(75)
    for (const key of ['signedOn', 'signedByname', 'signedByuserID', 'signedByrole']) expect(row.get(key)).toBeNull()
    expect(phpText(row.get('servVersion'))).toBe('2023-02-01.250531')
    expect(phpText(row.get('status'))).toBe('VALID')
    expect(row.get('submissionTime')).toBeNull()
    expect(phpText(row.get('extraData'))).toBe('""')
    expect(bundle.get('data').get('_meta').get('appVersion').has('cpuType')).toBe(false)
  })

  it('keeps null / empty-string / populated semantics identical to the accepted June output', async () => {
    const bundle = await generate([claim(1, ['10.25'])])
    const types = auditCxf(bundle).types.claims
    for (const [field, expected] of Object.entries(june.claimFieldTypes)) {
      const actual = types[field]
      // Data-dependent fields may be a subset of June's observed types; never a new type.
      const norm = (type) => (type === 'empty string' ? 'string' : type)
      expect(actual.every((type) => expected.map(norm).includes(norm(type))), `${field}: ${actual} vs ${expected}`).toBe(true)
    }
  })

  it('preserves genuine stored signing evidence without inventing any and without requiring it', async () => {
    const signed = claim(1, ['10.25'], {
      signed_on: '2026-06-17T09:00:00Z', signed_by_user_id: 'user-1', signed_by_name: 'Stored Signer', signed_by_role: 'claims_officer',
    })
    const bundle = await generate([signed, claim(2, ['5.00'])])
    const [first, second] = [...bundle.get('data').get('claims').values()]
    expect(phpText(first.get('signedByname'))).toBe('Stored Signer')
    expect(phpText(first.get('signedByuserID'))).toBe('user-1')
    expect(first.get('signedOn')).not.toBeNull()
    for (const key of ['signedOn', 'signedByname', 'signedByuserID', 'signedByrole']) expect(second.get(key)).toBeNull()
    expect(classifyContracts({ may, june, current: contractOf(bundle) }).regressions).toEqual([])
  })

  it('flags deliberate deviations from the accepted June output as ACTUAL REGRESSION', () => {
    const mutate = (change) => classifyContracts({ may, june, current: change(structuredClone(june)) })
    const cases = {
      'claimType moved to the May position': (c) => { c.fields.claims = c.fields.claims.filter((k) => k !== 'claimType'); c.fields.claims.splice(24, 0, 'claimType'); return c },
      'cpuType injected': (c) => { c.appVersion.cpuType = 'x64'; return c },
      'servVersion forced null': (c) => { c.claimFieldTypes.servVersion = ['null']; return c },
      'section missing': (c) => { c.sections = c.sections.filter((s) => s !== 'validations'); return c },
      'schema column removed': (c) => { delete c.schema.claims.medCost; return c },
      'unexpected new claim type': (c) => { c.claimFieldTypes.medCost = ['float']; return c },
      'envelope changed': (c) => { c.envelope = [1, 2, 26]; return c },
    }
    for (const [name, change] of Object.entries(cases)) expect(mutate(change).hasRegression, name).toBe(true)
  })

  it('classifies provider differences as facility data and suspicious accreditation as SUSPICIOUS DATA', () => {
    const current = structuredClone(june)
    current.versions.providerLevel = 'PVT-HOS-CE'
    current.claimFieldTypes.physicianID = ['empty string']
    const outcome = classifyContracts({ may, june, current, accreditationIssues: ['ACCREDITATION_GENERATED_IN_FUTURE', 'ACCREDITATION_DATE_REVIEW_REQUIRED'] })
    expect(outcome.regressions).toEqual([])
    expect(outcome.results.filter((r) => r.category === CATEGORY.FACILITY).map((r) => r.check)).toEqual(['provider level code', 'claim.physicianID type'])
    expect(outcome.results.filter((r) => r.category === CATEGORY.SUSPICIOUS)).toHaveLength(2)
  })
})

describe('financial exactness (improvement over June, whose batch total drifted)', () => {
  it('emits exact decimal totals with no binary drift across many claims', async () => {
    const amounts = ['7.35', '0.10', '0.20', '13.45']
    const claims = Array.from({ length: 60 }, (_, index) => claim(index, amounts))
    // Guard: the accepted June export's failure mode (Number accumulation) really drifts on this data.
    const naive = claims.reduce((sum, item) => sum + Number(item.total_amount), 0)
    expect(String(naive).split('.')[1]?.length || 0).toBeGreaterThan(2)
    const bundle = await generate(claims)
    const meta = bundle.get('data').get('_meta')
    // _meta.totalCost is a PHP number (as in the accepted June export); it must equal the exact sum.
    const exact = sumAmounts(claims.map((item) => item.total_amount))
    expect(meta.get('totalCost')).toBe(Number(exact))
    expect(String(meta.get('totalCost')).split('.')[1]?.length || 0).toBeLessThanOrEqual(2)
    expect(phpText([...meta.get('PHC').values()][0].get('cost'))).toBe(exact)
    const audit = auditCxf(bundle)
    expect(audit.finances).toEqual({ invalidMedicineTotals: 0, invalidServiceTotals: 0, invalidClaimTotals: 0, invalidSummaries: 0, invalidBatchTotal: 0 })
    const first = bundle.get('data').get('claims').get(0)
    expect(decimalUnits(phpText(first.get('totalCost')), 2)).toBe(decimalUnits(phpText(first.get('medCost')), 2))
  })

  it('reproduces the 251.87 medicine/claim/summary reconciliation exactly', async () => {
    const bundle = await generate([claim(1, ['10.25', '20.10', '221.52'])])
    const data = bundle.get('data')
    const row = data.get('claims').get(0)
    expect(phpText(row.get('totalCost'))).toBe('251.87')
    expect(phpText(row.get('medCost'))).toBe('251.87')
    expect([...data.get('medicineentries').values()].reduce((sum, m) => sum + decimalUnits(phpText(m.get('cost')), 2), 0n)).toBe(25187n)
    expect(phpText(data.get('summaryitems').get(0).get('amount'))).toBe('251.8700') // 4-decimal string, as in June and May
  })

  it('exports a repaired claim (header total corrected to the exact line total) and reconciles after re-export', async () => {
    const broken = claim(1, ['10.00'], { total_amount: 9 })
    await expect(buildNhisClaimItCxf(buildNhisClaimItExportPayload([broken], options))).rejects.toThrow('does not reconcile')
    const repaired = { ...broken, total_amount: sumAmounts(broken.nhis_claim_medicines.map((m) => m.total_amount)) }
    const first = await buildNhisClaimItCxf(buildNhisClaimItExportPayload([repaired], options))
    const second = await buildNhisClaimItCxf(buildNhisClaimItExportPayload([repaired], options))
    expect(second).toEqual(first)
    const audit = auditCxf(readCxf(first))
    expect(audit.finances.invalidClaimTotals).toBe(0)
    expect(audit.finances.invalidBatchTotal).toBe(0)
  })
})

describe('bounded-memory CXF stream reader (development tooling)', () => {
  const php = (value) => {
    if (value === null) return 'N;'
    if (typeof value === 'number') return `i:${value};`
    if (typeof value === 'boolean') return `b:${value ? 1 : 0};`
    if (typeof value === 'string') return `s:${Buffer.byteLength(value)}:"${value}";`
    const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value)
    return `a:${entries.length}:{${entries.map(([k, v]) => php(typeof k === 'number' ? k : String(k)) + php(v)).join('')}}`
  }
  const chunked = async function* (bytes, size) {
    for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size)
  }
  const sample = { lockID: 'partial-export', n: 5, flag: true, nothing: null, empty: '', rows: [{ a: 'x', big: 'B'.repeat(5000) }, { a: 'é' }] }

  it('parses identically to the in-memory parser regardless of chunk boundaries', async () => {
    const bytes = Buffer.from(php(sample))
    const expected = parsePhp(bytes)
    for (const size of [1, 2, 7, 64, 4096, bytes.length]) {
      const { value } = await parsePhpStream(chunked(bytes, size), { maxInlineString: 1 << 20 })
      expect(JSON.stringify([...value], (_k, v) => (v instanceof Map ? [...v] : Buffer.isBuffer(v) ? v.toString() : v))).toBe(
        JSON.stringify([...expected], (_k, v) => (v instanceof Map ? [...v] : Buffer.isBuffer(v) ? v.toString() : v)))
    }
  })

  it('replaces large strings with a length-only placeholder without retaining them', async () => {
    const bytes = Buffer.from(php(sample))
    const { value } = await parsePhpStream(chunked(bytes, 13), { maxInlineString: 100 })
    const big = value.get('rows').get(0).get('big')
    expect(big).toBeInstanceOf(BigPhpString)
    expect(big.length).toBe(5000)
    expect(value.get('rows').get(1).get('a').toString()).toBe('é')
  })

  it('keeps the strict rejections of the in-memory parser', async () => {
    const parse = (text, size = 3) => parsePhpStream(chunked(Buffer.from(text), size))
    await expect(parse('a:2:{i:0;N;i:0;N;}')).rejects.toThrow('Duplicate')
    await expect(parse('N;N;')).rejects.toThrow('Trailing')
    await expect(parse('s:9:"abc";')).rejects.toThrow()
    await expect(parse('O:8:"stdClass":0:{}')).rejects.toThrow('Unsupported PHP type')
    await expect(parse('a:1:{i:0;')).rejects.toThrow('Truncated')
  })

  it('reads a real CXF file through the streaming path with the same audit as the in-memory reader', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const bytes = await buildNhisClaimItCxf(buildNhisClaimItExportPayload([claim(1, ['10.25', '20.10', '221.52'])], options))
    const path = join(mkdtempSync(join(tmpdir(), 'cxf-')), 'roundtrip.cxf')
    writeFileSync(path, bytes)
    const streamed = (await readCxfStream(path)).bundle
    expect(JSON.stringify(profileCxf(streamed))).toBe(JSON.stringify(profileCxf(readCxf(bytes))))
    const truncated = Buffer.concat([Buffer.from([1, 2, 25]), deflateSync(Buffer.from('a:1:{s:1:"a";'))])
    writeFileSync(path, truncated)
    await expect(readCxfStream(path)).rejects.toThrow('Truncated')
  })
})

// Real artifacts are patient data and are never committed. These run only when a
// local copy is supplied, and print/assert structure only.
const june19Path = process.env.CLAIMIT_JUNE_CXF || 'C:/Users/selorm/Downloads/JUN2026__40DE6034F0BC [030501954] (WESTPOINT CHEMIST)_2026-06-19-2026-06-19.cxf'
const juneFullPath = process.env.CLAIMIT_JUNE_FULL_CXF
describe('real West Point June artifacts (local only)', () => {
  it.skipIf(!existsSync(june19Path) || statSync(june19Path).size > 100 * 1024 * 1024)('June 2026-06-19 export reproduces the committed June contract', () => {
    const profile = profileCxf(readCxf(readFileSync(june19Path)))
    const outcome = classifyContracts({ may, june, current: contractOf(readCxf(readFileSync(june19Path))), accreditationIssues: profile.accreditation.issues })
    // The earliest June file pre-dates two deliberate, later fixes: the accreditation schema
    // correction (0800460) and day-normalized medicine durations (fe672dd). Nothing else differs.
    expect(outcome.regressions.map((r) => r.check)).toEqual(['_dbstruct schema (tables, columns, order, types)', 'medicine duration representation'])
    expect(profile.signers.missingAll).toBe(profile.signers.claims)
  })

  it.skipIf(!juneFullPath || !existsSync(juneFullPath))('full closed-June export (streamed) matches the committed June contract exactly', async () => {
    const { bundle } = await readCxfStream(juneFullPath)
    const profile = profileCxf(bundle)
    expect(contractFromProfile(profile)).toEqual(june)
    expect(profile.attachments).toMatchObject({ orphanReferences: 0, orphanData: 0, missingData: 0 })
    expect(profile.finances).toEqual({ invalidMedicineTotals: 0, invalidServiceTotals: 0, invalidClaimTotals: 0, invalidSummaries: 0, invalidBatchTotal: 0 })
    expect(profile.summaries.perClaim).toBe(true)
  }, 120000)
})
