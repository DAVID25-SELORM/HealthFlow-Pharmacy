import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./patientService', () => ({
  addPatient: vi.fn(),
  getPatientById: vi.fn(),
  getPatientsWorkspacePage: vi.fn(),
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
  })

  it('forwards patient workspace queries', async () => {
    const options = { page: 2, pageSize: 100, search: 'Ama' }
    getPatientsWorkspacePage.mockResolvedValue({ data: [], count: 0 })

    await listPatientWorkspacePage(options)

    expect(getPatientsWorkspacePage).toHaveBeenCalledWith(options)
  })

  it('forwards patient record commands', async () => {
    const patient = { firstName: 'Ama' }

    await createPatientRecord(patient)
    await getPatientRecord('patient-1')

    expect(addPatient).toHaveBeenCalledWith(patient)
    expect(getPatientById).toHaveBeenCalledWith('patient-1')
  })
})
