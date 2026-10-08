import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import PatientEditor from './PatientEditor'
import { addPatient, getPatientById, updatePatient } from '../services/patientService'

vi.mock('../services/patientService', () => ({ addPatient: vi.fn(), getPatientById: vi.fn(), updatePatient: vi.fn() }))
beforeEach(() => vi.resetAllMocks())
const record = { id: 'patient-1', full_name: 'Ama Test', phone: '0240000000', folder_no: 'F001', allergies: 'Latex', medical_notes: 'Existing note' }

it('loads full details and preserves medical information when editing a contact', async () => {
  getPatientById.mockResolvedValue(record)
  updatePatient.mockResolvedValue({ ...record, phone: '0200000000' })
  const saved = vi.fn()
  render(<PatientEditor patient={{ id: record.id }} onSaved={saved} onClose={() => {}} />)
  fireEvent.change(await screen.findByLabelText('Phone / contact number *'), { target: { value: '0200000000' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save patient' }))
  await waitFor(() => expect(saved).toHaveBeenCalled())
  expect(updatePatient).toHaveBeenCalledWith(record.id, expect.objectContaining({ phone: '0200000000', allergies: 'Latex', medicalNotes: 'Existing note', folderNo: 'F001' }))
  expect(addPatient).not.toHaveBeenCalled()
})

it('creates a persistent patient for a claim-only folder and retains its NHIS identity', async () => {
  getPatientById.mockResolvedValue({ ...record, id: 'nhis-claim-123', nhis_member_no: '12345678', nhis_hin: 'HIN001' })
  addPatient.mockResolvedValue(record)
  render(<PatientEditor patient={{ id: 'nhis-claim-123' }} onSaved={() => {}} onClose={() => {}} />)
  await screen.findByLabelText('Phone / contact number *')
  fireEvent.click(screen.getByRole('button', { name: 'Save patient' }))
  await waitFor(() => expect(addPatient).toHaveBeenCalledWith(expect.objectContaining({ insuranceProvider: 'NHIS', insuranceId: '12345678', nhisHin: 'HIN001' })))
  expect(updatePatient).not.toHaveBeenCalled()
})

it('retains edits on a denied save and never reports success', async () => {
  getPatientById.mockResolvedValue(record)
  updatePatient.mockRejectedValue(new Error('Permission denied'))
  const saved = vi.fn()
  render(<PatientEditor patient={record} onSaved={saved} onClose={() => {}} />)
  fireEvent.change(await screen.findByLabelText('Phone / contact number *'), { target: { value: '0200000000' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save patient' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied')
  expect(screen.getByLabelText('Phone / contact number *')).toHaveValue('0200000000')
  expect(saved).not.toHaveBeenCalled()
})

it('does not allow a partial summary to overwrite a patient when loading fails', async () => {
  getPatientById.mockRejectedValue(new Error('Unable to load'))
  render(<PatientEditor patient={record} onSaved={() => {}} onClose={() => {}} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load')
  expect(screen.getByRole('button', { name: 'Save patient' })).toBeDisabled()
})
