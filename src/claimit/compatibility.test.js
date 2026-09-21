import { describe, expect, it, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import reference from './may-reference-contract.json'
import { CLAIM_IT_CLAIM_FIELD_ORDER, orderedRecord, decimalAmount, sumAmounts, claimItServiceVersion, accreditationIssues, classifyClaimSignature } from './compatibility'
import { parsePhp, readCxf, structuralContract, phpText, auditCxf } from '../../scripts/lib/cxf-reader.mjs'
import { buildNhisClaimItCxf, buildNhisClaimItExportPayload, getClaimItExportWarnings } from '../services/nhisService'

vi.mock('../lib/supabase', () => ({ supabase: {} }))

const signed = { signedOn:'2026-05-03T12:00:00Z',signedByuserID:'fixture-user',signedByname:'Fixture Signer',signedByrole:'claims_officer' }
const fixture = {
  id:'fixture-claim', claim_number:'FIXTURE-1', status:'served', organization_type:'pharmacy',
  claimit_attachment_base64:Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
  member_no:'12345678',ccc_no:'12345',surname:'Fixture',other_names:'Patient',gender:'female',date_of_birth:'1990-01-01',
  service_date_from:'2026-05-02',service_date_to:'2026-05-02',total_amount:251.87,
  signed_on:signed.signedOn,signed_by_user_id:signed.signedByuserID,signed_by_name:signed.signedByname,signed_by_role:signed.signedByrole,
  nhis_claim_medicines:['10.25','20.10','221.52'].map((amount,index) => ({
    drug_code:`FIXTURE-${index}`,description:'Synthetic medicine',unit:'tablet',unit_price:amount,dispensed_qty:1,total_amount:amount,
    dose:'1 tablet',frequency:'OD',duration:'1 day',dispensary_date:'2026-05-02',
  })),
}
const options = {
  organizationType:'pharmacy',facilityType:'Pharmacy',pharmacyFacilityLevel:'P1',facilityCode:'03-05-001-02-00001-11-P1-2-010125',providerNumber:'03-05-00001',
  facilityName:'Synthetic Facility',yearMonth:'2026-05',generatedAt:'2026-05-04T12:00:00Z',
  accreditationDateGenerated:'2025-01-01',accreditationExpiryDate:'2027-01-01',
}

describe('Claim-IT reference contract', () => {
  it('keeps all 76 claim fields in the genuine May order', () => {
    expect(CLAIM_IT_CLAIM_FIELD_ORDER).toEqual(reference.fields.claims)
    expect(CLAIM_IT_CLAIM_FIELD_ORDER).toHaveLength(76)
    expect(CLAIM_IT_CLAIM_FIELD_ORDER.indexOf('claimType')).toBe(24)
    const scrambled=Object.fromEntries([...CLAIM_IT_CLAIM_FIELD_ORDER].reverse().map((key) => [key,null]))
    expect(Object.keys(orderedRecord(scrambled))).toEqual(reference.fields.claims)
    expect(() => orderedRecord({...scrambled,unrecognized:null})).toThrow('schema mismatch')
  })
  it('distinguishes PHP null, empty string, arrays, zero, string zero, and false', () => {
    const parsed=parsePhp(Buffer.from('a:6:{i:0;N;i:1;s:0:"";i:2;a:0:{}i:3;i:0;i:4;s:1:"0";i:5;b:0;}'))
    expect(parsed.get(0)).toBeNull()
    expect(phpText(parsed.get(1))).toBe('')
    expect(parsed.get(2)).toBeInstanceOf(Map)
    expect(parsed.get(3)).toBe(0)
    expect(phpText(parsed.get(4))).toBe('0')
    expect(parsed.get(5)).toBe(false)
    // PHP arrays represent both empty JS collections; PHP objects are rejected.
    expect(() => parsePhp(Buffer.from('O:8:"stdClass":0:{}'))).toThrow('Unsupported PHP type')
  })
  it('rejects malformed envelopes, byte lengths, duplicate keys, and trailing input', () => {
    expect(() => readCxf(Buffer.from('bad'))).toThrow('envelope')
    expect(() => parsePhp(Buffer.from('s:9:"abc";'))).toThrow()
    expect(() => parsePhp(Buffer.from('a:2:{i:0;N;i:0;N;}'))).toThrow('Duplicate')
    expect(() => parsePhp(Buffer.from('N;N;'))).toThrow('Trailing')
    expect(readCxf(Buffer.concat([Buffer.from([1,2,25]),deflateSync(Buffer.from('N;'))]))).toBeNull()
  })
  it('handles exact decimal sums and rounding without binary addition drift', () => {
    expect(sumAmounts(['10.25','20.10','221.52'])).toBe('251.87')
    expect(sumAmounts(Array(10000).fill('0.01'))).toBe('100.00')
    expect(decimalAmount('1.005')).toBe('1.01')
    expect(decimalAmount('-1.005')).toBe('-1.01')
    expect(decimalAmount('999999999999.995')).toBe('1000000000000.00')
    expect(() => decimalAmount(NaN)).toThrow('Invalid decimal')
  })
  it('keeps medicine-only service versions null, as in the May reference', () => {
    expect(claimItServiceVersion({serviceCount:0,configuredVersion:'2023-02-01.250531'})).toBeNull()
    expect(claimItServiceVersion({serviceCount:1})).toBe('2023-02-01.250531')
    expect(claimItServiceVersion({serviceCount:0,configuredVersion:'other'})).toBeNull()
  })
  it('reports unsigned claims as a warning and never blocks or fabricates a signer', () => {
    expect(classifyClaimSignature({status:'VALID'})).toEqual({complete:false,missing:['signedOn','signedByname','signedByuserID','signedByrole'],warnings:['LEGACY_UNSIGNED_CLAIM']})
    expect(classifyClaimSignature(signed)).toEqual({complete:true,missing:[],warnings:[]})
    expect(classifyClaimSignature({...signed,signedOn:'2099-01-01'}).warnings).toEqual(['SIGNED_ON_IN_FUTURE'])
    expect(classifyClaimSignature({...signed,signedOn:'not-a-date'}).warnings).toEqual(['SIGNED_ON_INVALID'])
    expect(classifyClaimSignature({...signed,signedByname:'  '}).warnings).toEqual(['LEGACY_UNSIGNED_CLAIM'])
  })
  it('flags the HEALTH LIGHT accreditation anomaly (not West Point) without guessing a replacement date', () => {
    const source={generated:'2027-08-01',expiry:'2027-08-01',effective:'2025-10-01',today:'2026-09-20'}
    expect(accreditationIssues(source)).toEqual(['ACCREDITATION_GENERATED_IN_FUTURE','ACCREDITATION_DATE_REVIEW_REQUIRED'])
    expect(source.generated).toBe('2027-08-01')
    expect(accreditationIssues({...source,generated:'2025-02-30'})).toContain('ACCREDITATION_INVALID_GENERATED')
  })
  it('produces deterministic compatible PHP payloads and reconciled totals', async () => {
    const payload=buildNhisClaimItExportPayload([fixture],options)
    const bytes=await buildNhisClaimItCxf(payload)
    expect(await buildNhisClaimItCxf(payload)).toEqual(bytes)
    const bundle=readCxf(bytes),contract=structuralContract(bundle)
    expect(contract.topLevel).toEqual(reference.topLevel)
    expect(contract.sections).toEqual(reference.sections)
    expect(contract.schema).toEqual(reference.schema)
    expect(contract.fields.claims).toEqual(reference.fields.claims)
    expect(contract.fields.medicineentries).toEqual(reference.fields.medicineentries)
    expect(contract.fields.summaryitems).toEqual(reference.fields.summaryitems)
    expect(contract.appVersion).toEqual(Object.keys(reference.appVersion))
    expect(bundle.get('data').get('_meta').get('appVersion').has('cpuType')).toBe(true)
    const row=bundle.get('data').get('claims').get(0)
    expect(phpText(row.get('medCost'))).toBe('251.87')
    // Genuine stored signing evidence is preserved when present.
    expect(phpText(row.get('signedByname'))).toBe('Fixture Signer')
    expect(row.get('servVersion')).toBeNull()
    expect(auditCxf(bundle).finances).toEqual({invalidMedicineTotals:0,invalidServiceTotals:0,invalidClaimTotals:0,invalidSummaries:0,invalidBatchTotal:0})
  })
  it('retains a service tariff in populated service exports and reconciles both components', async () => {
    const claim={...fixture,total_amount:261.87,nhis_claim_services:[{
      gdrg_code:'FIXTURE-SERVICE',description:'Synthetic service',unit_price:10,quantity:1,total_amount:10,
      service_date:'2026-05-02',tariff_version:'FEB 2023',
    }]}
    const bundle=readCxf(await buildNhisClaimItCxf(buildNhisClaimItExportPayload([claim],options)))
    const row=bundle.get('data').get('claims').get(0)
    expect(phpText(row.get('servVersion'))).toBe('2023-02-01.250531')
    expect(phpText(row.get('procCost'))).toBe('10.00')
    expect(auditCxf(bundle).finances.invalidClaimTotals).toBe(0)
    expect(auditCxf(bundle).finances.invalidSummaries).toBe(0)
  })
  it('exports unsigned legacy claims with null signers without weakening financial checks', async () => {
    const unsigned={...fixture,signed_on:null,signed_by_user_id:null,signed_by_name:null,signed_by_role:null}
    const payload=buildNhisClaimItExportPayload([unsigned],options)
    expect(getClaimItExportWarnings(payload)).toEqual([{claimNumber:'FIXTURE-1',warnings:['LEGACY_UNSIGNED_CLAIM']}])
    const row=readCxf(await buildNhisClaimItCxf(payload)).get('data').get('claims').get(0)
    for (const key of ['signedOn','signedByname','signedByuserID','signedByrole']) expect(row.get(key)).toBeNull()
    await expect(buildNhisClaimItCxf(buildNhisClaimItExportPayload([{...fixture,total_amount:251.88}],options))).rejects.toThrow('does not reconcile')
  })
  it('never derives a legacy signer from the authenticated export actor', async () => {
    const unsigned={...fixture,signed_on:null,signed_by_user_id:null,signed_by_name:null,signed_by_role:null}
    const payload=buildNhisClaimItExportPayload([unsigned],{...options,exportActor:{id:'real-user',name:'Real Officer',role:'claims_officer'}})
    expect(getClaimItExportWarnings(payload)).toEqual([{claimNumber:'FIXTURE-1',warnings:['LEGACY_UNSIGNED_CLAIM']}])
    const row=readCxf(await buildNhisClaimItCxf(payload)).get('data').get('claims').get(0)
    for (const key of ['signedOn','signedByname','signedByuserID','signedByrole']) expect(row.get(key)).toBeNull()
  })
})

const mayPath=process.env.CLAIMIT_MAY_CXF || 'C:/Users/selorm/Downloads/MAY2026__4A45E6DE76C7 [030501954] (WESTPOINT CHEMIST)_2026-05-02-2026-05-02.cxf'
it.skipIf(!existsSync(mayPath))('parses the genuine May CXF (structural reference only) without committing patient information', () => {
  const bundle=readCxf(readFileSync(mayPath))
  expect(structuralContract(bundle).fields.claims).toEqual(reference.fields.claims)
  expect(structuralContract(bundle).schema).toEqual(reference.schema)
  expect(auditCxf(bundle).missingSigner).toBe(0)
})
