// LOCKED Claim-IT CXF export format.
//
// The structure asserted here is the one taken from the West Point July export that was generated
// after the May-shape + signer release (locked-export-contract.json: key orders, PHP types, version
// metadata; no claim data). It differs from the genuine May Claim-IT file only where a difference was
// chosen on purpose (populated validation/prescriber sections; signer values are the exporting user's).
//
// If a test here fails, the export format changed. Do NOT edit the tests or the contract to make CI
// green. A deliberate format change requires ALL of: a new locked-export-contract.json taken from a file
// that imported into Claim-IT, a new LOCKED_STRUCTURE_SHA256 below, an updated
// config/production-baseline.json entry, and an impact note. See docs/claimit-export-lock.md.
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import locked from './locked-export-contract.json'
import may from './may-reference-contract.json'
import { readCxf, phpText, auditCxf } from '../../scripts/lib/cxf-reader.mjs'
import { profileCxf, contractFromProfile } from '../../scripts/lib/cxf-profile.mjs'
import { classifyContracts } from '../../scripts/lib/cxf-classify.mjs'
import { buildNhisClaimItCxf, buildNhisClaimItExportPayload } from '../services/nhisService'
import { sumAmounts } from './compatibility'

vi.mock('../lib/supabase', () => ({ supabase: {} }))

const LOCKED_STRUCTURE_SHA256 = 'af6fe24e3a8b4c0c883172569ebf83994d365bd09b431d83ed419512b9916616'
const STRUCTURE_KEYS = ['envelope', 'topLevel', 'envelopeFlags', 'sections', 'fields', 'metadata', 'appVersion', 'schema', 'versions',
  'accreditationFields', 'credUsageFields', 'claimTypes', 'claimStatuses', 'durationShape', 'validationSectionsPopulated']
// A section's row field list is read from its first row, so `prescribersfordays` (present only when a
// claim has prescriber-day rows) is excluded here; its column order stays locked through `schema`.
const structureOf = (contract) => Object.fromEntries(STRUCTURE_KEYS.map((key) => [key, key === 'fields'
  ? Object.fromEntries(Object.entries(contract.fields).filter(([table]) => table !== 'prescribersfordays')) : contract[key]]))
const fingerprint = (contract) => createHash('sha256').update(JSON.stringify(structureOf(contract))).digest('hex')

const claim = (id, amounts, extra = {}) => ({
  id: `claim-${id}`, claim_number: `SYN-${id}`, status: 'served', organization_type: 'pharmacy',
  claimit_attachment_base64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
  member_no: '12345678', ccc_no: '12345', surname: 'Synthetic', other_names: 'Patient', gender: 'female', date_of_birth: '1990-01-01',
  service_date_from: '2026-07-08', service_date_to: '2026-07-08', total_amount: sumAmounts(amounts),
  nhis_claim_medicines: amounts.map((amount, index) => ({
    drug_code: `SYN-${id}-${index}`, description: 'Synthetic medicine', unit: 'tablet', unit_price: amount, dispensed_qty: 1, total_amount: amount,
    dose: '1 tablet', frequency: 'OD', duration: '5 days', dispensary_date: '2026-07-08',
  })), ...extra,
})
const options = {
  organizationType: 'pharmacy', facilityType: 'Pharmacy', pharmacyFacilityLevel: 'P1', facilityCode: '03-05-001-02-01954-11-P1-2-011225',
  providerNumber: '03-05-01954', facilityName: 'WESTPOINT CHEMIST', yearMonth: '2026-07', generatedAt: '2026-09-21T19:28:50Z',
  claimsOfficerName: 'Claims Officer', accreditationExpiryDate: '2027-12-01', accreditationDateGenerated: '2025-12-29',
}
const actor = { name: 'Test Officer', id: 'officer@example.test', role: 'admin' }
const generate = async (claims, overrides = {}) => {
  const bytes = await buildNhisClaimItCxf(buildNhisClaimItExportPayload(claims, { ...options, exportActor: actor, ...overrides }))
  return { bytes, bundle: readCxf(bytes) }
}

