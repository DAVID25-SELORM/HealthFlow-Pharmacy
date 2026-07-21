import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}))

vi.mock('./branchServerApi', () => ({
  createBranchRecord: vi.fn(),
  listBranchRecords: vi.fn(),
  shouldUseBranchServer: vi.fn(() => false),
  updateBranchRecord: vi.fn(),
}))

vi.mock('./connectivityService', () => ({
  getConnectivityState: vi.fn(() => ({ internetAvailable: true })),
}))

vi.mock('./auditService', () => ({
  tryLogAuditEvent: vi.fn(),
}))

import { supabase } from '../lib/supabase'
import {
  buildNhisPrescriptionSourceSnapshot,
  createNhisPrescriber,
  createNhisPrescribingFacility,
  normalizeNhisPrescriberPayload,
  normalizeNhisPrescribingFacilityPayload,
} from './nhisPrescribingRecordsService'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('NHIS prescribing records service', () => {
  it('normalizes facility and prescriber payloads with organization scope', () => {
    expect(normalizeNhisPrescribingFacilityPayload({
      facilityName: '  Korle Bu OPD ',
      nhiaFacilityCode: ' KBTH ',
      facilityType: 'Hospital',
    }, {
      organizationId: '542fe9df-3211-4046-bd90-b101d249b7f9',
      branchId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
    })).toMatchObject({
      organization_id: '542fe9df-3211-4046-bd90-b101d249b7f9',
      branch_id: '11111111-1111-4111-8111-111111111111',
      facility_name: 'Korle Bu OPD',
      nhia_facility_code: 'KBTH',
      facility_type: 'Hospital',
      updated_by: '22222222-2222-4222-8222-222222222222',
    })

    expect(normalizeNhisPrescriberPayload({
      fullName: '  Dr Ama Test ',
      licenseNumber: ' MDC-123 ',
      professionalType: 'Doctor',
    }, {
      organizationId: '542fe9df-3211-4046-bd90-b101d249b7f9',
    })).toMatchObject({
      organization_id: '542fe9df-3211-4046-bd90-b101d249b7f9',
      full_name: 'Dr Ama Test',
      license_number: 'MDC-123',
      professional_type: 'Doctor',
    })
  })

  it('builds claim snapshots without replacing existing export field names', () => {
    const snapshot = buildNhisPrescriptionSourceSnapshot({
      facility: {
        id: '11111111-1111-4111-8111-111111111111',
        facility_name: 'Korle Bu OPD',
        nhia_facility_code: 'KBTH',
      },
      prescriber: {
        id: '22222222-2222-4222-8222-222222222222',
        full_name: 'Dr Ama Test',
        license_number: 'MDC-123',
      },
    })

    expect(snapshot).toMatchObject({
      prescribingFacilityId: '11111111-1111-4111-8111-111111111111',
      prescribing_facility_id: '11111111-1111-4111-8111-111111111111',
      prescriberId: '22222222-2222-4222-8222-222222222222',
      prescriber_id: '22222222-2222-4222-8222-222222222222',
      referringFacility: 'Korle Bu OPD',
      physicianName: 'Dr Ama Test (MDC-123)',
      prescribing_facility_name_snapshot: 'Korle Bu OPD',
      prescribing_facility_code_snapshot: 'KBTH',
      prescriber_name_snapshot: 'Dr Ama Test',
      prescriber_license_snapshot: 'MDC-123',
    })
  })

  it('creates facilities and prescribers through additive master tables', async () => {
    const facilityInsert = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn().mockResolvedValue({
          data: { id: 'facility-1', facility_name: 'Korle Bu OPD' },
          error: null,
        }),
      })),
    }))
    const prescriberInsert = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn().mockResolvedValue({
          data: { id: 'prescriber-1', full_name: 'Dr Ama Test' },
          error: null,
        }),
      })),
    }))

    supabase.from.mockImplementation((table) => {
      if (table === 'nhis_prescribing_facilities') return { insert: facilityInsert }
      if (table === 'nhis_prescribers') return { insert: prescriberInsert }
      return { insert: vi.fn() }
    })

    await expect(createNhisPrescribingFacility({
      facilityName: 'Korle Bu OPD',
    }, {
      organizationId: '542fe9df-3211-4046-bd90-b101d249b7f9',
    })).resolves.toMatchObject({ facility_name: 'Korle Bu OPD' })

    await expect(createNhisPrescriber({
      fullName: 'Dr Ama Test',
    }, {
      organizationId: '542fe9df-3211-4046-bd90-b101d249b7f9',
    })).resolves.toMatchObject({ full_name: 'Dr Ama Test' })

    expect(facilityInsert.mock.calls[0][0][0]).toMatchObject({
      organization_id: '542fe9df-3211-4046-bd90-b101d249b7f9',
      facility_name: 'Korle Bu OPD',
    })
    expect(prescriberInsert.mock.calls[0][0][0]).toMatchObject({
      organization_id: '542fe9df-3211-4046-bd90-b101d249b7f9',
      full_name: 'Dr Ama Test',
    })
  })
})
