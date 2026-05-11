import { useEffect, useMemo, useState } from 'react'
import { Plus, Download, Eye, CheckCircle2, XCircle, Search } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { dispatchHealthflowDataChanged } from '../lib/appEvents'
import {
  approveClaim,
  createClaim,
  getAllClaims,
  getClaimsStatistics,
  rejectClaim,
} from '../services/claimsService'
import { getAllPatients } from '../services/patientService'
import { getAllDrugs } from '../services/drugService'
import { isSupabaseConfigured } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import { useTenant } from '../context/TenantContext'
import { formatAppDate } from '../utils/date'
import { getInsuranceProviderOptions } from '../utils/insuranceProviders'
import { CLAIMS_ROLES, hasRole } from '../utils/roles'
import UpgradeGate from '../components/UpgradeGate'
import './Claims.css'

const blankForm = {
  patientId: '',
  insuranceProvider: '',
  insuranceId: '',
  serviceDate: new Date().toISOString().split('T')[0],
  notes: '',
}

const validClaimTabs = ['all', 'pending', 'approved', 'rejected']

const matchesSearch = (values, term) => {
  const normalizedTerm = term.trim().toLowerCase()
  if (!normalizedTerm) {
    return true
  }

  return values
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalizedTerm))
}

const Claims = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const { user, role, profile, branch, canManageClaims } = useAuth()
  const { notify } = useNotification()
  const { canUseClaims, tierLimits } = useTenant()
  const canProcess = canManageClaims || hasRole(role, CLAIMS_ROLES)

  const [showNewClaimModal, setShowNewClaimModal] = useState(false)
  const [activeTab, setActiveTab] = useState('all')
  const [claims, setClaims] = useState([])
  const [stats, setStats] = useState({ total: 0, pending: 0, approved: 0, rejected: 0 })
  const [patients, setPatients] = useState([])
  const [drugs, setDrugs] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [formData, setFormData] = useState(blankForm)
  const [claimItems, setClaimItems] = useState([])
  const [selectedDrugId, setSelectedDrugId] = useState('')
  const [selectedQty, setSelectedQty] = useState('1')
  const [drugLookupTerm, setDrugLookupTerm] = useState('')
  const [claimToReject, setClaimToReject] = useState(null)
  const [rejectionReason, setRejectionReason] = useState('')
  const [claimSearchTerm, setClaimSearchTerm] = useState('')
  const [patientLookupTerm, setPatientLookupTerm] = useState('')

  useEffect(() => {
    if (!canUseClaims || !tierLimits.hasClaims) {
      setClaims([])
      setStats({ total: 0, pending: 0, approved: 0, rejected: 0 })
      setPatients([])
      setDrugs([])
      setError('')
      setLoading(false)
      return
    }

    void loadClaims()
  }, [canUseClaims, tierLimits.hasClaims])

  useEffect(() => {
    const routeTab = searchParams.get('tab')
    const nextTab = validClaimTabs.includes(routeTab) ? routeTab : 'all'
    setActiveTab((current) => (current === nextTab ? current : nextTab))
  }, [searchParams])

  const setTabAndRoute = (tab) => {
    setActiveTab(tab)

    const params = new URLSearchParams(searchParams)
    if (tab === 'all') {
      params.delete('tab')
    } else {
      params.set('tab', tab)
    }

    setSearchParams(params, { replace: true })
  }

  const loadClaims = async () => {
    try {
      setLoading(true)
      setError('')

      if (!isSupabaseConfigured()) {
        setClaims([])
        setStats({ total: 0, pending: 0, approved: 0, rejected: 0 })
        setError('Supabase is not configured. Update .env to enable claims.')
        return
      }

      const [claimsData, statistics, patientData, drugData] = await Promise.all([
        getAllClaims(),
        getClaimsStatistics(),
        getAllPatients(),
        getAllDrugs({ useTierAccess: true }),
      ])

      setClaims(claimsData)
      setStats(statistics)
      setPatients(patientData)
      setDrugs(drugData)
    } catch (loadError) {
      console.error('Error loading claims:', loadError)
      setError(loadError.message || 'Unable to load claims.')
    } finally {
      setLoading(false)
    }
  }

  const selectedPatient = useMemo(
    () => patients.find((patient) => patient.id === formData.patientId),
    [patients, formData.patientId]
  )

  const filteredPatientsForClaim = useMemo(
    () =>
      patients.filter((patient) =>
        matchesSearch(
          [
            patient.full_name,
            patient.phone,
            patient.email,
            patient.insurance_provider,
            patient.insurance_id,
          ],
          patientLookupTerm
        )
      ),
    [patients, patientLookupTerm]
  )

  const claimTotal = useMemo(
    () => claimItems.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [claimItems]
  )

  const filteredDrugsForClaim = useMemo(
    () =>
      drugs.filter((drug) =>
        matchesSearch(
          [
            drug.name,
            drug.generic_name,
            drug.brand,
            drug.batch_number,
            drug.barcode,
            drug.code,
            drug.sku,
            drug.price,
          ],
          drugLookupTerm
        )
      ),
    [drugs, drugLookupTerm]
  )

  const visibleDrugMatches = useMemo(
    () => (drugLookupTerm.trim() ? filteredDrugsForClaim.slice(0, 8) : []),
    [drugLookupTerm, filteredDrugsForClaim]
  )

  const selectedDrugForClaim = useMemo(
    () => drugs.find((drug) => drug.id === selectedDrugId),
    [drugs, selectedDrugId]
  )

  const selectDrugForClaim = (drug) => {
    setSelectedDrugId(drug.id)
    setDrugLookupTerm(drug.name)
  }

  const addClaimItem = () => {
    const drug = drugs.find((row) => row.id === selectedDrugId)
    const qty = Number.parseFloat(selectedQty)

    if (!drug || !Number.isFinite(qty) || qty <= 0) {
      return
    }

    setClaimItems((current) => {
      const existing = current.find((item) => item.drugId === drug.id)
      if (existing) {
        return current.map((item) =>
          item.drugId === drug.id ? { ...item, quantity: item.quantity + qty } : item
        )
      }

      return [
        ...current,
        {
          drugId: drug.id,
          name: drug.name,
          quantity: qty,
          price: Number.parseFloat(drug.price),
        },
      ]
    })

    setSelectedDrugId('')
    setSelectedQty('1')
    setDrugLookupTerm('')
  }

  const removeClaimItem = (drugId) => {
    setClaimItems((current) => current.filter((item) => item.drugId !== drugId))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()

    if (!selectedPatient) {
      setError('Select a patient before submitting a claim.')
      return
    }

    if (!claimItems.length) {
      setError('Add at least one drug item to submit a claim.')
      return
    }

    try {
      setSubmitting(true)
      setError('')

      await createClaim({
        patientId: selectedPatient.id,
        patientName: selectedPatient.full_name,
        insuranceProvider: formData.insuranceProvider || selectedPatient.insurance_provider,
        insuranceId: formData.insuranceId || selectedPatient.insurance_id,
        serviceDate: formData.serviceDate,
        notes: formData.notes,
        items: claimItems,
        submittedBy: user?.id || null,
        branchId: profile?.branch_id || branch?.id || null,
      })

      setShowNewClaimModal(false)
      setFormData(blankForm)
      setClaimItems([])
      await loadClaims()
      dispatchHealthflowDataChanged()
    } catch (submitError) {
      console.error('Error creating claim:', submitError)
      setError(submitError.message || 'Unable to create claim.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleApprove = async (claim) => {
    try {
      await approveClaim(claim.id, claim.total_amount)
      notify(`Claim ${claim.claim_number} approved.`, 'success')
      await loadClaims()
      dispatchHealthflowDataChanged()
    } catch (actionError) {
      setError(actionError.message || 'Unable to approve claim.')
    }
  }

  const openRejectModal = (claim) => {
    setClaimToReject(claim)
    setRejectionReason('')
  }

  const handleReject = async () => {
    if (!claimToReject) {
      return
    }

    if (!rejectionReason.trim()) {
      notify('Rejection reason is required.', 'warning')
      return
    }

    try {
      await rejectClaim(claimToReject.id, rejectionReason.trim())
      notify(`Claim ${claimToReject.claim_number} rejected.`, 'info')
      setClaimToReject(null)
      setRejectionReason('')
      await loadClaims()
      dispatchHealthflowDataChanged()
    } catch (actionError) {
      setError(actionError.message || 'Unable to reject claim.')
    }
  }

  const downloadClaimCsv = (claim) => {
    const itemSummary =
      claim.claim_items?.map((item) => `${item.drug_name} x${item.quantity}`).join(' | ') ||
      'No claim items recorded'

    const rows = [
      ['Claim Number', claim.claim_number],
      ['Patient', claim.patient_name],
      ['Insurance Provider', claim.insurance_provider],
      ['Insurance ID', claim.insurance_id],
      ['Service Date', claim.service_date],
      ['Status', claim.claim_status],
      ['Total Amount', Number.parseFloat(claim.total_amount || 0).toFixed(2)],
      ['Items', itemSummary],
      ['Notes', claim.notes || ''],
    ]

    const csv = rows
      .map(([label, value]) => `"${label}","${String(value ?? '').replace(/"/g, '""')}"`)
      .join('\n')

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${claim.claim_number}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  const handleExport = (claim) => {
    try {
      downloadClaimCsv(claim)
      notify(`Claim ${claim.claim_number} exported successfully.`, 'success')
    } catch (exportError) {
      console.error('Unable to export claim:', exportError)
      notify('Unable to export this claim right now.', 'error')
    }
  }

  const filteredClaims = useMemo(() => {
    const tabbedClaims =
      activeTab === 'all'
        ? claims
        : claims.filter((claim) => claim.claim_status === activeTab)

    return tabbedClaims.filter((claim) =>
      matchesSearch(
        [
          claim.claim_number,
          claim.patient_name,
          claim.insurance_provider,
          claim.insurance_id,
          claim.patients?.phone,
        ],
        claimSearchTerm
      )
    )
  }, [claims, activeTab, claimSearchTerm])

  const getStatusClass = (status) => {
    const classes = {
      approved: 'status-approved',
      pending: 'status-pending',
      rejected: 'status-rejected',
      processing: 'status-processing',
    }

    return classes[status] || 'status-pending'
  }

  if (loading) {
    return (
      <div className="claims-page">
        <div className="page-header">
          <h1>Loading Claims...</h1>
        </div>
      </div>
    )
  }

  return (
    <UpgradeGate locked={!canUseClaims || !tierLimits.hasClaims} feature="Insurance Claims" requiredTier="module">
    <div className="claims-page">
      <div className="page-header">
        <div>
          <h1>Insurance Claims</h1>
          <p>Manage and track insurance claims submissions</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNewClaimModal(true)}>
          <Plus size={20} />
          New Claim
        </button>
      </div>

      {error && <div className="claims-alert">{error}</div>}

      <div className="claims-stats">
        <div className="stat-box">
          <span className="stat-label">Total Claims</span>
          <span className="stat-value">{stats.total}</span>
        </div>
        <div className="stat-box approved">
          <span className="stat-label">Approved</span>
          <span className="stat-value">{stats.approved}</span>
        </div>
        <div className="stat-box pending">
          <span className="stat-label">Pending</span>
          <span className="stat-value">{stats.pending}</span>
        </div>
        <div className="stat-box rejected">
          <span className="stat-label">Rejected</span>
          <span className="stat-value">{stats.rejected}</span>
        </div>
      </div>

      <div className="claims-tabs">
        {validClaimTabs.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setTabAndRoute(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            <span className="tab-count">{tab === 'all' ? stats.total : stats[tab] || 0}</span>
          </button>
        ))}
      </div>

      <label className="claims-search">
        <Search size={18} />
        <input
          type="search"
          placeholder="Search claims by patient, phone, insurer, claim no., or insurance no."
          value={claimSearchTerm}
          onChange={(event) => setClaimSearchTerm(event.target.value)}
        />
      </label>

      <div className="table-container">
        <table className="claims-table">
          <thead>
            <tr>
              <th>Claim ID</th>
              <th>Patient</th>
              <th>Insurance</th>
              <th>Amount (GHS)</th>
              <th>Service Date</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredClaims.length === 0 ? (
              <tr>
                <td colSpan="7" style={{ textAlign: 'center', padding: '2rem' }}>
                  No claims found for this filter.
                </td>
              </tr>
            ) : (
              filteredClaims.map((claim) => (
                <tr key={claim.id}>
                  <td className="claim-id">{claim.claim_number}</td>
                  <td>{claim.patient_name}</td>
                  <td>
                    {claim.insurance_provider}
                    <span className="claim-insurance-id">{claim.insurance_id}</span>
                  </td>
                  <td className="amount-cell">
                    GHS {Number.parseFloat(claim.total_amount || 0).toFixed(2)}
                  </td>
                  <td>{formatAppDate(claim.service_date)}</td>
                  <td>
                    <span className={`status-badge ${getStatusClass(claim.claim_status)}`}>
                      {claim.claim_status}
                    </span>
                  </td>
                  <td>
                    <div className="action-buttons">
                      <button
                        type="button"
                        className="icon-btn"
                        title="View Notes"
                        onClick={() =>
                          notify(claim.notes || 'No notes recorded for this claim.', 'info')
                        }
                      >
                        <Eye size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Export"
                        onClick={() => handleExport(claim)}
                      >
                        <Download size={16} />
                      </button>
                      {canProcess && claim.claim_status === 'pending' && (
                        <>
                          <button
                            type="button"
                            className="icon-btn success"
                            title="Approve"
                            onClick={() => handleApprove(claim)}
                          >
                            <CheckCircle2 size={16} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn danger"
                            title="Reject"
                            onClick={() => openRejectModal(claim)}
                          >
                            <XCircle size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showNewClaimModal && (
        <div className="modal-overlay" onClick={() => setShowNewClaimModal(false)}>
          <div className="modal-content" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Submit New Claim</h2>
              <button className="close-btn" onClick={() => setShowNewClaimModal(false)}>
                x
              </button>
            </div>
            <form className="claim-form" onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label>Patient *</label>
                  <label className="claim-patient-search">
                    <Search size={16} />
                    <input
                      type="search"
                      placeholder="Find by name, phone, insurer, or insurance no."
                      value={patientLookupTerm}
                      onChange={(event) => setPatientLookupTerm(event.target.value)}
                    />
                  </label>
                  <select
                    required
                    value={formData.patientId}
                    onChange={(event) => {
                      const nextPatientId = event.target.value
                      const nextPatient = patients.find((patient) => patient.id === nextPatientId)
                      setFormData({
                        ...formData,
                        patientId: nextPatientId,
                        insuranceProvider:
                          nextPatient?.insurance_provider || formData.insuranceProvider,
                        insuranceId: nextPatient?.insurance_id || formData.insuranceId,
                      })
                    }}
                  >
                    <option value="">Select patient</option>
                    {filteredPatientsForClaim.map((patient) => (
                      <option key={patient.id} value={patient.id}>
                        {patient.full_name} ({patient.phone || 'No phone'})
                        {patient.insurance_id ? ` - ${patient.insurance_id}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Date of Service *</label>
                  <input
                    type="date"
                    required
                    value={formData.serviceDate}
                    onChange={(event) =>
                      setFormData({ ...formData, serviceDate: event.target.value })
                    }
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Insurance Provider *</label>
                  <select
                    required
                    value={formData.insuranceProvider}
                    onChange={(event) =>
                      setFormData({ ...formData, insuranceProvider: event.target.value })
                    }
                  >
                    <option value="">Select insurance provider</option>
                    {getInsuranceProviderOptions(formData.insuranceProvider).map((provider) => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Insurance ID *</label>
                  <input
                    type="text"
                    required
                    value={formData.insuranceId}
                    onChange={(event) =>
                      setFormData({ ...formData, insuranceId: event.target.value })
                    }
                  />
                </div>
              </div>

              <div className="claim-items-box">
                <h4>Claim Items</h4>
                <label className="claim-drug-search">
                  <Search size={16} />
                  <input
                    type="search"
                    placeholder="Search drugs by name, batch, barcode, code, or price"
                    value={drugLookupTerm}
                    onChange={(event) => {
                      setDrugLookupTerm(event.target.value)
                      setSelectedDrugId('')
                    }}
                  />
                </label>
                {visibleDrugMatches.length > 0 && !selectedDrugId && (
                  <div className="claim-drug-results">
                    {visibleDrugMatches.map((drug) => (
                      <button
                        key={drug.id}
                        type="button"
                        className="claim-drug-result"
                        onClick={() => selectDrugForClaim(drug)}
                      >
                        <span>
                          <strong>{drug.name}</strong>
                          <small>
                            {drug.batch_number ? `Batch ${drug.batch_number}` : 'No batch'}
                            {drug.barcode ? ` / ${drug.barcode}` : ''}
                          </small>
                        </span>
                        <b>GHS {Number.parseFloat(drug.price || 0).toFixed(2)}</b>
                      </button>
                    ))}
                  </div>
                )}
                {drugLookupTerm.trim() && filteredDrugsForClaim.length === 0 && (
                  <div className="claim-drug-empty">No matching drugs found.</div>
                )}
                <div className="item-inputs">
                  <select
                    value={selectedDrugId}
                    onChange={(event) => {
                      const nextDrug = drugs.find((drug) => drug.id === event.target.value)
                      setSelectedDrugId(event.target.value)
                      setDrugLookupTerm(nextDrug?.name || '')
                    }}
                  >
                    <option value="">
                      {filteredDrugsForClaim.length ? 'Select drug' : 'No matching drugs'}
                    </option>
                    {filteredDrugsForClaim.map((drug) => (
                      <option key={drug.id} value={drug.id}>
                        {drug.name} - GHS {Number.parseFloat(drug.price || 0).toFixed(2)}
                        {drug.batch_number ? ` - Batch ${drug.batch_number}` : ''}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={selectedQty}
                    onChange={(event) => setSelectedQty(event.target.value)}
                  />
                  <button type="button" className="btn btn-outline" onClick={addClaimItem}>
                    Add Item
                  </button>
                </div>
                {selectedDrugForClaim && (
                  <div className="claim-selected-drug">
                    Selected: <strong>{selectedDrugForClaim.name}</strong>
                  </div>
                )}

                <div className="claim-item-list">
                  {claimItems.map((item) => (
                    <div key={item.drugId} className="claim-item-row">
                      <span>{item.name}</span>
                      <span>
                        {item.quantity} x GHS {item.price.toFixed(2)} = GHS{' '}
                        {(item.quantity * item.price).toFixed(2)}
                      </span>
                      <button
                        type="button"
                        className="icon-btn danger"
                        onClick={() => removeClaimItem(item.drugId)}
                      >
                        <XCircle size={14} />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="claim-total">Total Claim: GHS {claimTotal.toFixed(2)}</div>
              </div>

              <div className="form-group">
                <label>Additional Notes</label>
                <textarea
                  rows="2"
                  value={formData.notes}
                  onChange={(event) =>
                    setFormData({ ...formData, notes: event.target.value })
                  }
                />
              </div>

              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setShowNewClaimModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Submitting...' : 'Submit Claim'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {claimToReject && (
        <div className="modal-overlay" onClick={() => setClaimToReject(null)}>
          <div className="modal-content reject-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Reject Claim {claimToReject.claim_number}</h2>
              <button className="close-btn" onClick={() => setClaimToReject(null)}>
                x
              </button>
            </div>
            <div className="claim-form">
              <div className="form-group">
                <label>Reason for rejection *</label>
                <textarea
                  rows="3"
                  value={rejectionReason}
                  onChange={(event) => setRejectionReason(event.target.value)}
                  placeholder="Provide a clear reason for rejection"
                />
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setClaimToReject(null)}
                >
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" onClick={handleReject}>
                  Confirm Rejection
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
    </UpgradeGate>
  )
}

export default Claims
