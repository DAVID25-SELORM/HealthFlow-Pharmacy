import { describe, expect, it, vi } from 'vitest'
import { deflateSync, inflateSync } from 'node:zlib'

vi.mock('../lib/supabase', () => ({
  getCachedSupabaseSession: () => null,
  supabase: { from: vi.fn(), rpc: vi.fn() },
}))
vi.mock('./auditService', () => ({ tryLogAuditEvent: vi.fn() }))
vi.mock('./claimitLifecycleService', () => ({
  getExportSigningEvidence: vi.fn(async (claims) => ({ claims, warnings: [] })),
  recordCxfExport: vi.fn(async () => null),
}))
vi.mock('./branchServerApi', () => ({ shouldUseBranchServer: vi.fn(() => false) }))

import { buildNhisClaimItCxf, buildNhisClaimItExportPayload } from './nhisService'

const claim = (index) => ({
  id: `claim-${index}`, claim_number: `NHIS-00000${index}`, status: 'served', organization_type: 'pharmacy',
  member_no: `4000000${index}`, hin: `4000000${index}`, surname: 'Mensah', other_names: 'Ama', folder_no: 'F001',
  gender: 'female', date_of_birth: '1990-01-01', ccc_no: 'CC-12345', diagnosis: 'Malaria',
  diagnosis_details: [{ code: 'B50', label: 'Plasmodium falciparum malaria', source: 'ICD-10' }],
  service_date_from: '2026-05-14', service_date_to: '2026-05-14', referring_facility: 'Westpoint Chemist',
  physician_name: 'Dr Test', prescription_file_name: 'rx.pdf', prescription_file_type: 'application/pdf',
  prescription_file_size: 1024, prescription_document_type: 'prescription', prescription_verified: true,
  total_amount: 10,
  prescription_file_url: index === 3 ? 'https://example.test/other.pdf' : 'https://example.test/shared.pdf',
  prescription_file_path: index === 3 ? 'org/other.pdf' : 'org/shared.pdf',
  nhis_claim_medicines: [{ drug_code: 'NH001', description: 'Artemether Lumefantrine Tablet', unit: 'tablet',
    unit_price: 1, dispensed_qty: 10, dose: '1 tablet', frequency: 'BD', duration: '3 days', total_amount: 10 }],
})

const pdf = (fill, size) => {
  const bytes = new Uint8Array(size).fill(fill)
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0)
  return bytes
}

describe('CLAIM-it CXF attachment handling at scale', () => {
  it('fetches a shared attachment once and embeds each attachment as its exact compressed bytes, including large ones', async () => {
    const shared = pdf(7, 200 * 1024) // above the serializer's inline limit: referenced, not copied
    const other = pdf(9, 2 * 1024)
    const fetchMock = vi.fn(async (url) => ({
      ok: true, status: 200,
      arrayBuffer: async () => (String(url).includes('other') ? other : shared).slice().buffer,
    }))
    vi.stubGlobal('fetch', fetchMock)
    const payload = buildNhisClaimItExportPayload([claim(1), claim(2), claim(3)], {
      yearMonth: '2026-05', organizationType: 'pharmacy', facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      facilityName: 'Westpoint Chemist', providerNumber: '03-05-01954', providerTypeDescription: 'Pharmacy',
      accreditationDateGenerated: '2025-12-29', claimsOfficerName: 'Claims Officer', submitterId: 'admin',
      generatedAt: '2026-05-20T14:58:02.000Z',
    })

    const cxf = await buildNhisClaimItCxf(payload)
    expect(fetchMock).toHaveBeenCalledTimes(2) // 3 claims, 2 unique attachments

    const inflated = Buffer.from(inflateSync(Buffer.from(cxf.slice(3))))
    for (const source of [shared, other]) {
      const compressed = deflateSync(Buffer.from(source))
      const marker = Buffer.concat([Buffer.from(`s:${compressed.length}:"`), compressed, Buffer.from('";')])
      expect(inflated.includes(marker)).toBe(true)
    }
    const sharedCompressed = deflateSync(Buffer.from(shared))
    const sharedMarker = Buffer.concat([Buffer.from(`s:${sharedCompressed.length}:"`), sharedCompressed])
    let occurrences = 0
    for (let from = inflated.indexOf(sharedMarker); from !== -1; from = inflated.indexOf(sharedMarker, from + 1)) occurrences += 1
    expect(occurrences).toBe(2) // both claims that share it still get their own attachment row
  })

  it('names the claim when its attachment cannot be downloaded, without leaking the URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })))
    const payload = buildNhisClaimItExportPayload([claim(1)], {
      yearMonth: '2026-05', organizationType: 'pharmacy', facilityCode: '03-05-001-02-01954-11-P1-2-011225',
      facilityName: 'Westpoint Chemist', providerNumber: '03-05-01954', providerTypeDescription: 'Pharmacy',
      accreditationDateGenerated: '2025-12-29', claimsOfficerName: 'Claims Officer', submitterId: 'admin',
      generatedAt: '2026-05-20T14:58:02.000Z',
    })
    const error = await buildNhisClaimItCxf(payload).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('HTTP 403')
    expect(error.message).not.toContain('example.test')
  })
})
