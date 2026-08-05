import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildNhisClaimItExportPayload,
  buildNhisClaimItXml,
} from '../services/nhisService'

const golden = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/contracts/fixtures/claimit-member-identifiers.golden.json'), 'utf8'),
)
const baseClaim = {
  id: '00000000-0000-4000-8000-000000000001',
  claim_number: 'NHIS-GOLDEN-001',
  surname: 'BASELINE',
  other_names: 'PATIENT',
  gender: 'female',
  date_of_birth: '1990-01-01',
  service_date_from: '2026-06-15',
  service_date_to: '2026-06-15',
  status: 'served',
  total_amount: 10,
  ccc_no: '12345',
  diagnosis: 'A00',
  physician_name: 'Baseline Prescriber',
  nhis_claim_medicines: [],
}

const options = {
  yearMonth: '2026-06',
  organizationType: 'pharmacy',
  generatedAt: '2026-06-30T12:00:00.000Z',
}

describe('protected CLAIM-it identifier golden file', () => {
  for (const [name, fixture] of Object.entries(golden)) {
    it(`preserves ${name} member identifier mapping`, () => {
      const payload = buildNhisClaimItExportPayload([{ ...baseClaim, ...fixture.input }], options)
      expect(payload.claims[0].patient).toMatchObject(fixture.expected)
      expect(buildNhisClaimItXml(payload)).toContain(`<MemberNumber>${fixture.expected.memberNumber}</MemberNumber>`)
      expect(payload.claims[0].patient.cardSerialNo).toBe('')
    })
  }

  it('keeps a mixed batch parseable and free of numeric card serial values', () => {
    const claims = Object.values(golden).map((fixture, index) => ({
      ...baseClaim,
      ...fixture.input,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      claim_number: `NHIS-GOLDEN-${index + 1}`,
    }))
    const payload = buildNhisClaimItExportPayload(claims, options)
    const xml = buildNhisClaimItXml(payload)
    expect(payload.claims).toHaveLength(3)
    expect(payload.claims.every((claim) => claim.patient.cardSerialNo === '')).toBe(true)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<NhiaClaimBatch>')
  })
})
