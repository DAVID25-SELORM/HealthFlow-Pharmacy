import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createBranchRecord,
  fromMock,
  getConnectivityState,
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

import { getAllPatients, searchPatients } from './patientService'

describe('patientService local sync reads', () => {
  beforeEach(() => {
    createBranchRecord.mockReset()
    fromMock.mockReset()
    getConnectivityState.mockReset()
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

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { limit: 5000 })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { limit: 5000 })
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

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { limit: 5000 })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { limit: 5000 })
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

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { limit: 5000 })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { limit: 5000 })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('falls back to cloud patient search when local sync search has no matches online', async () => {
    const cloudMatches = [
      { id: 'cloud-patient-1', full_name: 'Cloud Patient', nhis_member_no: '99441270' },
    ]
    shouldRouteToLocal.mockResolvedValueOnce(true)
    listBranchRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    const query = mockPatientQuery(cloudMatches)

    await expect(searchPatients('99441270')).resolves.toEqual(cloudMatches)

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { searchTerm: '99441270' })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { searchTerm: '99441270', limit: 100 })
    expect(fromMock).toHaveBeenCalledWith('patients')
    expect(query.select).toHaveBeenCalledWith('*')
    expect(query.or).toHaveBeenCalledWith(expect.stringContaining('nhis_member_no.ilike.%99441270%'))
    expect(query.order).toHaveBeenCalledWith('full_name')
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

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { searchTerm: '99441270' })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { searchTerm: '99441270', limit: 100 })
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

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { searchTerm: 'GHA-000606820-8' })
    expect(listBranchRecords).toHaveBeenCalledWith('nhis/claims', { searchTerm: 'GHA-000606820-8', limit: 100 })
    expect(fromMock).not.toHaveBeenCalled()
  })
})
