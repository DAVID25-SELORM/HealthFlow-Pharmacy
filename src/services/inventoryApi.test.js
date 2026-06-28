import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('reports whether the local branch inventory is available', () => {
    isBranchServerEnabled.mockReturnValue(true)

    expect(isLocalInventoryEnabled()).toBe(true)
  })
})
