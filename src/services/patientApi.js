import {
  addPatient,
  getPatientById,
  getPatientsWorkspacePage,
} from './patientService'

export const listPatientWorkspacePage = async (options) =>
  getPatientsWorkspacePage(options)

export const createPatientRecord = async (patient) => addPatient(patient)

export const getPatientRecord = async (id) => getPatientById(id)
