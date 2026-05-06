import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus, Search, X, Upload, Download, CheckCircle2,
  Send, Banknote, XCircle, Eye, FileSpreadsheet, HeartPulse,
} from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { isSupabaseConfigured } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import { formatAppDate } from '../utils/date'
import { NHIS_ROLES, hasRole } from '../utils/roles'
import {
  getAllNhisDrugs,
  getNhisDrugByCode,
  createNhisDrug,
  updateNhisDrug,
  deleteNhisDrug,
  upsertNhisDrugs,
  getAllNhisClaims,
  getNhisClaimStats,
  createNhisClaim,
  updateNhisClaimStatus,
  exportNhisMonthlyCSV,
} from '../services/nhisService'
import { getAllPatients } from '../services/patientService'
import { parseNhisDrugFile, generateNhisDrugTemplate } from '../services/nhisDrugImportService'
import './Nhis.css'

// ─── constants ────────────────────────────────────────────────────────────────

const CLAIM_STATUS_TABS = ['all', 'served', 'submitted', 'paid', 'rejected']

const BLANK_CLAIM = {
  patientId:         '',
  memberNo:          '',
  hin:               '',
  surname:           '',
  otherNames:        '',
  folderNo:          '',
  gender:            '',
  dateOfBirth:       '',
  cccNo:             '',
  serviceDateFrom:   new Date().toISOString().split('T')[0],
  serviceDateTo:     new Date().toISOString().split('T')[0],
  referringFacility: '',
  referralCode:      '',
  physicianName:     '',
  preAuthCodes:      '',
  notes:             '',
}

const BLANK_MEDICINE = {
  nhisDrugId:    '',
  drugCode:      '',
  description:   '',
  unit:          'unit',
  unitPrice:     '',
  dispensedQty:  '1',
  dispensaryDate: new Date().toISOString().split('T')[0],
  dose:          '',
  frequency:     '',
  duration:      '',
}

const BLANK_NHIS_DRUG = {
  code: '', description: '', genericName: '', strength: '',
  dosageForm: '', category: '', unit: 'unit', unitPrice: '',
}

