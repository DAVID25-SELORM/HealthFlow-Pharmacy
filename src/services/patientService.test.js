import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createBranchRecord,
  fromMock,
  getConnectivityState,
  invokeTierAccess,
  listBranchRecords,
  routeRead,
  routeWrite,
  shouldRouteToLocal,
  tryLogAuditEvent,
  updateBranchRecord,
} = vi.hoisted(() => ({
  createBranchRecord: vi.fn(),
  fromMock: vi.fn(),
  getConnectivityState: vi.fn(),
  invokeTierAccess: vi.fn(),
  listBranchRecords: vi.fn(),
  routeRead: vi.fn(),
  routeWrite: vi.fn(),
  shouldRouteToLocal: vi.fn(),
  tryLogAuditEvent: vi.fn(),
  updateBranchRecord: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: fromMock,
  },
}))

vi.mock('./auditService', () => ({
  tryLogAuditEvent,
}))

vi.mock('./branchServerApi', () => ({
  createBranchRecord,
  listBranchRecords,
  updateBranchRecord,
}))

vi.mock('./apiRouter', () => ({
  routeRead,
  routeWrite,
  shouldRouteToLocal,
}))

vi.mock('./connectivityService', () => ({
  getConnectivityState,
}))

vi.mock('./tierAccessService', () => ({
  invokeTierAccess,
}))

import {
  getAllPatients,
  getPatientsWorkspace,
  getPatientsWorkspacePage,
  getPatientById,
  getPatientLastVisit,
  getPatientVisitCount,
  normalizePatientWorkspaceData,
  searchPatients,
} from './patientService'

