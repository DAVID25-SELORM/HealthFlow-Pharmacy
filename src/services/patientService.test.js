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
    listBranchRecords.mockResolvedValueOnce([])
    const query = mockPatientQuery(cloudPatients)

    await expect(getAllPatients()).resolves.toEqual(cloudPatients)

    expect(listBranchRecords).toHaveBeenCalledWith('patients')
    expect(fromMock).toHaveBeenCalledWith('patients')
    expect(query.select).toHaveBeenCalledWith('*')
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false })
  })

  it('does not query cloud patients when offline and the local branch cache is empty', async () => {
    getConnectivityState.mockReturnValueOnce({ internetAvailable: false })
    listBranchRecords.mockResolvedValueOnce([])

    await expect(getAllPatients()).resolves.toEqual([])

    expect(listBranchRecords).toHaveBeenCalledWith('patients')
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('falls back to cloud patient search when local sync search has no matches online', async () => {
    const cloudMatches = [
      { id: 'cloud-patient-1', full_name: 'Cloud Patient', nhis_member_no: '99441270' },
    ]
    shouldRouteToLocal.mockResolvedValueOnce(true)
    listBranchRecords.mockResolvedValueOnce([])
    const query = mockPatientQuery(cloudMatches)

    await expect(searchPatients('99441270')).resolves.toEqual(cloudMatches)

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { searchTerm: '99441270' })
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
    listBranchRecords.mockResolvedValueOnce(localMatches)

    await expect(searchPatients('99441270')).resolves.toEqual(localMatches)

    expect(listBranchRecords).toHaveBeenCalledWith('patients', { searchTerm: '99441270' })
    expect(fromMock).not.toHaveBeenCalled()
  })
})
