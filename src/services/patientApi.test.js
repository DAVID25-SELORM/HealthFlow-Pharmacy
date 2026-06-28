import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getConnectivityState,
  getOfflinePatientsSummary,
  queueOfflinePatient,
  refreshConnectivityState,
  subscribeOfflinePatientsQueue,
  syncOfflinePatients,
} = vi.hoisted(() => ({
  getConnectivityState: vi.fn(),
  getOfflinePatientsSummary: vi.fn(),
  queueOfflinePatient: vi.fn(),
  refreshConnectivityState: vi.fn(),
  subscribeOfflinePatientsQueue: vi.fn(),
  syncOfflinePatients: vi.fn(),
}))

vi.mock('./patientService', () => ({
  addPatient: vi.fn(),
  getPatientById: vi.fn(),
  getPatientsWorkspacePage: vi.fn(),
}))

vi.mock('./offlinePatientsQueue', () => ({
  getOfflinePatientsSummary,
  queueOfflinePatient,
  subscribeOfflinePatientsQueue,
  syncOfflinePatients,
}))

vi.mock('./connectivityService', () => ({
  getConnectivityState,
  refreshConnectivityState,
}))

import {
  addPatient,
  getPatientById,
  getPatientsWorkspacePage,
} from './patientService'
import {
  createPatientRecord,
  getPatientRecord,
  listPatientWorkspacePage,
} from './patientApi'

describe('patientApi', () => {
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

  it('forwards patient workspace queries', async () => {
    const options = { page: 2, pageSize: 100, search: 'Ama' }
    getPatientsWorkspacePage.mockResolvedValue({ data: [], count: 0 })

    await listPatientWorkspacePage(options)

    expect(getPatientsWorkspacePage).toHaveBeenCalledWith(options)
  })

  it('forwards patient record commands', async () => {
    const patient = { firstName: 'Ama' }
    const context = { organizationId: 'org-1' }

    await createPatientRecord(patient, context)
    await getPatientRecord('patient-1')

    expect(addPatient).toHaveBeenCalledWith(patient)
    expect(getPatientById).toHaveBeenCalledWith('patient-1')
  })

  it('queues patient creation when neither cloud nor branch server is available', async () => {
    const patient = { fullName: 'Ama Mensah' }
    const context = {
      organizationId: 'org-1',
      branchId: 'branch-1',
      createdBy: 'user-1',
    }
    refreshConnectivityState.mockResolvedValue({
      internetAvailable: false,
      branchServerAvailable: false,
    })
    queueOfflinePatient.mockResolvedValue({ id: 'offline-1', status: 'pending' })

    await expect(createPatientRecord(patient, context)).resolves.toEqual({
      id: 'offline-1',
      offlineQueued: true,
      syncStatus: 'pending',
    })
    expect(queueOfflinePatient).toHaveBeenCalledWith({
      patientPayload: patient,
      organizationId: 'org-1',
      branchId: 'branch-1',
      createdBy: 'user-1',
    })
    expect(addPatient).not.toHaveBeenCalled()
  })

  it('does not queue validation or server errors while a route is available', async () => {
    const error = new Error('Folder number already exists.')
    addPatient.mockRejectedValue(error)

    await expect(createPatientRecord({ fullName: 'Ama Mensah' })).rejects.toBe(error)
    expect(queueOfflinePatient).not.toHaveBeenCalled()
  })
})