describe('patientService local sync reads', () => {
  beforeEach(() => {
    createBranchRecord.mockReset()
    fromMock.mockReset()
    getConnectivityState.mockReset()
    invokeTierAccess.mockReset()
    listBranchRecords.mockReset()
    routeRead.mockReset()
    routeWrite.mockReset()
    shouldRouteToLocal.mockReset()
    tryLogAuditEvent.mockReset()
    updateBranchRecord.mockReset()

    getConnectivityState.mockReturnValue({ internetAvailable: true })
    routeRead.mockImplementation(async ({ local }) => await local())
    routeWrite.mockImplementation(async ({ local }) => await local())
    shouldRouteToLocal.mockResolvedValue(false)
  })

  const mockPatientQuery = (rows) => {
    const query = {
      select: vi.fn(() => query),
      or: vi.fn(() => query),
      order: vi.fn(async () => ({ data: rows, error: null })),
    }

    fromMock.mockReturnValue(query)
    return query
  }

  it('falls back to cloud patients when the local branch cache is empty and internet is available', async () => {
    const cloudPatients = [
      { id: 'cloud-patient-1', full_name: 'Cloud Patient', nhis_member_no: '99441270' },
    ]
    listBranchRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    const query = mockPatientQuery(cloudPatients)

    await expect(getAllPatients()).resolves.toEqual(cloudPatients)

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { limit: 100000 })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { limit: 100000 })
    expect(fromMock).toHaveBeenCalledWith('patients')
    expect(query.select).toHaveBeenCalledWith('*')
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false })
  })

  it('does not query cloud patients when offline and the local branch cache is empty', async () => {
    getConnectivityState.mockReturnValueOnce({ internetAvailable: false })
    listBranchRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    await expect(getAllPatients()).resolves.toEqual([])

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { limit: 100000 })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { limit: 100000 })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('includes local NHIS claim patients when the patient cache is empty', async () => {
    const claimPatients = [
      {
        id: 'nhis-claim-1',
        claim_number: 'NHIS-001',
        surname: 'Mensah',
        other_names: 'Akua',
        member_no: 'GHA-000606820-8',
        hin: '36663082',
        folder_no: 'F-10',
      },
    ]
    listBranchRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(claimPatients)

    await expect(getAllPatients()).resolves.toEqual([
      expect.objectContaining({
        id: 'nhis-claim-nhis-claim-1',
        full_name: 'Mensah Akua',
        nhis_member_no: 'GHA-000606820-8',
        nhis_hin: '36663082',
        sourceClaimNumber: 'NHIS-001',
      }),
    ])

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { limit: 100000 })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { limit: 100000 })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('loads the cloud patient workspace with visit totals in one tier-access request', async () => {
    routeRead.mockImplementationOnce(async ({ cloud }) => await cloud())
    invokeTierAccess.mockResolvedValueOnce({
      patients: [{
        id: '2df77f2d-ea44-4f14-966c-a0a7c213f86a',
        full_name: 'Ama Mensah',
      }],
      nhisClaims: [{
        id: 'claim-row-1',
        claim_number: 'NHIS-002',
        surname: 'Baria',
        other_names: 'Karim',
        member_no: '99441270',
        service_date_from: '2026-06-15',
      }],
      visitStats: {
        '2df77f2d-ea44-4f14-966c-a0a7c213f86a': {
          visits: 3,
          lastVisit: '2026-06-14T10:00:00Z',
        },
      },
    })

    await expect(getPatientsWorkspace()).resolves.toEqual([
      expect.objectContaining({
        id: '2df77f2d-ea44-4f14-966c-a0a7c213f86a',
        visits: 3,
        lastVisit: '2026-06-14T10:00:00Z',
      }),
      expect.objectContaining({
        id: 'nhis-claim-claim-row-1',
        full_name: 'Baria Karim',
        visits: 1,
        lastVisit: '2026-06-15',
      }),
    ])

    expect(invokeTierAccess).toHaveBeenCalledTimes(1)
    expect(invokeTierAccess).toHaveBeenCalledWith({ action: 'get_patients_workspace' })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('does not double-count an NHIS claim already represented in cloud visit stats', () => {
    expect(normalizePatientWorkspaceData({
      patients: [{
        id: '2df77f2d-ea44-4f14-966c-a0a7c213f86a',
        full_name: 'Ama Mensah',
        nhis_member_no: '99441270',
      }],
      nhisClaims: [{
        id: 'claim-row-1',
        patient_id: '2df77f2d-ea44-4f14-966c-a0a7c213f86a',
        member_no: '99441270',
        service_date_from: '2026-06-15',
      }],
      visitStats: {
        '2df77f2d-ea44-4f14-966c-a0a7c213f86a': {
          visits: 1,
          lastVisit: '2026-06-15',
        },
      },
    })).toEqual([
      expect.objectContaining({ visits: 1, lastVisit: '2026-06-15' }),
    ])
  })

  it('falls back to cloud patient search when local sync search has no matches online', async () => {
    const cloudMatches = [
      { id: 'cloud-patient-1', full_name: 'Cloud Patient', nhis_member_no: '99441270' },
    ]
    shouldRouteToLocal.mockResolvedValueOnce(true)
    listBranchRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    invokeTierAccess.mockResolvedValueOnce({
      patients: cloudMatches,
      nhisClaims: [],
      visitStats: {},
    })

    await expect(searchPatients('99441270')).resolves.toEqual([
      expect.objectContaining({
        ...cloudMatches[0],
        visits: 0,
        lastVisit: null,
      }),
    ])

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { searchTerm: '99441270', limit: 80 })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { searchTerm: '99441270', limit: 120 })
    expect(invokeTierAccess).toHaveBeenCalledWith({ action: 'get_patients_workspace' })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('loads a paged cloud patient workspace', async () => {
    routeRead.mockImplementationOnce(async ({ cloud }) => await cloud())
    invokeTierAccess.mockResolvedValueOnce({
      patients: [{ id: 'cloud-patient-1', full_name: 'Cloud Patient' }],
      nhisClaims: [],
      visitStats: {},
      total: 806,
      page: 2,
      pageSize: 100,
    })

    await expect(getPatientsWorkspacePage({
      page: 2,
      pageSize: 100,
      searchTerm: 'Cloud',
    })).resolves.toEqual({
      patients: [
        expect.objectContaining({
          id: 'cloud-patient-1',
          full_name: 'Cloud Patient',
          visits: 0,
          lastVisit: null,
        }),
      ],
      total: 806,
      page: 2,
      pageSize: 100,
    })

    expect(invokeTierAccess).toHaveBeenCalledWith({
      action: 'get_patients_workspace',
      page: 2,
      pageSize: 100,
      searchTerm: 'Cloud',
    })
  })

  it('paginates the complete local patient and NHIS-only patient index', async () => {
    const registeredPatient = {
      id: 'patient-1',
      full_name: 'Registered Patient',
      insurance_id: '10000001',
    }
    const nhisClaims = [
      {
        id: 'claim-matched',
        patient_id: 'patient-1',
        surname: 'Registered',
        other_names: 'Patient',
        member_no: '10000001',
      },
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `claim-${index + 1}`,
        claim_number: `NHIS-${index + 1}`,
        surname: 'NHIS',
        other_names: `Patient ${index + 1}`,
        member_no: String(20000000 + index),
      })),
    ]
    listBranchRecords
      .mockResolvedValueOnce([registeredPatient])
      .mockResolvedValueOnce(nhisClaims)

    await expect(getPatientsWorkspacePage({
      page: 2,
      pageSize: 100,
    })).resolves.toEqual({
      patients: [
        expect.objectContaining({
          full_name: 'NHIS Patient 100',
          nhis_member_no: '20000099',
        }),
      ],
      total: 101,
      page: 2,
      pageSize: 100,
    })

    expect(listBranchRecords).toHaveBeenCalledWith('patients', {
      limit: 100000,
      searchTerm: undefined,
    })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', {
      limit: 100000,
      searchTerm: undefined,
    })
  })

  it('keeps local patient search results when local sync has matches', async () => {
    const localMatches = [
      { id: 'local-patient-1', full_name: 'Local Patient', nhis_member_no: '99441270' },
    ]
    shouldRouteToLocal.mockResolvedValueOnce(true)
    listBranchRecords
      .mockResolvedValueOnce(localMatches)
      .mockResolvedValueOnce([])

    await expect(searchPatients('99441270')).resolves.toEqual(localMatches)

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { searchTerm: '99441270', limit: 80 })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { searchTerm: '99441270', limit: 120 })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('keeps local NHIS claim-derived patient search results when patient rows are missing', async () => {
    const claimMatches = [
      {
        id: 'claim-row-1',
        claim_number: 'NHIS-002',
        surname: 'Baria',
        other_names: 'Karim',
        member_no: 'GHA-000606820-8',
        hin: '36663082',
      },
    ]
    shouldRouteToLocal.mockResolvedValueOnce(true)
    listBranchRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(claimMatches)

    await expect(searchPatients('GHA-000606820-8')).resolves.toEqual([
      expect.objectContaining({
        id: 'nhis-claim-claim-row-1',
        full_name: 'Baria Karim',
        nhis_member_no: 'GHA-000606820-8',
        nhis_hin: '36663082',
      }),
    ])

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { searchTerm: 'GHA-000606820-8', limit: 80 })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { searchTerm: 'GHA-000606820-8', limit: 120 })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('does not query sales for NHIS claim-derived patient IDs', async () => {
    await expect(getPatientVisitCount('nhis-claim-c480b306-1085-46d3-b1cc-5066b127a182')).resolves.toBe(0)
    await expect(getPatientLastVisit('nhis-claim-c480b306-1085-46d3-b1cc-5066b127a182')).resolves.toBeNull()

    expect(fromMock).not.toHaveBeenCalled()
    expect(shouldRouteToLocal).not.toHaveBeenCalled()
  })

  it('loads NHIS claim-derived patient details from local claim rows', async () => {
    const selectedClaim = {
      id: 'claim-row-1',
      claim_number: 'NHIS-002',
      surname: 'Baria',
      other_names: 'Karim',
      member_no: '99441270',
      hin: '36663082',
      status: 'served',
      service_date_from: '2026-05-14',
      total_amount: 45,
      nhis_claim_medicines: [{
        id: 'medicine-1',
        description: 'Amlodipine 10 mg',
        prescribed_qty: 30,
        served_qty: 30,
        serving_status: 'fully_served',
      }],
    }
    listBranchRecords
      .mockResolvedValueOnce([selectedClaim])
      .mockResolvedValueOnce([selectedClaim])

    await expect(getPatientById('nhis-claim-claim-row-1')).resolves.toMatchObject({
      id: 'nhis-claim-claim-row-1',
      full_name: 'Baria Karim',
      sales: [],
      claims: [{
        id: 'claim-row-1',
        claim_number: 'NHIS-002',
        claim_status: 'served',
        service_date: '2026-05-14',
        total_amount: 45,
        claim_type: 'nhis',
        medicines: [{
          description: 'Amlodipine 10 mg',
          prescribed_qty: 30,
          served_qty: 30,
        }],
      }],
    })

    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { id: 'claim-row-1', limit: 1 })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { searchTerm: '99441270', limit: 500 })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('includes same-name NHIS history matched safely by folder number', async () => {
    routeRead.mockImplementationOnce(async ({ cloud }) => await cloud())
    const patient = {
      id: '2df77f2d-ea44-4f14-966c-a0a7c213f86a',
      full_name: 'Andoh Francis Kesson',
      folder_no: '0027-26071083',
      nhis_member_no: '26776602',
      claims: [],
      sales: [],
    }
    const primaryClaim = {
      id: 'claim-1', patient_id: patient.id, member_no: '26776602',
      surname: 'Andoh', other_names: 'Francis Kesson', folder_no: patient.folder_no,
    }
    const folderMatchedClaim = {
      id: 'claim-2', surname: 'Andoh', other_names: 'Francis Kesson', folder_no: patient.folder_no,
    }
    const patientQuery = {
      select: vi.fn(() => patientQuery),
      eq: vi.fn(() => patientQuery),
      single: vi.fn(async () => ({ data: patient, error: null })),
    }
    const historyQuery = (rows) => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        order: vi.fn(() => query),
        limit: vi.fn(async () => ({ data: rows, error: null })),
      }
      return query
    }
    fromMock
      .mockReturnValueOnce(patientQuery)
      .mockReturnValueOnce(historyQuery([primaryClaim]))
      .mockReturnValueOnce(historyQuery([primaryClaim]))
      .mockReturnValueOnce(historyQuery([folderMatchedClaim]))

    await expect(getPatientById(patient.id)).resolves.toMatchObject({
      claims: expect.arrayContaining([
        expect.objectContaining({ id: 'claim-1' }),
        expect.objectContaining({ id: 'claim-2' }),
      ]),
    })
  })

  it('uses production-safe NHIS claim columns when enriching cloud patients', async () => {
    routeRead.mockImplementationOnce(async ({ cloud }) => await cloud())

    const patientQuery = {
      select: vi.fn(() => patientQuery),
      order: vi.fn(async () => ({ data: [], error: null })),
    }
    const nhisClaimQuery = {
      select: vi.fn(() => nhisClaimQuery),
      order: vi.fn(() => nhisClaimQuery),
      limit: vi.fn(async () => ({ data: [], error: null })),
    }

    fromMock
      .mockReturnValueOnce(patientQuery)
      .mockReturnValueOnce(nhisClaimQuery)

    await expect(getAllPatients()).resolves.toEqual([])

    expect(fromMock).toHaveBeenCalledWith('nhis_claims')
    expect(nhisClaimQuery.select).toHaveBeenCalledWith(expect.not.stringContaining('phone'))
    expect(nhisClaimQuery.select).toHaveBeenCalledWith(expect.not.stringContaining('patient_phone'))
    expect(nhisClaimQuery.select).toHaveBeenCalledWith(expect.not.stringContaining('patient_address'))
    expect(nhisClaimQuery.select).toHaveBeenCalledWith(expect.not.stringContaining('insurance_provider'))
    expect(nhisClaimQuery.select).toHaveBeenCalledWith(expect.not.stringContaining('insurance_id'))
    expect(nhisClaimQuery.select).toHaveBeenCalledWith(expect.not.stringContaining('service_date,'))
    expect(nhisClaimQuery.select).toHaveBeenCalledWith(expect.not.stringContaining('dispensing_date'))
  })

  it('falls back to minimal NHIS claim patient columns when production rejects optional columns', async () => {
    routeRead.mockImplementationOnce(async ({ cloud }) => await cloud())

    const patientQuery = {
      select: vi.fn(() => patientQuery),
      order: vi.fn(async () => ({ data: [], error: null })),
    }
    const rejectedNhisClaimQuery = {
      select: vi.fn(() => rejectedNhisClaimQuery),
      order: vi.fn(() => rejectedNhisClaimQuery),
      limit: vi.fn(async () => ({
        data: null,
        error: { code: 'PGRST204', message: 'Column not found' },
      })),
    }
    const fallbackNhisClaimQuery = {
      select: vi.fn(() => fallbackNhisClaimQuery),
      order: vi.fn(() => fallbackNhisClaimQuery),
      limit: vi.fn(async () => ({
        data: [{
          id: 'claim-row-1',
          claim_number: 'NHIS-002',
          surname: 'Baria',
          other_names: 'Karim',
          member_no: '99441270',
        }],
        error: null,
      })),
    }

    fromMock
      .mockReturnValueOnce(patientQuery)
      .mockReturnValueOnce(rejectedNhisClaimQuery)
      .mockReturnValueOnce(fallbackNhisClaimQuery)

    await expect(getAllPatients()).resolves.toEqual([
      expect.objectContaining({
        id: 'nhis-claim-claim-row-1',
        full_name: 'Baria Karim',
        nhis_member_no: '99441270',
      }),
    ])

    expect(fallbackNhisClaimQuery.select).toHaveBeenCalledWith(
      'id, claim_number, patient_id, member_no, hin, surname, other_names, created_at'
    )
  })

  it('uses production-safe NHIS claim date columns when loading last visit', async () => {
    const patientId = '2df77f2d-ea44-4f14-966c-a0a7c213f86a'
    const salesQuery = {
      select: vi.fn(() => salesQuery),
      eq: vi.fn(() => salesQuery),
      order: vi.fn(() => salesQuery),
      limit: vi.fn(() => salesQuery),
      maybeSingle: vi.fn(async () => ({ data: { sale_date: '2026-06-14' }, error: null })),
    }
    const nhisClaimQuery = {
      select: vi.fn(() => nhisClaimQuery),
      eq: vi.fn(() => nhisClaimQuery),
      order: vi.fn(() => nhisClaimQuery),
      limit: vi.fn(() => nhisClaimQuery),
      maybeSingle: vi.fn(async () => ({ data: { service_date_from: '2026-06-15' }, error: null })),
    }

    fromMock
      .mockReturnValueOnce(salesQuery)
      .mockReturnValueOnce(nhisClaimQuery)

    await expect(getPatientLastVisit(patientId)).resolves.toBe('2026-06-15')

    expect(nhisClaimQuery.select).toHaveBeenCalledWith('service_date_from, created_at')
  })
})
