import {
  addDrug,
  calculateDrugStatus,
  deleteDrug,
  getAllDrugs,
  isDefaultCatalogDrug,
  transferDrugToBranch,
  updateDrug,
} from './drugService'
import { getBranchInventory, isBranchServerEnabled } from './branchServerApi'

export const isLocalInventoryEnabled = () => isBranchServerEnabled()

export const getInventory = async ({
  source = 'auto',
  limit = 20000,
  ...options
} = {}) => {
  if (source === 'branch') {
    return getBranchInventory({ limit, ...options })
  }

  return getAllDrugs(options)
}

export const createInventoryDrug = async (drug) => addDrug(drug)

export const updateInventoryDrug = async (id, updates) => updateDrug(id, updates)

export const deleteInventoryDrug = async (id) => deleteDrug(id)

export const transferInventoryDrug = async (transfer) => transferDrugToBranch(transfer)

export { calculateDrugStatus, isDefaultCatalogDrug }
