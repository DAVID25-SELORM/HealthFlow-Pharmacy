import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getBranchInventory,
  getConnectivityState,
  invokeTierAccess,
  listBranchRecords,
  normalizePatientWorkspaceData,
  routeRead,
} = vi.hoisted(() => ({
  getBranchInventory: vi.fn(),
  getConnectivityState: vi.fn(),
  invokeTierAccess: vi.fn(),
  listBranchRecords: vi.fn(),
  normalizePatientWorkspaceData: vi.fn(),
  routeRead: vi.fn(),
}))

vi.mock('./auditService', () => ({
  tryLogAuditEvent: vi.fn(),
}))

vi.mock('./branchServerApi', () => ({
  createBranchRecord: vi.fn(),
  getBranchInventory,
  listBranchRecords,
  updateBranchRecord: vi.fn(),
  submitNhisPharmacyClaim: vi.fn(),
}))

vi.mock('./apiRouter', () => ({
  routeRead,
  routeWrite: vi.fn(),
}))

vi.mock('./tierAccessService', () => ({
  invokeTierAccess,
}))

vi.mock('./connectivityService', () => ({
  getConnectivityState,
}))

vi.mock('./patientService', () => ({
  normalizePatientWorkspaceData,
}))

import { getClaimsWorkspace } from './claimsService'

describe('claimsService workspace reads', () => {
  beforeEach(() => {
    getBranchInventory.mockReset()
    getConnectivityState.mockReset()
    invokeTierAccess.mockReset()
    listBranchRecords.mockReset()
    normalizePatientWorkspaceData.mockReset()
    routeRead.mockReset()
    getConnectivityState.mockReturnValue({ internetAvailable: true })
  })

  it('loads the cloud claims workspace in one tier-access request', async () => {
    const patients = [{ id: 'patient-1', full_name: 'Ama Mensah' }]
    routeRead.mockImplementationOnce(async ({ cloud }) => await cloud())
    normalizePatientWorkspaceData.mockReturnValueOnce(patients)
    invokeTierAccess.mockResolvedValueOnce({
      claims: [{ id: 'claim-1', claim_status: 'pending' }],
      statistics: { total: 1, pending: 1, approved: 0, rejected: 0 },
      patients: [{ id: 'patient-1' }],
      nhisClaims: [],
      visitStats: {},
      drugs: [{ id: 'drug-1', name: 'Paracetamol' }],
    })

    await expect(getClaimsWorkspace()).resolves.toEqual({
      claims: [{ id: 'claim-1', claim_status: 'pending' }],
      statistics: { total: 1, pending: 1, approved: 0, rejected: 0 },
      patients,
      drugs: [{ id: 'drug-1', name: 'Paracetamol' }],
    })

    expect(invokeTierAccess).toHaveBeenCalledTimes(1)
    expect(invokeTierAccess).toHaveBeenCalledWith({ action: 'get_claims_workspace' })
    expect(normalizePatientWorkspaceData).toHaveBeenCalledWith(
      expect.objectContaining({ patients: [{ id: 'patient-1' }] })
    )
  })

  it('keeps the local branch workspace path independent of cloud reads', async () => {
    routeRead.mockImplementationOnce(async ({ local }) => await local())
    listBranchRecords
      .mockResolvedValueOnce([
        { id: 'claim-1', claim_status: 'approved' },
        { id: 'claim-2', claim_status: 'pending' },
      ])
      .mockResolvedValueOnce([{ id: 'patient-1' }])
      .mockResolvedValueOnce([])
    getBranchInventory.mockResolvedValueOnce([{ id: 'drug-1' }])
    normalizePatientWorkspaceData.mockReturnValueOnce([{ id: 'patient-1' }])

    await expect(getClaimsWorkspace()).resolves.toMatchObject({
      claims: [{ id: 'claim-1' }, { id: 'claim-2' }],
      statistics: { total: 2, pending: 1, approved: 1, rejected: 0 },
      patients: [{ id: 'patient-1' }],
      drugs: [{ id: 'drug-1' }],
    })

    expect(invokeTierAccess).not.toHaveBeenCalled()
    expect(listBranchRecords).toHaveBeenCalledWith('claims', { limit: 5000 })
    expect(getBranchInventory).toHaveBeenCalledWith({ limit: 20000 })
  })
})