describe('locked Claim-IT export format', () => {
  it('the locked contract itself cannot be edited silently', () => {
    expect(fingerprint(locked)).toBe(LOCKED_STRUCTURE_SHA256)
  })

  it('generated output has exactly the locked structure and no ACTUAL REGRESSION', async () => {
    const { bundle } = await generate([claim(1, ['10.25', '20.10', '221.52'])])
    const current = contractFromProfile(profileCxf(bundle))
    expect(fingerprint(current)).toBe(LOCKED_STRUCTURE_SHA256)
    expect(classifyContracts({ may, june: locked, current }).regressions).toEqual([])
  })

  it('the structure does not depend on how many claims or which data are exported', async () => {
    const { bundle } = await generate([claim(1, ['1.10']), claim(2, ['2.20', '3.30']), claim(3, ['0.05'])])
    expect(fingerprint(contractFromProfile(profileCxf(bundle)))).toBe(LOCKED_STRUCTURE_SHA256)
  })

  it('locks the individual items Claim-IT compatibility depends on', async () => {
    const { bundle } = await generate([claim(1, ['10.25'])])
    const data = bundle.get('data'), meta = data.get('_meta'), row = data.get('claims').get(0)
    const keys = [...row.keys()]
    expect(keys).toHaveLength(76)
    expect(keys.slice(23, 26)).toEqual(['status', 'claimType', 'submissionTime'])
    expect(keys.at(-1)).toBe('serviceOutcome')
    expect(Object.fromEntries([...meta.get('appVersion')].map(([k, v]) => [k, phpText(v)]))).toEqual(locked.appVersion)
    expect(row.get('servVersion')).toBeNull()
    expect([...meta.get('servVersions').values()]).toEqual([null])
    expect(phpText(row.get('status'))).toBe('VALID')
    expect(data.get('validations').size).toBeGreaterThan(0)
    expect(data.get('validation_zclaims').size).toBeGreaterThan(0)
    const accreditation = [...meta.get('accreditations').values()][0]
    expect(['accred_effectiveDate', 'dateGenerated', 'expiryDate'].map((k) => phpText(accreditation.get(k)))).toEqual(['2025-12-01', '2025-12-29', '2027-12-01'])
  })

  it('a VALID claim always carries a signer: stored signature, else the exporting user at export time', async () => {
    const signer = (row) => ['signedOn', 'signedByname', 'signedByuserID', 'signedByrole'].map((k) => phpText(row.get(k)))
    const exporter = (await generate([claim(1, ['10.25'])])).bundle.get('data').get('claims').get(0)
    expect(signer(exporter)).toEqual(['2026-09-21 19:28:50', 'Test Officer', 'officer@example.test', 'admin'])
    expect(phpText(exporter.get('signedOn')) > '2026-07-08').toBe(true) // never before the service date
    const stored = claim(1, ['10.25'], { signed_on: '2026-07-09T08:00:00Z', signed_by_user_id: 'u-1', signed_by_name: 'Stored Signer', signed_by_role: 'claims_officer' })
    expect(signer((await generate([stored])).bundle.get('data').get('claims').get(0))).toEqual(['2026-07-09 08:00:00', 'Stored Signer', 'u-1', 'claims_officer'])
    const partial = claim(1, ['10.25'], { signed_by_name: 'Only A Name' })
    expect(signer((await generate([partial])).bundle.get('data').get('claims').get(0))).toEqual(['2026-09-21 19:28:50', 'Test Officer', 'officer@example.test', 'admin'])
    // No identity available: null (warned), never invented.
    const none = (await generate([claim(1, ['10.25'])], { exportActor: null })).bundle.get('data').get('claims').get(0)
    expect(['signedOn', 'signedByname', 'signedByuserID', 'signedByrole'].map((k) => none.get(k))).toEqual([null, null, null, null])
  })

  it('totals are exact decimals and every relationship reconciles', async () => {
    const claims = Array.from({ length: 40 }, (_, i) => claim(i, ['7.35', '0.10', '0.20', '13.45']))
    const { bundle } = await generate(claims)
    expect(auditCxf(bundle).finances).toEqual({ invalidMedicineTotals: 0, invalidServiceTotals: 0, invalidClaimTotals: 0, invalidSummaries: 0, invalidBatchTotal: 0 })
    expect(bundle.get('data').get('_meta').get('totalCost')).toBe(Number(sumAmounts(claims.map((c) => c.total_amount))))
    expect(auditCxf(bundle).attachments).toMatchObject({ orphanReferences: 0, orphanData: 0, missingData: 0 })
  })

  it('is deterministic: identical input produces identical bytes', async () => {
    const claims = [claim(1, ['10.25', '20.10'])]
    expect((await generate(claims)).bytes).toEqual((await generate(claims)).bytes)
  })
})
