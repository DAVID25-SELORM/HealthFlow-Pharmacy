import { useEffect, useRef, useState } from 'react'
import { Plus, Search, Phone, Mail } from 'lucide-react'
import {
  addPatient,
  getAllPatients,
  getPatientById,
  getPatientLastVisit,
  getPatientVisitCount,
  searchPatients,
} from '../services/patientService'
import { isSupabaseConfigured } from '../lib/supabase'
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
  const [patients, setPatients] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [selectedPatient, setSelectedPatient] = useState(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [error, setError] = useState('')
  const [formData, setFormData] = useState(initialForm)
  const historyRequestRef = useRef(0)

  useEffect(() => {
    void loadPatients()
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

  const closeHistoryModal = () => {
    historyRequestRef.current += 1
    setSelectedPatient(null)
    setHistoryLoading(false)
  }

  const openPatientHistory = async (patient) => {
    const requestId = historyRequestRef.current + 1
    historyRequestRef.current = requestId
    setSelectedPatient({
      ...patient,
      sales: [],
      claims: [],
    })
    setHistoryLoading(true)

    try {
      const detail = await getPatientById(patient.id)
      const sales = [...(detail.sales || [])].sort(
        (left, right) => new Date(right.sale_date) - new Date(left.sale_date)
      )
      const claims = [...(detail.claims || [])].sort(
        (left, right) => new Date(right.service_date) - new Date(left.service_date)
      )

      if (historyRequestRef.current !== requestId) {
        return
      }

      setSelectedPatient({
        ...detail,
        visits: patient.visits,
        lastVisit: patient.lastVisit,
        sales,
        claims,
      })
    } catch (loadError) {
      if (historyRequestRef.current !== requestId) {
        return
      }

      console.error('Error loading patient history:', loadError)
      setError(loadError.message || 'Unable to load patient history.')
    } finally {
      if (historyRequestRef.current === requestId) {
        setHistoryLoading(false)
      }
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
                  .map((namePart) => namePart[0])
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
                    {patient.lastVisit
                      ? new Date(patient.lastVisit).toLocaleDateString()
                      : 'No visits yet'}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">Total Visits</span>
                  <span className="stat-value">{patient.visits}</span>
                </div>
              </div>
              <button className="btn btn-outline" onClick={() => void openPatientHistory(patient)}>
                View History
              </button>
            </div>
          ))
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal-content" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Add Patient</h2>
              <button className="close-btn" onClick={() => setShowModal(false)}>
                x
              </button>
            </div>
            <form className="patient-form" onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label>Full Name *</label>
                  <input
                    type="text"
                    value={formData.fullName}
                    onChange={(event) =>
                      setFormData({ ...formData, fullName: event.target.value })
                    }
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Phone *</label>
                  <input
                    type="text"
                    value={formData.phone}
                    onChange={(event) => setFormData({ ...formData, phone: event.target.value })}
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
                    onChange={(event) => setFormData({ ...formData, email: event.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Date of Birth</label>
                  <input
                    type="date"
                    value={formData.dateOfBirth}
                    onChange={(event) =>
                      setFormData({ ...formData, dateOfBirth: event.target.value })
                    }
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Gender</label>
                  <select
                    value={formData.gender}
                    onChange={(event) => setFormData({ ...formData, gender: event.target.value })}
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
                    onChange={(event) =>
                      setFormData({
                        ...formData,
                        insuranceProvider: event.target.value,
                      })
                    }
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Insurance ID</label>
                  <input
                    type="text"
                    value={formData.insuranceId}
                    onChange={(event) =>
                      setFormData({ ...formData, insuranceId: event.target.value })
                    }
                  />
                </div>
                <div className="form-group">
                  <label>Address</label>
                  <input
                    type="text"
                    value={formData.address}
                    onChange={(event) => setFormData({ ...formData, address: event.target.value })}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Allergies</label>
                <textarea
                  rows="2"
                  value={formData.allergies}
                  onChange={(event) =>
                    setFormData({ ...formData, allergies: event.target.value })
                  }
                />
              </div>

              <div className="form-group">
                <label>Medical Notes</label>
                <textarea
                  rows="3"
                  value={formData.medicalNotes}
                  onChange={(event) =>
                    setFormData({ ...formData, medicalNotes: event.target.value })
                  }
                />
              </div>

              <button className="btn btn-primary" type="submit" disabled={submitting}>
                {submitting ? 'Saving...' : 'Save Patient'}
              </button>
            </form>
          </div>
        </div>
      )}

      {selectedPatient && (
        <div className="modal-overlay" onClick={closeHistoryModal}>
          <div className="modal-content" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{selectedPatient.full_name}</h2>
              <button className="close-btn" onClick={closeHistoryModal}>
                x
              </button>
            </div>
            <div className="patient-form patient-history-panel">
              {historyLoading ? (
                <div className="patient-history-loading">Loading patient history...</div>
              ) : (
                <>
                  <div className="patient-history-grid">
                    <div className="patient-history-card">
                      <span className="patient-history-label">Phone</span>
                      <strong>{selectedPatient.phone}</strong>
                    </div>
                    <div className="patient-history-card">
                      <span className="patient-history-label">Email</span>
                      <strong>{selectedPatient.email || 'Not provided'}</strong>
                    </div>
                    <div className="patient-history-card">
                      <span className="patient-history-label">Last Visit</span>
                      <strong>
                        {selectedPatient.lastVisit
                          ? new Date(selectedPatient.lastVisit).toLocaleDateString()
                          : 'No visits yet'}
                      </strong>
                    </div>
                    <div className="patient-history-card">
                      <span className="patient-history-label">Total Visits</span>
                      <strong>{selectedPatient.visits}</strong>
                    </div>
                  </div>

                  <div className="patient-history-details">
                    <div className="form-group">
                      <label>Date of Birth</label>
                      <p>{selectedPatient.date_of_birth || 'Not provided'}</p>
                    </div>
                    <div className="form-group">
                      <label>Gender</label>
                      <p>{selectedPatient.gender || 'Not provided'}</p>
                    </div>
                    <div className="form-group">
                      <label>Address</label>
                      <p>{selectedPatient.address || 'Not provided'}</p>
                    </div>
                    <div className="form-group">
                      <label>Insurance</label>
                      <p>
                        {selectedPatient.insurance_provider
                          ? `${selectedPatient.insurance_provider} (${selectedPatient.insurance_id || 'No ID'})`
                          : 'Not provided'}
                      </p>
                    </div>
                    <div className="form-group">
                      <label>Allergies</label>
                      <p>{selectedPatient.allergies || 'None recorded'}</p>
                    </div>
                    <div className="form-group">
                      <label>Medical Notes</label>
                      <p>{selectedPatient.medical_notes || 'No notes recorded'}</p>
                    </div>
                  </div>

                  <div className="patient-history-sections">
                    <section className="patient-history-section">
                      <div className="patient-history-section-header">
                        <h3>Sales History</h3>
                        <span>{selectedPatient.sales?.length || 0} sale(s)</span>
                      </div>
                      {selectedPatient.sales?.length ? (
                        <div className="patient-history-list">
                          {selectedPatient.sales.map((sale) => (
                            <div key={sale.id} className="patient-history-row">
                              <div>
                                <strong>{sale.sale_number}</strong>
                                <p>{new Date(sale.sale_date).toLocaleString()}</p>
                              </div>
                              <div className="patient-history-meta">
                                <span>{sale.payment_method}</span>
                                <strong>
                                  GHS {Number.parseFloat(sale.net_amount || 0).toFixed(2)}
                                </strong>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="patient-history-empty">
                          No recorded sales for this patient yet.
                        </p>
                      )}
                    </section>

                    <section className="patient-history-section">
                      <div className="patient-history-section-header">
                        <h3>Claims History</h3>
                        <span>{selectedPatient.claims?.length || 0} claim(s)</span>
                      </div>
                      {selectedPatient.claims?.length ? (
                        <div className="patient-history-list">
                          {selectedPatient.claims.map((claim) => (
                            <div key={claim.id} className="patient-history-row">
                              <div>
                                <strong>{claim.claim_number}</strong>
                                <p>{new Date(claim.service_date).toLocaleDateString()}</p>
                              </div>
                              <div className="patient-history-meta">
                                <span
                                  className={`patient-history-status status-${claim.claim_status}`}
                                >
                                  {claim.claim_status}
                                </span>
                                <strong>
                                  GHS {Number.parseFloat(claim.total_amount || 0).toFixed(2)}
                                </strong>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="patient-history-empty">
                          No insurance claims recorded for this patient.
                        </p>
                      )}
                    </section>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Patients
