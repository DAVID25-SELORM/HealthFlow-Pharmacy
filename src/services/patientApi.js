import {
  addPatient,
  getPatientById,
  getPatientsWorkspacePage,
} from './patientService'
import {
  getOfflinePatientsSummary,
  queueOfflinePatient,
  subscribeOfflinePatientsQueue,
  syncOfflinePatients,
} from './offlinePatientsQueue'
import {
  getConnectivityState,
  refreshConnectivityState,
} from './connectivityService'

export const listPatientWorkspacePage = async (options) =>
  getPatientsWorkspacePage(options)

const queuePatientForLater = async (patient, context) => {
  const queuedPatient = await queueOfflinePatient({
    patientPayload: patient,
    organizationId: context.organizationId,
    branchId: context.branchId,
    createdBy: context.createdBy,
  })
  return {
    id: queuedPatient.id,
    offlineQueued: true,
    syncStatus: queuedPatient.status,
  }
}

const hasNoAvailableRoute = (connectivity) =>
  connectivity.internetAvailable === false &&
  connectivity.branchServerAvailable === false

export const createPatientRecord = async (patient, context = {}) => {
  const connectivity = await refreshConnectivityState({ probeLocal: true })
    .catch(() => getConnectivityState())

  if (hasNoAvailableRoute(connectivity)) {
    return queuePatientForLater(patient, context)
  }

  try {
    return await addPatient(patient)
  } catch (error) {
    const latestConnectivity = await refreshConnectivityState({ probeLocal: true })
      .catch(() => getConnectivityState())
    if (hasNoAvailableRoute(latestConnectivity)) {
      return queuePatientForLater(patient, context)
    }
    throw error
  }
}

export const getPatientRecord = async (id) => getPatientById(id)

export {
  getOfflinePatientsSummary,
  subscribeOfflinePatientsQueue,
  syncOfflinePatients,
}
