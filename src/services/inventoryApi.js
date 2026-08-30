import {
  addDrug,
  calculateDrugStatus,
  deleteDrug,
  getAllDrugs,
  isDefaultCatalogDrug,
  provisionDefaultMedicationCatalog,
  transferDrugToBranch,
  updateDrug,
} from './drugService'
import { getBranchInventory, isBranchServerEnabled } from './branchServerApi'
import {
  discardOfflineInventoryConflicts,
  getOfflineInventorySummary,
  queueOfflineInventoryOperation,
  subscribeOfflineInventoryQueue,
  syncOfflineInventory,
} from './offlineInventoryQueue'
import {
  getConnectivityState,
  refreshConnectivityState,
} from './connectivityService'

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

const internetIsUnavailable = (connectivity) =>
  connectivity.internetAvailable === false

const isNetworkFailure = (error) => {
  const text = [error?.name, error?.message, error?.code]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return (
    text.includes('failed to fetch') ||
    text.includes('failed to send a request') ||
    text.includes('functionsfetcherror') ||
    text.includes('network') ||
    text.includes('aborted') ||
    text.includes('internet') ||
    text.includes('offline')
  )
}

const queueInventoryOperation = async ({
  operation,
  drugId,
  drug,
  context,
}) => {
  const queuedOperation = await queueOfflineInventoryOperation({
    operation,
    drugId,
    drugPayload: drug,
    expectedUpdatedAt: context.expectedUpdatedAt || null,
    organizationId: context.organizationId,
    branchId: context.branchId || null,
    createdBy: context.createdBy || null,
  })
  return {
    offlineQueued: true,
    operation,
    queueId: queuedOperation.id,
    syncStatus: queuedOperation.status,
  }
}

const runQueueableWrite = async ({ operation, drugId = null, drug, context, write }) => {
  try {
    return await write()
  } catch (error) {
    const connectivity = await refreshConnectivityState({ probeLocal: true })
      .catch(() => getConnectivityState())
    if (internetIsUnavailable(connectivity) && isNetworkFailure(error)) {
      return queueInventoryOperation({ operation, drugId, drug, context })
    }
    throw error
  }
}

export const createInventoryDrug = async (drug, context = {}) =>
  runQueueableWrite({
    operation: 'create',
    drug,
    context,
    write: () => addDrug(drug),
  })

export const updateInventoryDrug = async (id, updates, context = {}) =>
  runQueueableWrite({
    operation: 'update',
    drugId: id,
    drug: updates,
    context,
    write: () => updateDrug(id, updates),
  })

export const deleteInventoryDrug = async (id) => {
  const connectivity = await refreshConnectivityState({ probeLocal: true })
    .catch(() => getConnectivityState())
  if (!connectivity.internetAvailable) {
    throw new Error('Deleting medicines requires a connection. The medicine was not deleted.')
  }
  return deleteDrug(id)
}

export const transferInventoryDrug = async (transfer) => {
  const connectivity = await refreshConnectivityState({ probeLocal: true })
    .catch(() => getConnectivityState())
  if (!connectivity.internetAvailable) {
    throw new Error('Branch transfers require an internet connection and were not queued.')
  }
  return transferDrugToBranch(transfer)
}

export { calculateDrugStatus, isDefaultCatalogDrug, provisionDefaultMedicationCatalog }
export {
  discardOfflineInventoryConflicts,
  getOfflineInventorySummary,
  subscribeOfflineInventoryQueue,
  syncOfflineInventory,
}
