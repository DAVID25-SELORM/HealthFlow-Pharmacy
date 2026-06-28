import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  discardOfflineInventoryConflicts,
  getConnectivityState,
  getOfflineInventorySummary,
  queueOfflineInventoryOperation,
  refreshConnectivityState,
  subscribeOfflineInventoryQueue,
  syncOfflineInventory,
} = vi.hoisted(() => ({
  discardOfflineInventoryConflicts: vi.fn(),
  getConnectivityState: vi.fn(),
  getOfflineInventorySummary: vi.fn(),
  queueOfflineInventoryOperation: vi.fn(),
  refreshConnectivityState: vi.fn(),
  subscribeOfflineInventoryQueue: vi.fn(),
  syncOfflineInventory: vi.fn(),
}))

vi.mock('./drugService', () => ({
  addDrug: vi.fn(),
  calculateDrugStatus: vi.fn(),
  deleteDrug: vi.fn(),
  getAllDrugs: vi.fn(),
  isDefaultCatalogDrug: vi.fn(),
  transferDrugToBranch: vi.fn(),
  updateDrug: vi.fn(),
}))

vi.mock('./branchServerApi', () => ({
  getBranchInventory: vi.fn(),
  isBranchServerEnabled: vi.fn(),
}))

vi.mock('./offlineInventoryQueue', () => ({
  discardOfflineInventoryConflicts,
  getOfflineInventorySummary,
  queueOfflineInventoryOperation,
  subscribeOfflineInventoryQueue,
  syncOfflineInventory,
}))

vi.mock('./connectivityService', () => ({
  getConnectivityState,
  refreshConnectivityState,
}))

import {
  addDrug,
  deleteDrug,
  getAllDrugs,
  transferDrugToBranch,
  updateDrug,
} from './drugService'
import { getBranchInventory, isBranchServerEnabled } from './branchServerApi'
import {
  createInventoryDrug,
  deleteInventoryDrug,
  getInventory,
  isLocalInventoryEnabled,
  transferInventoryDrug,
  updateInventoryDrug,
} from './inventoryApi'

describe('inventoryApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConnectivityState.mockReturnValue({
      internetAvailable: true,
      branchServerAvailable: false,
    })
    refreshConnectivityState.mockResolvedValue({
      internetAvailable: true,
      branchServerAvailable: false,
    })
  })

  it('loads cloud inventory through the drug service by default', async () => {
    getAllDrugs.mockResolvedValue([{ id: 'drug-1' }])

    await expect(getInventory({ branchId: 'branch-1', includeCatalog: true }))
      .resolves.toEqual([{ id: 'drug-1' }])
    expect(getAllDrugs).toHaveBeenCalledWith({
      branchId: 'branch-1',
      includeCatalog: true,
    })
    expect(getBranchInventory).not.toHaveBeenCalled()
  })

  it('loads branch inventory when explicitly requested', async () => {
    getBranchInventory.mockResolvedValue([{ id: 'local-drug' }])

    await expect(getInventory({ source: 'branch', limit: 500 }))
      .resolves.toEqual([{ id: 'local-drug' }])
    expect(getBranchInventory).toHaveBeenCalledWith({ limit: 500 })
    expect(getAllDrugs).not.toHaveBeenCalled()
  })

  it('forwards inventory commands without changing their semantics', async () => {
    const drug = { name: 'Paracetamol' }
    const updates = { quantity: 5 }
    const transfer = { drugId: 'drug-1', targetBranchId: 'branch-2' }

    await createInventoryDrug(drug)
    await updateInventoryDrug('drug-1', updates)
    await deleteInventoryDrug('drug-1')
    await transferInventoryDrug(transfer)

    expect(addDrug).toHaveBeenCalledWith(drug)
    expect(updateDrug).toHaveBeenCalledWith('drug-1', updates)
    expect(deleteDrug).toHaveBeenCalledWith('drug-1')
    expect(transferDrugToBranch).toHaveBeenCalledWith(transfer)
  })

  it('queues a validated create after the cloud write fails offline', async () => {
    const drug = { name: 'Paracetamol', quantity: 10 }
    const context = {
      organizationId: 'org-1',
      branchId: 'branch-1',
      createdBy: 'user-1',
    }
    addDrug.mockRejectedValue(new TypeError('Failed to fetch'))
    refreshConnectivityState.mockResolvedValue({
      internetAvailable: false,
      branchServerAvailable: false,
    })
    queueOfflineInventoryOperation.mockResolvedValue({
      id: 'queue-1',
      status: 'pending',
    })

    await expect(createInventoryDrug(drug, context)).resolves.toEqual({
      offlineQueued: true,
      operation: 'create',
      queueId: 'queue-1',
      syncStatus: 'pending',
    })
    expect(queueOfflineInventoryOperation).toHaveBeenCalledWith({
      operation: 'create',
      drugId: null,
      drugPayload: drug,
      expectedUpdatedAt: null,
      organizationId: 'org-1',
      branchId: 'branch-1',
      createdBy: 'user-1',
    })
  })

  it('preserves the expected update timestamp for conflict detection', async () => {
    const updates = { name: 'Paracetamol', quantity: 8 }
    const context = {
      organizationId: 'org-1',
      expectedUpdatedAt: '2026-06-28T02:00:00.000Z',
    }
    updateDrug.mockRejectedValue(new TypeError('Failed to fetch'))
    refreshConnectivityState.mockResolvedValue({
      internetAvailable: false,
      branchServerAvailable: true,
    })
    queueOfflineInventoryOperation.mockResolvedValue({
      id: 'queue-2',
      status: 'pending',
    })

    await updateInventoryDrug('drug-1', updates, context)

    expect(queueOfflineInventoryOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'update',
        drugId: 'drug-1',
        expectedUpdatedAt: '2026-06-28T02:00:00.000Z',
      })
    )
  })

  it('does not hide server errors while internet is available', async () => {
    const error = new Error('Duplicate medicine')
    addDrug.mockRejectedValue(error)

    await expect(
      createInventoryDrug({ name: 'Paracetamol' }, { organizationId: 'org-1' })
    ).rejects.toBe(error)
    expect(queueOfflineInventoryOperation).not.toHaveBeenCalled()
  })

  it('does not queue validation errors merely because the browser is offline', async () => {
    const error = new Error('Quantity cannot be negative.')
    addDrug.mockRejectedValue(error)
    refreshConnectivityState.mockResolvedValue({
      internetAvailable: false,
      branchServerAvailable: false,
    })

    await expect(
      createInventoryDrug({ name: 'Paracetamol', quantity: -1 }, {
        organizationId: 'org-1',
      })
    ).rejects.toBe(error)
    expect(queueOfflineInventoryOperation).not.toHaveBeenCalled()
  })

  it('blocks destructive inventory actions while offline', async () => {
    refreshConnectivityState.mockResolvedValue({
      internetAvailable: false,
      branchServerAvailable: true,
    })

    await expect(deleteInventoryDrug('drug-1')).rejects.toThrow(
      'Deleting medicines requires a connection'
    )
    await expect(
      transferInventoryDrug({ drugId: 'drug-1', destinationBranchId: 'branch-2' })
    ).rejects.toThrow('Branch transfers require an internet connection')
    expect(deleteDrug).not.toHaveBeenCalled()
    expect(transferDrugToBranch).not.toHaveBeenCalled()
  })

  it('reports whether the local branch inventory is available', () => {
    isBranchServerEnabled.mockReturnValue(true)

    expect(isLocalInventoryEnabled()).toBe(true)
  })
})
