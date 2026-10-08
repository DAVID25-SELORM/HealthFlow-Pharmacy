import { useEffect, useState } from 'react'
import { addPatient, getPatientById, updatePatient } from '../services/patientService'

const fields = {
  fullName: 'Patient name', phone: 'Phone / contact number', email: 'Email',
  folderNo: 'Folder number', dateOfBirth: 'Date of birth', gender: 'Gender',
  address: 'Address', insuranceProvider: 'Insurance provider', insuranceId: 'Insurance / NHIS ID',
  allergies: 'Allergies', medicalNotes: 'Medical notes',
}

export default function PatientEditor({ patient, onSaved, onClose }) {
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    // Lists may contain only summary fields. Load the full record before editing
    // so saving contacts cannot clear allergies, notes or other unseen details.
    getPatientById(patient.id).then((record) => {
      if (!active) return
      if (!record) throw new Error('Patient could not be loaded. Close and try again.')
      setForm({
        fullName: record.full_name || '', phone: record.phone || '', email: record.email || '',
        folderNo: record.folder_no || '', dateOfBirth: record.date_of_birth || '',
        gender: String(record.gender || '').toLowerCase(), address: record.address || '',
        insuranceProvider: record.insurance_provider || (record.nhis_member_no ? 'NHIS' : ''),
        insuranceId: record.insurance_id || record.nhis_member_no || '',
        allergies: record.allergies || '', medicalNotes: record.medical_notes || '',
        nhisHin: record.nhis_hin || '',
      })
    }).catch((failure) => { if (active) setError(failure.message || 'Unable to load patient.') })
    return () => { active = false }
  }, [patient.id])

  const save = async (event) => {
    event.preventDefault()
    if (saving || !form) return
    setSaving(true)
    setError('')
    try {
      // Claim-only folders do not yet have a patient row to update.
      const saved = String(patient.id).startsWith('nhis-claim-')
        ? await addPatient(form)
        : await updatePatient(patient.id, form)
      if (!saved?.id) throw new Error('Patient was not updated. Reload and try again.')
      onSaved(saved)
    } catch (failure) {
      setError(failure.message || 'Unable to save patient.')
    } finally { setSaving(false) }
  }

  return <div className="modal-overlay" style={{ zIndex: 1200 }}>
    <section className="modal-content" role="dialog" aria-modal="true" aria-labelledby="patient-editor-title"
      style={{ width: 'min(620px, 95vw)', maxHeight: '90dvh', overflowY: 'auto', padding: '1.5rem', background: 'white', borderRadius: '8px' }}>
      <h2 id="patient-editor-title">Edit patient / contacts</h2>
      {error && <p role="alert">{error}</p>}
      {!form && !error && <p role="status">Loading patient details...</p>}
      <form onSubmit={save}>
        {form && Object.entries(fields).map(([field, label]) => <label className="form-group" key={field} style={{ display: 'block' }}>
          {label}{['fullName', 'phone', 'folderNo'].includes(field) ? ' *' : ''}
          {field === 'gender' ? <select className="form-input" value={form[field]} disabled={saving}
            onChange={(event) => setForm({ ...form, [field]: event.target.value })}>
            <option value="">Select gender</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option>
          </select> : <input className="form-input"
            type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : field === 'dateOfBirth' ? 'date' : 'text'}
            required={['fullName', 'phone', 'folderNo'].includes(field)} disabled={saving}
            value={form[field]} onChange={(event) => setForm({ ...form, [field]: event.target.value })} />}
        </label>)}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!form || saving}>{saving ? 'Saving...' : 'Save patient'}</button>
        </div>
      </form>
    </section>
  </div>
}