const fmtCurrency = (n) =>
  `GHS ${Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const normalizeLookupText = (value) => String(value || '').toLowerCase()
const compactLookupText = (value) => normalizeLookupText(value).replace(/[^a-z0-9]/g, '')

const lookupMatches = (value, term) => {
  if (!value) return false
  return normalizeLookupText(value).includes(term) ||
    compactLookupText(value).includes(compactLookupText(term))
}

const StatusBadge = ({ status }) => (
  <span className={`nhis-badge nhis-badge--${status}`}>{status}</span>
)

// ─── component ────────────────────────────────────────────────────────────────

const Nhis = () => {
  const { role, user } = useAuth()
  const { notify } = useNotification()
  const [searchParams, setSearchParams] = useSearchParams()
  const fileInputRef = useRef(null)

  const canWrite = hasRole(role, NHIS_ROLES)

  // ── page sub-tab ─────────────────────────────────────────────
  const [pageTab, setPageTab] = useState('claims') // 'claims' | 'catalog'

  // ── data ─────────────────────────────────────────────────────
  const [claims, setClaims]       = useState([])
  const [nhisDrugs, setNhisDrugs] = useState([])
  const [patients, setPatients]   = useState([])
  const [stats, setStats]         = useState({ total: 0, served: 0, submitted: 0, paid: 0, rejected: 0, totalPaid: 0 })
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')

  // ── claims filter ─────────────────────────────────────────────
  const [claimTab, setClaimTab]         = useState('all')
  const [claimSearch, setClaimSearch]   = useState('')

  // ── catalog filter ────────────────────────────────────────────
  const [catalogSearch, setCatalogSearch] = useState('')

  // ── modals ────────────────────────────────────────────────────
  const [showNewClaimModal, setShowNewClaimModal]   = useState(false)
  const [showMedModal, setShowMedModal]             = useState(false)   // new medicine sub-modal
  const [showDrugCatalogModal, setShowDrugCatalogModal] = useState(false)
  const [showImportModal, setShowImportModal]       = useState(false)
  const [showExportModal, setShowExportModal]       = useState(false)
  const [viewClaim, setViewClaim]                   = useState(null)

  // ── new claim form ────────────────────────────────────────────
  const [claimForm, setClaimForm]           = useState(BLANK_CLAIM)
  const [claimMedicines, setClaimMedicines] = useState([])
  const [claimSubmitting, setClaimSubmitting] = useState(false)
  const [claimError, setClaimError]           = useState('')

  // ── patient lookup (for claim form) ──────────────────────────
  const [patientSearch, setPatientSearch] = useState('')

  // ── medicine sub-modal ────────────────────────────────────────
  const [medForm, setMedForm]           = useState(BLANK_MEDICINE)
  const [medCodeSearch, setMedCodeSearch] = useState('')
  const [medSearchResults, setMedSearchResults] = useState([])
  const [medSearching, setMedSearching] = useState(false)

  // ── drug catalog modal (add/edit) ─────────────────────────────
  const [editingDrug, setEditingDrug]   = useState(null) // null = add new
  const [drugForm, setDrugForm]         = useState(BLANK_NHIS_DRUG)
  const [drugSubmitting, setDrugSubmitting] = useState(false)

  // ── import modal ──────────────────────────────────────────────
  const [importRows, setImportRows]     = useState([])
  const [importErrors, setImportErrors] = useState([])
  const [importing, setImporting]       = useState(false)

  // ── export modal ──────────────────────────────────────────────
  const [exportMonth, setExportMonth]   = useState(
    new Date().toISOString().slice(0, 7) // YYYY-MM
  )
  const [exporting, setExporting]       = useState(false)

  // ── status update ─────────────────────────────────────────────
  const [updatingStatus, setUpdatingStatus] = useState(null)
  const [rejectTarget, setRejectTarget]     = useState(null)
  const [rejectReason, setRejectReason]     = useState('')

  // ── sync tab from URL ────────────────────────────────────────
  useEffect(() => {
    const t = searchParams.get('tab')
    if (CLAIM_STATUS_TABS.includes(t)) setClaimTab(t)
  }, [searchParams])

  const setStatusTab = (tab) => {
    setClaimTab(tab)
    const p = new URLSearchParams(searchParams)
    tab === 'all' ? p.delete('tab') : p.set('tab', tab)
    setSearchParams(p, { replace: true })
  }

  // ── load data ────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    if (!isSupabaseConfigured()) {
      setError('Supabase is not configured.')
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      setError('')
      const [claimsData, drugsData, patientsData, statsData] = await Promise.all([
        getAllNhisClaims(),
        getAllNhisDrugs(),
        getAllPatients(),
        getNhisClaimStats(),
      ])
      setClaims(claimsData)
      setNhisDrugs(drugsData)
      setPatients(patientsData)
      setStats(statsData)
    } catch (err) {
      setError(err.message || 'Unable to load NHIS data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadAll() }, [loadAll])

  // ── filtered claims ──────────────────────────────────────────
  const filteredClaims = useMemo(() => {
    const term = claimSearch.trim().toLowerCase()
    return claims.filter((c) => {
      if (claimTab !== 'all' && c.status !== claimTab) return false
      if (!term) return true
      return (
        (c.surname       || '').toLowerCase().includes(term) ||
        (c.other_names   || '').toLowerCase().includes(term) ||
        (c.member_no     || '').toLowerCase().includes(term) ||
        (c.claim_number  || '').toLowerCase().includes(term) ||
        (c.hin           || '').toLowerCase().includes(term)
      )
    })
  }, [claims, claimTab, claimSearch])

  // ── filtered catalog ─────────────────────────────────────────
  const filteredCatalog = useMemo(() => {
    const term = catalogSearch.trim().toLowerCase()
    if (!term) return nhisDrugs
    return nhisDrugs.filter(
      (d) =>
        d.code.toLowerCase().includes(term) ||
        d.description.toLowerCase().includes(term) ||
        (d.generic_name || '').toLowerCase().includes(term)
    )
  }, [nhisDrugs, catalogSearch])

  // ── filtered patients for claim form ─────────────────────────
  const filteredPatients = useMemo(() => {
    const term = patientSearch.trim().toLowerCase()
    if (!term) return []
    return patients
      .filter(
        (p) =>
          lookupMatches(p.full_name, term) ||
          lookupMatches(p.phone, term) ||
          lookupMatches(p.nhis_member_no, term) ||
          lookupMatches(p.insurance_id, term)
      )
      .slice(0, 10)
  }, [patients, patientSearch])

  // ── select patient for claim ──────────────────────────────────
  const selectPatient = (patient) => {
    setClaimForm((prev) => ({
      ...prev,
      patientId:   patient.id,
      surname:     (patient.full_name || '').split(' ')[0],
      otherNames:  (patient.full_name || '').split(' ').slice(1).join(' '),
      gender:      patient.gender     || '',
      dateOfBirth: patient.date_of_birth || '',
      memberNo:    patient.nhis_member_no || patient.insurance_id || '',
      hin:         patient.nhis_hin       || '',
    }))
    setPatientSearch('')
  }

  // ── medicine code search ──────────────────────────────────────
  const handleDrugCodeSearch = async () => {
    const code = medForm.drugCode.trim().toUpperCase()
    if (!code) return
    setMedSearching(true)
    try {
      const drug = await getNhisDrugByCode(code)
      if (drug) {
        setMedForm((prev) => ({
          ...prev,
          nhisDrugId:  drug.id,
          drugCode:    drug.code,
          description: drug.description,
          unit:        drug.unit,
          unitPrice:   String(drug.unit_price),
        }))
        setMedSearchResults([])
      } else {
        notify('No drug found with that code.', 'warning')
      }
    } catch (err) {
      notify(err.message || 'Search failed.', 'error')
    } finally {
      setMedSearching(false)
    }
  }

  // live search in local drug list while typing code
  useEffect(() => {
    const term = medCodeSearch.trim().toLowerCase()
    if (!term) { setMedSearchResults([]); return }
    setMedSearchResults(
      nhisDrugs
        .filter(
          (d) =>
            d.code.toLowerCase().startsWith(term) ||
            d.description.toLowerCase().includes(term)
        )
        .slice(0, 8)
    )
  }, [medCodeSearch, nhisDrugs])

  const selectMedFromDropdown = (drug) => {
    setMedForm((prev) => ({
      ...prev,
      nhisDrugId:   drug.id,
      drugCode:     drug.code,
      description:  drug.description,
      unit:         drug.unit,
      unitPrice:    String(drug.unit_price),
    }))
    setMedCodeSearch('')
    setMedSearchResults([])
  }

  // ── add medicine to claim ─────────────────────────────────────
  const addMedicineToList = () => {
    if (!medForm.description.trim()) { notify('Select a drug first.', 'warning'); return }
    const qty   = Number.parseFloat(medForm.dispensedQty) || 0
    const price = Number.parseFloat(medForm.unitPrice)    || 0
    if (qty <= 0) { notify('Dispensed quantity must be > 0.', 'warning'); return }

    setClaimMedicines((prev) => [
      ...prev,
      {
        nhisDrugId:    medForm.nhisDrugId   || null,
        drugCode:      medForm.drugCode,
        description:   medForm.description,
        unit:          medForm.unit,
        unitPrice:     price,
        dispensedQty:  qty,
        dispensaryDate: medForm.dispensaryDate || null,
        dose:          medForm.dose,
        frequency:     medForm.frequency,
        duration:      medForm.duration,
        totalAmount:   price * qty,
      },
    ])
    setMedForm(BLANK_MEDICINE)
    setMedCodeSearch('')
    setShowMedModal(false)
  }

  const removeMedicine = (index) => {
    setClaimMedicines((prev) => prev.filter((_, i) => i !== index))
  }

  const claimTotal = useMemo(
    () => claimMedicines.reduce((s, m) => s + m.totalAmount, 0),
    [claimMedicines]
  )

  // ── submit claim ──────────────────────────────────────────────
  const handleSubmitClaim = async (e) => {
    e.preventDefault()
    if (!claimMedicines.length) { setClaimError('Add at least one medicine.'); return }
    if (!claimForm.surname.trim())    { setClaimError('Surname is required.'); return }
    try {
      setClaimSubmitting(true)
      setClaimError('')
      await createNhisClaim(claimForm, claimMedicines)
      setShowNewClaimModal(false)
      resetClaimModal()
      await loadAll()
      notify('NHIS claim saved.', 'success')
    } catch (err) {
      setClaimError(err.message || 'Unable to save claim.')
    } finally {
      setClaimSubmitting(false)
    }
  }

  const resetClaimModal = () => {
    setClaimForm(BLANK_CLAIM)
    setClaimMedicines([])
    setClaimError('')
    setPatientSearch('')
    setMedForm(BLANK_MEDICINE)
  }

  // ── status updates ────────────────────────────────────────────
  const handleStatusUpdate = async (claim, newStatus) => {
    try {
      setUpdatingStatus(claim.id)
      await updateNhisClaimStatus(claim.id, newStatus)
      await loadAll()
      notify(`Claim ${claim.claim_number} marked as ${newStatus}.`, 'success')
    } catch (err) {
      notify(err.message || 'Update failed.', 'error')
    } finally {
      setUpdatingStatus(null)
    }
  }

  const handleRejectConfirm = async () => {
    if (!rejectReason.trim()) { notify('Rejection reason is required.', 'warning'); return }
    try {
      setUpdatingStatus(rejectTarget.id)
      await updateNhisClaimStatus(rejectTarget.id, 'rejected', rejectReason.trim())
      setRejectTarget(null)
      setRejectReason('')
      await loadAll()
      notify(`Claim ${rejectTarget.claim_number} rejected.`, 'info')
    } catch (err) {
      notify(err.message || 'Unable to reject claim.', 'error')
    } finally {
      setUpdatingStatus(null)
    }
  }

  // ── drug catalog CRUD ─────────────────────────────────────────
  const openAddDrug = () => {
    setEditingDrug(null)
    setDrugForm(BLANK_NHIS_DRUG)
    setShowDrugCatalogModal(true)
  }

  const openEditDrug = (drug) => {
    setEditingDrug(drug)
    setDrugForm({
      code:        drug.code,
      description: drug.description,
      genericName: drug.generic_name || '',
      strength:    drug.strength     || '',
      dosageForm:  drug.dosage_form  || '',
      category:    drug.category     || '',
      unit:        drug.unit,
      unitPrice:   String(drug.unit_price),
    })
    setShowDrugCatalogModal(true)
  }

  const handleSaveDrug = async (e) => {
    e.preventDefault()
    try {
      setDrugSubmitting(true)
      if (editingDrug) {
        await updateNhisDrug(editingDrug.id, drugForm)
        notify('Drug updated.', 'success')
      } else {
        await createNhisDrug(drugForm)
        notify('Drug added to catalog.', 'success')
      }
      setShowDrugCatalogModal(false)
      const fresh = await getAllNhisDrugs()
      setNhisDrugs(fresh)
    } catch (err) {
      notify(err.message || 'Unable to save drug.', 'error')
    } finally {
      setDrugSubmitting(false)
    }
  }

  const handleDeleteDrug = async (drug) => {
    if (!window.confirm(`Remove "${drug.description}" from the NHIS catalog?`)) return
    try {
      await deleteNhisDrug(drug.id)
      const fresh = await getAllNhisDrugs()
      setNhisDrugs(fresh)
      notify('Drug removed.', 'info')
    } catch (err) {
      notify(err.message || 'Unable to remove drug.', 'error')
    }
  }

  // ── import ────────────────────────────────────────────────────
  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const { rows, errors } = await parseNhisDrugFile(file)
      setImportRows(rows)
      setImportErrors(errors)
      setShowImportModal(true)
    } catch (err) {
      notify(err.message || 'Unable to parse file.', 'error')
    }
  }

  const handleConfirmImport = async () => {
    if (!importRows.length) return
    try {
      setImporting(true)
      const count = await upsertNhisDrugs(importRows)
      setShowImportModal(false)
      setImportRows([])
      setImportErrors([])
      const fresh = await getAllNhisDrugs()
      setNhisDrugs(fresh)
      notify(`${count} drugs imported/updated.`, 'success')
    } catch (err) {
      notify(err.message || 'Import failed.', 'error')
    } finally {
      setImporting(false)
    }
  }

  const handleDownloadTemplate = () => {
    const blob = generateNhisDrugTemplate()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'nhis-drug-template.xlsx'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // ── export ────────────────────────────────────────────────────
  const handleExport = async () => {
    try {
      setExporting(true)
      const count = await exportNhisMonthlyCSV(exportMonth)
      setShowExportModal(false)
      await loadAll()
      notify(`${count} claims exported for ${exportMonth}. Served claims marked as Submitted.`, 'success')
    } catch (err) {
      notify(err.message || 'Export failed.', 'error')
    } finally {
      setExporting(false)
    }
  }

  // ─────────────────────────────────────────────────────────────
  return (
    <div className="nhis-page">
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">NHIS</h1>
          <p className="page-subtitle">National Health Insurance Scheme claims and drug catalog</p>
        </div>
        <div className="header-actions">
          {pageTab === 'claims' && canWrite && (
            <>
              <button className="btn btn-secondary" onClick={() => setShowExportModal(true)}>
                <Download size={16} /> Monthly Export
              </button>
              <button className="btn btn-primary" onClick={() => setShowNewClaimModal(true)}>
                <Plus size={16} /> New Claim
              </button>
            </>
          )}
          {pageTab === 'catalog' && canWrite && (
            <>
              <button className="btn btn-secondary" onClick={handleDownloadTemplate}>
                <FileSpreadsheet size={16} /> Template
              </button>
              <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()}>
                <Upload size={16} /> Import CSV/Excel
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                style={{ display: 'none' }}
                onChange={handleFileSelect}
              />
              <button className="btn btn-primary" onClick={openAddDrug}>
                <Plus size={16} /> Add Drug
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="nhis-alert" role="alert">{error}</div>}

      {/* Page sub-tabs */}
      <div className="nhis-page-tabs">
        <button
          className={`nhis-page-tab ${pageTab === 'claims' ? 'active' : ''}`}
          onClick={() => setPageTab('claims')}
        >
          <HeartPulse size={16} /> Claims
        </button>
        <button
          className={`nhis-page-tab ${pageTab === 'catalog' ? 'active' : ''}`}
          onClick={() => setPageTab('catalog')}
        >
          <FileSpreadsheet size={16} /> Drug Catalog
        </button>
      </div>

      {/* ── CLAIMS TAB ────────────────────────────────────────────── */}
      {pageTab === 'claims' && (
        <>
          {/* Stats */}
          <div className="nhis-stats">
            <div className="stat-box">
              <span className="stat-label">Total Claims</span>
              <span className="stat-value">{stats.total}</span>
            </div>
            <div className="stat-box pending">
              <span className="stat-label">Served (pending)</span>
              <span className="stat-value">{stats.served}</span>
            </div>
            <div className="stat-box">
              <span className="stat-label">Submitted</span>
              <span className="stat-value">{stats.submitted}</span>
            </div>
            <div className="stat-box approved">
              <span className="stat-label">Paid</span>
              <span className="stat-value">{stats.paid}</span>
            </div>
            <div className="stat-box rejected">
              <span className="stat-label">Rejected</span>
              <span className="stat-value">{stats.rejected}</span>
            </div>
          </div>

          {/* Claim status tabs + search */}
          <div className="nhis-controls">
            <div className="nhis-tabs">
              {CLAIM_STATUS_TABS.map((tab) => (
                <button
                  key={tab}
                  className={`tab-btn ${claimTab === tab ? 'active' : ''}`}
                  onClick={() => setStatusTab(tab)}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  {tab !== 'all' && stats[tab] > 0 && (
                    <span className="tab-count">{stats[tab]}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="search-box">
              <Search size={16} className="search-icon" />
              <input
                className="search-input"
                placeholder="Search by name, member no, claim #..."
                value={claimSearch}
                onChange={(e) => setClaimSearch(e.target.value)}
              />
            </div>
          </div>

          {/* Claims table */}
          <div className="nhis-table-wrap">
            {loading ? (
              <div className="nhis-empty">Loading claims...</div>
            ) : filteredClaims.length === 0 ? (
              <div className="nhis-empty">
                <HeartPulse size={40} />
                <p>No claims found.</p>
                {canWrite && (
                  <button className="btn btn-primary" onClick={() => setShowNewClaimModal(true)}>
                    <Plus size={16} /> New Claim
                  </button>
                )}
              </div>
            ) : (
              <table className="nhis-table">
                <thead>
                  <tr>
                    <th>Claim #</th>
                    <th>Patient</th>
                    <th>Member No / HIN</th>
                    <th>Service Date</th>
                    <th>Medicines</th>
                    <th>Total</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredClaims.map((c) => (
                    <tr key={c.id}>
                      <td className="claim-number">{c.claim_number}</td>
                      <td>
                        <div className="patient-name">{c.surname} {c.other_names || ''}</div>
                        {c.folder_no && <div className="patient-meta">Folder: {c.folder_no}</div>}
                      </td>
                      <td>
                        {c.member_no && <div>{c.member_no}</div>}
                        {c.hin       && <div className="patient-meta">HIN: {c.hin}</div>}
                      </td>
                      <td>{c.service_date_from ? formatAppDate(c.service_date_from) : '—'}</td>
                      <td>{c.nhis_claim_medicines?.length || 0}</td>
                      <td>{fmtCurrency(c.total_amount)}</td>
                      <td><StatusBadge status={c.status} /></td>
                      <td className="nhis-actions">
                        <button
                          className="action-btn action-btn--view"
                          title="View"
                          onClick={() => setViewClaim(c)}
                        >
                          <Eye size={14} />
                        </button>
                        {c.status === 'served' && canWrite && (
                          <button
                            className="action-btn action-btn--submit"
                            title="Mark as Submitted"
                            disabled={updatingStatus === c.id}
                            onClick={() => handleStatusUpdate(c, 'submitted')}
                          >
                            <Send size={14} />
                          </button>
                        )}
                        {c.status === 'submitted' && canWrite && (
                          <>
                            <button
                              className="action-btn action-btn--complete"
                              title="Mark as Paid"
                              disabled={updatingStatus === c.id}
                              onClick={() => handleStatusUpdate(c, 'paid')}
                            >
                              <Banknote size={14} />
                            </button>
                            <button
                              className="action-btn action-btn--cancel"
                              title="Reject"
                              disabled={updatingStatus === c.id}
                              onClick={() => { setRejectTarget(c); setRejectReason('') }}
                            >
                              <XCircle size={14} />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ── CATALOG TAB ───────────────────────────────────────────── */}
      {pageTab === 'catalog' && (
        <>
          <div className="nhis-controls">
            <div className="search-box">
              <Search size={16} className="search-icon" />
              <input
                className="search-input"
                placeholder="Search by code, description, generic name..."
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
              />
            </div>
            <span className="catalog-count">{filteredCatalog.length} drugs</span>
          </div>

          <div className="nhis-table-wrap">
            {loading ? (
              <div className="nhis-empty">Loading catalog...</div>
            ) : filteredCatalog.length === 0 ? (
              <div className="nhis-empty">
                <FileSpreadsheet size={40} />
                <p>No drugs in catalog yet. Import a CSV/Excel file or add manually.</p>
              </div>
            ) : (
              <table className="nhis-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Description</th>
                    <th>Generic Name</th>
                    <th>Strength</th>
                    <th>Category</th>
                    <th>Unit</th>
                    <th>Unit Price</th>
                    {canWrite && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredCatalog.map((d) => (
                    <tr key={d.id}>
                      <td className="drug-code-cell">{d.code}</td>
                      <td>{d.description}</td>
                      <td>{d.generic_name || '—'}</td>
                      <td>{d.strength     || '—'}</td>
                      <td>{d.category     || '—'}</td>
                      <td>{d.unit}</td>
                      <td>{fmtCurrency(d.unit_price)}</td>
                      {canWrite && (
                        <td className="nhis-actions">
                          <button className="action-btn action-btn--view" onClick={() => openEditDrug(d)} title="Edit">
                            <Eye size={14} />
                          </button>
                          <button className="action-btn action-btn--cancel" onClick={() => handleDeleteDrug(d)} title="Remove">
                            <XCircle size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════
          NEW CLAIM MODAL
      ══════════════════════════════════════════════════════════════ */}
      {showNewClaimModal && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && (setShowNewClaimModal(false), resetClaimModal())}>
          <div className="modal-panel modal-panel--nhis-claim">
            <div className="modal-header">
              <h2>Add New NHIS Claim</h2>
              <button className="modal-close" onClick={() => { setShowNewClaimModal(false); resetClaimModal() }}><X size={18} /></button>
            </div>

            {claimError && <div className="nhis-alert nhis-alert--modal" role="alert">{claimError}</div>}

            <div className="nhis-claim-body">
              {/* Left column */}
              <div className="nhis-claim-left">

                {/* Patient search */}
                <section className="nhis-section">
                  <h3 className="nhis-section-title">Member Details</h3>
                  <div className="form-group">
                    <label>Search existing patient (by name / member no)</label>
                    <div className="patient-search-wrap">
                      <input
                        className="form-input"
                        placeholder="Type to search patients..."
                        value={patientSearch}
                        onChange={(e) => setPatientSearch(e.target.value)}
                      />
                      {filteredPatients.length > 0 && (
                        <div className="patient-dropdown">
                          {filteredPatients.map((p) => (
                            <button
                              key={p.id}
                              className="patient-dropdown-item"
                              onClick={() => selectPatient(p)}
                            >
                              <span className="pd-name">{p.full_name}</span>
                              {p.nhis_member_no && <span className="pd-meta">Member: {p.nhis_member_no}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label>Member No / HIN</label>
                      <input className="form-input" value={claimForm.memberNo}
                        onChange={(e) => setClaimForm((p) => ({ ...p, memberNo: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>HIN</label>
                      <input className="form-input" value={claimForm.hin}
                        onChange={(e) => setClaimForm((p) => ({ ...p, hin: e.target.value }))} />
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label>Surname *</label>
                      <input className="form-input" value={claimForm.surname}
                        onChange={(e) => setClaimForm((p) => ({ ...p, surname: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>Other Names</label>
                      <input className="form-input" value={claimForm.otherNames}
                        onChange={(e) => setClaimForm((p) => ({ ...p, otherNames: e.target.value }))} />
                    </div>
                  </div>

                  <div className="form-row form-row--3">
                    <div className="form-group">
                      <label>Folder No</label>
                      <input className="form-input" value={claimForm.folderNo}
                        onChange={(e) => setClaimForm((p) => ({ ...p, folderNo: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>Gender</label>
                      <select className="form-input" value={claimForm.gender}
                        onChange={(e) => setClaimForm((p) => ({ ...p, gender: e.target.value }))}>
                        <option value="">—</option>
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Date of Birth</label>
                      <input type="date" className="form-input" value={claimForm.dateOfBirth}
                        onChange={(e) => setClaimForm((p) => ({ ...p, dateOfBirth: e.target.value }))} />
                    </div>
                  </div>

                  <div className="form-group">
                    <label>CCC No</label>
                    <input className="form-input" value={claimForm.cccNo}
                      onChange={(e) => setClaimForm((p) => ({ ...p, cccNo: e.target.value }))} />
                  </div>
                </section>

                {/* Dates of service */}
                <section className="nhis-section">
                  <h3 className="nhis-section-title">Dates of Service</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label>From</label>
                      <input type="date" className="form-input" value={claimForm.serviceDateFrom}
                        onChange={(e) => setClaimForm((p) => ({ ...p, serviceDateFrom: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>To</label>
                      <input type="date" className="form-input" value={claimForm.serviceDateTo}
                        onChange={(e) => setClaimForm((p) => ({ ...p, serviceDateTo: e.target.value }))} />
                    </div>
                  </div>
                </section>

                {/* Referral */}
                <section className="nhis-section">
                  <h3 className="nhis-section-title">Referral Info</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Referring Facility Name</label>
                      <input className="form-input" value={claimForm.referringFacility}
                        onChange={(e) => setClaimForm((p) => ({ ...p, referringFacility: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>Referral Code / CCC</label>
                      <input className="form-input" value={claimForm.referralCode}
                        onChange={(e) => setClaimForm((p) => ({ ...p, referralCode: e.target.value }))} />
                    </div>
                  </div>
                </section>

                {/* Authorization */}
                <section className="nhis-section">
                  <h3 className="nhis-section-title">Authorization Codes</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Physician Name / ID</label>
                      <input className="form-input" value={claimForm.physicianName}
                        onChange={(e) => setClaimForm((p) => ({ ...p, physicianName: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>Pre-authorization Code(s)</label>
                      <input className="form-input" value={claimForm.preAuthCodes}
                        onChange={(e) => setClaimForm((p) => ({ ...p, preAuthCodes: e.target.value }))} />
                    </div>
                  </div>
                </section>
              </div>

              {/* Right column — medicines */}
              <div className="nhis-claim-right">
                <div className="nhis-medicines-header">
                  <h3 className="nhis-section-title">Medicines</h3>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => setShowMedModal(true)}
                  >
                    <Plus size={14} /> Add Medicine
                  </button>
                </div>

                {claimMedicines.length === 0 ? (
                  <div className="no-medicines">No medicines added.</div>
                ) : (
                  <div className="medicines-list">
                    {claimMedicines.map((m, idx) => (
                      <div key={idx} className="medicine-card">
                        <div className="medicine-card-main">
                          <div className="medicine-code">{m.drugCode}</div>
                          <div className="medicine-desc">{m.description}</div>
                          <div className="medicine-meta">
                            {m.dispensedQty} × {m.unit} @ {fmtCurrency(m.unitPrice)}
                            {m.dose && ` | Dose: ${m.dose}`}
                            {m.frequency && ` | ${m.frequency}`}
                            {m.duration && ` for ${m.duration}`}
                          </div>
                        </div>
                        <div className="medicine-card-right">
                          <div className="medicine-total">{fmtCurrency(m.totalAmount)}</div>
                          <button className="action-btn action-btn--cancel" onClick={() => removeMedicine(idx)}>
                            <X size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="medicines-total">
                  <strong>Total:</strong> {fmtCurrency(claimTotal)}
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setShowNewClaimModal(false); resetClaimModal() }}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={claimSubmitting}
                onClick={handleSubmitClaim}
              >
                {claimSubmitting ? 'Saving...' : 'Save Claim'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          NEW MEDICINE SUB-MODAL
      ══════════════════════════════════════════════════════════════ */}
      {showMedModal && (
        <div className="modal-overlay modal-overlay--top" onClick={(e) => e.target === e.currentTarget && setShowMedModal(false)}>
          <div className="modal-panel modal-panel--medicine">
            <div className="modal-header">
              <h2>New Medicine</h2>
              <button className="modal-close" onClick={() => setShowMedModal(false)}><X size={18} /></button>
            </div>

            <div className="medicine-modal-body">
              {/* Code search */}
              <div className="form-group">
                <label>Code</label>
                <div className="med-code-row">
                  <div className="drug-search-wrap" style={{ flex: 1 }}>
                    <input
                      className="form-input"
                      placeholder="e.g. TAMSULCA1"
                      value={medCodeSearch || medForm.drugCode}
                      onChange={(e) => {
                        setMedCodeSearch(e.target.value)
                        setMedForm((p) => ({ ...p, drugCode: e.target.value.toUpperCase(), nhisDrugId: '' }))
                      }}
                    />
                    {medSearchResults.length > 0 && (
                      <div className="drug-dropdown">
                        {medSearchResults.map((d) => (
                          <button key={d.id} className="drug-dropdown-item" onClick={() => selectMedFromDropdown(d)}>
                            <span className="drug-name">{d.code}</span>
                            <span className="drug-meta">{d.description}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={medSearching}
                    onClick={handleDrugCodeSearch}
                  >
                    <Search size={14} />
                  </button>
                </div>
              </div>

              {/* Description / price (auto-filled) */}
              <div className="form-group">
                <label>Description</label>
                <input
                  className="form-input"
                  value={medForm.description}
                  onChange={(e) => setMedForm((p) => ({ ...p, description: e.target.value }))}
                />
                {medForm.unitPrice && (
                  <span className="unit-price-hint">Unit Price: {fmtCurrency(medForm.unitPrice)}</span>
                )}
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Dispensed Qty / Unit *</label>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    className="form-input"
                    value={medForm.dispensedQty}
                    onChange={(e) => setMedForm((p) => ({ ...p, dispensedQty: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label>Unit</label>
                  <input
                    className="form-input"
                    value={medForm.unit}
                    onChange={(e) => setMedForm((p) => ({ ...p, unit: e.target.value }))}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Dispensary Date</label>
                <input
                  type="date"
                  className="form-input"
                  value={medForm.dispensaryDate}
                  onChange={(e) => setMedForm((p) => ({ ...p, dispensaryDate: e.target.value }))}
                />
              </div>

              <div className="nhis-section-divider">Prescription</div>

              <div className="form-row form-row--3">
                <div className="form-group">
                  <label>Dose</label>
                  <input
                    className="form-input"
                    placeholder="e.g. 1 tablet"
                    value={medForm.dose}
                    onChange={(e) => setMedForm((p) => ({ ...p, dose: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label>Frequency</label>
                  <input
                    className="form-input"
                    placeholder="e.g. TDS"
                    value={medForm.frequency}
                    onChange={(e) => setMedForm((p) => ({ ...p, frequency: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label>Duration</label>
                  <input
                    className="form-input"
                    placeholder="e.g. 7 days"
                    value={medForm.duration}
                    onChange={(e) => setMedForm((p) => ({ ...p, duration: e.target.value }))}
                  />
                </div>
              </div>

              {medForm.unitPrice && medForm.dispensedQty && (
                <div className="med-line-total">
                  Line Total: <strong>{fmtCurrency(Number(medForm.unitPrice) * Number(medForm.dispensedQty))}</strong>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setMedForm(BLANK_MEDICINE); setMedCodeSearch('') }}>Clear</button>
              <button className="btn btn-primary" onClick={addMedicineToList}>+ Add</button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          VIEW CLAIM MODAL
      ══════════════════════════════════════════════════════════════ */}
      {viewClaim && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setViewClaim(null)}>
          <div className="modal-panel modal-panel--view-claim">
            <div className="modal-header">
              <h2>{viewClaim.claim_number} <StatusBadge status={viewClaim.status} /></h2>
              <button className="modal-close" onClick={() => setViewClaim(null)}><X size={18} /></button>
            </div>
            <div className="view-claim-grid">
              <div><strong>Patient:</strong> {viewClaim.surname} {viewClaim.other_names || ''}</div>
              <div><strong>Member No:</strong> {viewClaim.member_no || '—'}</div>
              <div><strong>HIN:</strong> {viewClaim.hin || '—'}</div>
              <div><strong>Folder No:</strong> {viewClaim.folder_no || '—'}</div>
              <div><strong>Gender:</strong> {viewClaim.gender || '—'}</div>
              <div><strong>DOB:</strong> {viewClaim.date_of_birth ? formatAppDate(viewClaim.date_of_birth) : '—'}</div>
              <div><strong>CCC No:</strong> {viewClaim.ccc_no || '—'}</div>
              <div><strong>Service Dates:</strong> {viewClaim.service_date_from ? `${formatAppDate(viewClaim.service_date_from)} – ${formatAppDate(viewClaim.service_date_to)}` : '—'}</div>
              <div><strong>Referring Facility:</strong> {viewClaim.referring_facility || '—'}</div>
              <div><strong>Referral Code:</strong> {viewClaim.referral_code || '—'}</div>
              <div><strong>Physician:</strong> {viewClaim.physician_name || '—'}</div>
              <div><strong>Pre-auth Codes:</strong> {viewClaim.pre_auth_codes || '—'}</div>
            </div>
            <table className="nhis-table" style={{ marginTop: '1rem' }}>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Description</th>
                  <th>Qty</th>
                  <th>Unit</th>
                  <th>Unit Price</th>
                  <th>Total</th>
                  <th>Dose</th>
                  <th>Frequency</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {(viewClaim.nhis_claim_medicines || []).map((m) => (
                  <tr key={m.id}>
                    <td className="drug-code-cell">{m.drug_code || '—'}</td>
                    <td>{m.description}</td>
                    <td>{m.dispensed_qty}</td>
                    <td>{m.unit}</td>
                    <td>{fmtCurrency(m.unit_price)}</td>
                    <td>{fmtCurrency(m.total_amount)}</td>
                    <td>{m.dose || '—'}</td>
                    <td>{m.frequency || '—'}</td>
                    <td>{m.duration || '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} className="total-label">Claim Total</td>
                  <td colSpan={4} className="total-value">{fmtCurrency(viewClaim.total_amount)}</td>
                </tr>
              </tfoot>
            </table>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setViewClaim(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          ADD / EDIT DRUG MODAL
      ══════════════════════════════════════════════════════════════ */}
      {showDrugCatalogModal && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowDrugCatalogModal(false)}>
          <div className="modal-panel modal-panel--drug">
            <div className="modal-header">
              <h2>{editingDrug ? 'Edit Drug' : 'Add NHIS Drug'}</h2>
              <button className="modal-close" onClick={() => setShowDrugCatalogModal(false)}><X size={18} /></button>
            </div>
            <form className="drug-form" onSubmit={handleSaveDrug}>
              <div className="form-row">
                <div className="form-group">
                  <label>Code *</label>
                  <input className="form-input" required value={drugForm.code}
                    onChange={(e) => setDrugForm((p) => ({ ...p, code: e.target.value.toUpperCase() }))}
                    readOnly={!!editingDrug}
                  />
                </div>
                <div className="form-group">
                  <label>Unit *</label>
                  <input className="form-input" required value={drugForm.unit}
                    onChange={(e) => setDrugForm((p) => ({ ...p, unit: e.target.value }))} />
                </div>
              </div>
              <div className="form-group">
                <label>Description *</label>
                <input className="form-input" required value={drugForm.description}
                  onChange={(e) => setDrugForm((p) => ({ ...p, description: e.target.value }))} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Generic Name</label>
                  <input className="form-input" value={drugForm.genericName}
                    onChange={(e) => setDrugForm((p) => ({ ...p, genericName: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Strength</label>
                  <input className="form-input" value={drugForm.strength}
                    onChange={(e) => setDrugForm((p) => ({ ...p, strength: e.target.value }))} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Dosage Form</label>
                  <input className="form-input" value={drugForm.dosageForm}
                    onChange={(e) => setDrugForm((p) => ({ ...p, dosageForm: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Category</label>
                  <input className="form-input" value={drugForm.category}
                    onChange={(e) => setDrugForm((p) => ({ ...p, category: e.target.value }))} />
                </div>
              </div>
              <div className="form-group">
                <label>Unit Price (GHS) *</label>
                <input type="number" min="0" step="0.01" className="form-input" required
                  value={drugForm.unitPrice}
                  onChange={(e) => setDrugForm((p) => ({ ...p, unitPrice: e.target.value }))} />
              </div>
              <div className="modal-footer" style={{ padding: '0', marginTop: '1rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowDrugCatalogModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={drugSubmitting}>
                  {drugSubmitting ? 'Saving...' : editingDrug ? 'Update Drug' : 'Add Drug'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          IMPORT PREVIEW MODAL
      ══════════════════════════════════════════════════════════════ */}
      {showImportModal && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowImportModal(false)}>
          <div className="modal-panel modal-panel--import">
            <div className="modal-header">
              <h2>Import Preview — {importRows.length} drugs</h2>
              <button className="modal-close" onClick={() => setShowImportModal(false)}><X size={18} /></button>
            </div>
            {importErrors.length > 0 && (
              <div className="nhis-alert">
                {importErrors.slice(0, 5).map((e, i) => <div key={i}>{e}</div>)}
                {importErrors.length > 5 && <div>...and {importErrors.length - 5} more warnings</div>}
              </div>
            )}
            <div className="import-table-wrap">
              <table className="nhis-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Description</th>
                    <th>Generic</th>
                    <th>Strength</th>
                    <th>Unit</th>
                    <th>Price</th>
                  </tr>
                </thead>
                <tbody>
                  {importRows.slice(0, 50).map((r, i) => (
                    <tr key={i}>
                      <td className="drug-code-cell">{r.code}</td>
                      <td>{r.description}</td>
                      <td>{r.generic_name || '—'}</td>
                      <td>{r.strength     || '—'}</td>
                      <td>{r.unit}</td>
                      <td>{fmtCurrency(r.unit_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {importRows.length > 50 && (
                <div className="import-more">...and {importRows.length - 50} more rows</div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowImportModal(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={importing || !importRows.length} onClick={handleConfirmImport}>
                {importing ? 'Importing...' : `Import ${importRows.length} Drugs`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          MONTHLY EXPORT MODAL
      ══════════════════════════════════════════════════════════════ */}
      {showExportModal && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowExportModal(false)}>
          <div className="modal-panel modal-panel--export">
            <div className="modal-header">
              <h2>Monthly Batch Export</h2>
              <button className="modal-close" onClick={() => setShowExportModal(false)}><X size={18} /></button>
            </div>
            <div className="export-body">
              <p className="export-info">
                Exports all claims for the selected month as a CSV file ready for NHIA submission.
                All <strong>Served</strong> claims in that month will be automatically marked as <strong>Submitted</strong>.
              </p>
              <div className="form-group">
                <label>Select Month</label>
                <input
                  type="month"
                  className="form-input"
                  value={exportMonth}
                  onChange={(e) => setExportMonth(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowExportModal(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={exporting} onClick={handleExport}>
                {exporting ? 'Exporting...' : <><Download size={14} /> Export &amp; Download</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          REJECT MODAL
      ══════════════════════════════════════════════════════════════ */}
      {rejectTarget && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setRejectTarget(null)}>
          <div className="modal-panel modal-panel--export">
            <div className="modal-header">
              <h2>Reject Claim {rejectTarget.claim_number}</h2>
              <button className="modal-close" onClick={() => setRejectTarget(null)}><X size={18} /></button>
            </div>
            <div className="export-body">
              <div className="form-group">
                <label>Rejection Reason *</label>
                <textarea
                  className="form-input"
                  rows={3}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Enter the reason for rejection..."
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setRejectTarget(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                disabled={!rejectReason.trim() || updatingStatus === rejectTarget?.id}
                onClick={handleRejectConfirm}
              >
                Reject Claim
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Nhis
