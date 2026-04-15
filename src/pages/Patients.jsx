import { useEffect, useState } from 'react'
import { Plus, Search, Phone, Mail } from 'lucide-react'
import {
  addPatient,
  getAllPatients,
  getPatientLastVisit,
  getPatientVisitCount,
  searchPatients,
} from '../services/patientService'
import { isSupabaseConfigured } from '../lib/supabase'
import { useNotification } from '../context/NotificationContext'
import './Patients.css'

const initialForm = {
  fullName: '',
  phone: '',
  email: '',
  dateOfBirth: '',
  gender: '',
  address: '',
  insuranceProvider: '',
  insuranceId: '',
  allergies: '',
  medicalNotes: '',
}

const Patients = () => {
  const { notify } = useNotification()
  const [patients, setPatients] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [error, setError] = useState('')
  const [formData, setFormData] = useState(initialForm)

  useEffect(() => {
    loadPatients()
  }, [])

  const enrichPatients = async (records) => {
    const enriched = await Promise.all(
      records.map(async (patient) => {
        const [visits, lastVisit] = await Promise.all([
          getPatientVisitCount(patient.id),
          getPatientLastVisit(patient.id),
        ])

        return {
          ...patient,
          visits: visits || 0,
          lastVisit,
        }
      })
    )

    return enriched
  }

  const loadPatients = async (term = '') => {
    try {
      setLoading(true)
      setError('')

      if (!isSupabaseConfigured()) {
        setPatients([])
        setError('Supabase is not configured. Update .env to enable patient records.')
        return
      }

      const rows = term.trim() ? await searchPatients(term) : await getAllPatients()
      const enriched = await enrichPatients(rows)
      setPatients(enriched)
    } catch (loadError) {
      console.error('Error loading patients:', loadError)
      setError(loadError.message || 'Unable to load patient records.')
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = async (event) => {
    const term = event.target.value
    setSearchTerm(term)
    await loadPatients(term)
  }

  const handleSubmit = async (event) => {
    event.preventDefault()

    try {
      setSubmitting(true)
      setError('')

      await addPatient(formData)
      setShowModal(false)
      setFormData(initialForm)
      await loadPatients(searchTerm)
    } catch (submitError) {
      console.error('Error adding patient:', submitError)
      setError(submitError.message || 'Unable to add patient.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="patients-page">
        <div className="page-header">
          <h1>Loading patients...</h1>
        </div>
      </div>
    )
  }

  return (
    <div className="patients-page">
      <div className="page-header">
        <div>
          <h1>Patient Records</h1>
          <p>Manage patient information and prescription history</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          <Plus size={20} />
          Add Patient
        </button>
      </div>

      {error && <div className="patient-alert">{error}</div>}

      <div className="search-container">
        <Search size={18} />
        <input
          type="text"
          placeholder="Search patients by name, phone, or email..."
          value={searchTerm}
          onChange={handleSearch}
        />
      </div>

      <div className="patients-grid">
        {patients.length === 0 ? (
          <div className="empty-patients">No patients found.</div>
        ) : (
          patients.map((patient) => (
            <div key={patient.id} className="patient-card">
              <div className="patient-avatar">
                {patient.full_name
                  .split(' ')
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((n) => n[0])
                  .join('')}
              </div>
              <div className="patient-info">
                <h3>{patient.full_name}</h3>
                <div className="contact-info">
                  <span>
                    <Phone size={14} />
                    {patient.phone}
                  </span>
                  <span>
                    <Mail size={14} />
                    {patient.email || 'No email provided'}
                  </span>
                </div>
              </div>
              <div className="patient-stats">
                <div className="stat">
                  <span className="stat-label">Last Visit</span>
                  <span className="stat-value">
                    {patient.lastVisit ? new Date(patient.lastVisit).toLocaleDateString() : 'No visits yet'}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">Total Visits</span>
                  <span className="stat-value">{patient.visits}</span>
                </div>
              </div>
              <button
                className="btn btn-outline"
                onClick={() => notify('Patient history view is next in the execution backlog.', 'info')}
              >
                View History
              </button>
            </div>
          ))
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Add Patient</h2>
              <button className="close-btn" onClick={() => setShowModal(false)}>
                ×
              </button>
            </div>
            <form className="patient-form" onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label>Full Name *</label>
                  <input
                    type="text"
                    value={formData.fullName}
                    onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Phone *</label>
                  <input
                    type="text"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Email</label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Date of Birth</label>
                  <input
                    type="date"
                    value={formData.dateOfBirth}
                    onChange={(e) => setFormData({ ...formData, dateOfBirth: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Gender</label>
                  <select
                    value={formData.gender}
                    onChange={(e) => setFormData({ ...formData, gender: e.target.value })}
                  >
                    <option value="">Select gender</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Insurance Provider</label>
                  <input
                    type="text"
                    value={formData.insuranceProvider}
                    onChange={(e) => setFormData({ ...formData, insuranceProvider: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Insurance ID</label>
                  <input
                    type="text"
                    value={formData.insuranceId}
                    onChange={(e) => setFormData({ ...formData, insuranceId: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Address</label>
                  <input
                    type="text"
                    value={formData.address}
                    onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Allergies</label>
                <textarea
                  rows="2"
                  value={formData.allergies}
                  onChange={(e) => setFormData({ ...formData, allergies: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>Medical Notes</label>
                <textarea
                  rows="3"
                  value={formData.medicalNotes}
                  onChange={(e) => setFormData({ ...formData, medicalNotes: e.target.value })}
                />
              </div>

              <button className="btn btn-primary" type="submit" disabled={submitting}>
                {submitting ? 'Saving...' : 'Save Patient'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default Patients
