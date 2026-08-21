import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus, Search, X, Upload, Download, CheckCircle2,
  Send, Banknote, XCircle, Eye, FileSpreadsheet, HeartPulse,
  Pencil, Paperclip, FileText, Trash2, Users, Clock, Stethoscope, Building2,
  AlertTriangle,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { isSupabaseConfigured } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import { formatAppDate, formatAppDateTime } from '../utils/date'
import {
  formatNhisDateOfBirthInput,
  normalizeNhisDateOfBirth,
} from '../utils/nhisDateOfBirth'
import {
  canSaveNhisIncompleteIntake,
  getNhisIntakeSaveStatus,
  getNhisIncompleteIntakeItems,
  getNhisPrescriptionAttachmentReview,
  hasNhisPrescriptionAttachment,
  hasVerifiedNhisPrescription,
} from '../utils/nhisIntakeWorkflow'
import {
  canCorrectNhisClaimStatus,
  canPrivilegedCorrectNhisClaim,
} from '../utils/nhisPrivilegedCorrection'
import { normalizeText } from '../utils/validation'
import {
  getAllNhisDrugs,
  getApplicableNhiaTariffItems,
  isNhiaTariffItemAllowedForProviderClass,
  getNhisDrugByCode,
  createNhisDrug,
  updateNhisDrug,
  deleteNhisDrug,
  upsertNhisDrugs,
  getNhisClaimsPage,
  getNhisClaimForSubmission,
  getAllNhiaTariffItems,
  updateNhiaTariffItem,
  getNhisClaimStats,
  getNhisClaimIssueCounts,
  checkNhisActiveMedicationOverlap,
  getNhisPatientActiveMedications,
  createNhisClaim,
  deleteNhisClaim,
  serveNhisClaimDirect,
  updateNhisClaim,
  getNhisClaimCorrectionHistory,
  updateNhisClaimStatus,
  exportNhisClaimsFile,
  checkNhisExportReadiness,
  prepareNhisClaimsExport,
  prepareNhisSingleClaimExport,
  buildNhisDurationRepairReview,
  normalizeNhisManualDurationCorrection,
  applyNhisDurationRepairs,
  submitNhisClaimDirect,
  assessNhisClaimReadiness,
  validateNhisClaimFinalReadiness,
  HOSPITAL_ENCOUNTER_OUTCOME_OPTIONS,
  HOSPITAL_NO_MEDICINE_REASON_OPTIONS,
  HOSPITAL_NO_LAB_REASON_OPTIONS,
  HOSPITAL_NO_PROCEDURE_REASON_OPTIONS,
  getAllNhisClinicalRules,
  upsertNhisClinicalRules,
  normalizeOrganizationType,
  normalizeNhisCcCode,
  normalizeNhisGender,
  uploadNhisPrescriptionPdf,
  validateNhisPrescriptionPdfFile,
  validateNhisMedicineDurationInput,
  getNhisPrescriptionSignedUrl,
  generateHostedNhiaCcCode,
  getNhiaApiSettings,
  isNhisDuplicateClaimsError,
  isNhisReadinessClaimsError,
  startClaimItBridgeQueueAutoSync,
} from '../services/nhisService'
import {
  generateNhiaCcCode as generateBranchNhiaCcCode,
  getNhiaLookupCardType,
  lookupNhiaMember as branchLookupNhiaMember,
  reopenBranchMcaEditWindow,
  shouldUseBranchServer,
} from '../services/branchServerApi'
import { isMcaEditWindowOpen, canReopenMcaEditWindow } from '../utils/mcaEditWindow'
import {
  canCorrectDirectServedNhisMedicine,
  canNhisClaimBeServedDirectly,
  canMcaOpenNhisClaimForServing,
  isNhisClaimDirectlyServed,
  markNhisMedicinesServedDirectly,
  markNhisMedicineFullyServed,
  shouldApplyMcaEditWindowToClaim,
  shouldFinalizeNhisServingReview,
  splitMcaReadinessIssues,
} from '../utils/nhisServingWorkflow'
import { getAllPatients, searchPatients } from '../services/patientService'
import {
  NHIS_PRESCRIBER_TYPES,
  NHIS_PRESCRIBING_FACILITY_TYPES,
  buildNhisPrescriptionSourceSnapshot,
  createNhisPrescriber,
  createNhisPrescribingFacility,
  deactivateNhisPrescriber,
  deactivateNhisPrescribingFacility,
  getNhisPrescriberDisplayName,
  getNhisPrescribingFacilityDisplayName,
  listNhisPrescribers,
  listNhisPrescribingFacilities,
} from '../services/nhisPrescribingRecordsService'
import { getAllDrugs } from '../services/drugService'
import { parseNhisDrugFile, generateNhisDrugTemplate } from '../services/nhisDrugImportService'
import { parseNhisClinicalRuleFile, generateNhisClinicalRuleTemplate } from '../services/nhisClinicalRuleImportService'
import { isGhanaCardNumber, normalizeNhiaMemberNumber } from '../utils/nhiaMemberNumber'
import {
  applyNhiaFacilityDefaults,
  getNhiaAccreditationDateGenerated,
  getNhiaAccreditationExpiryDate,
  hasNhiaFacilitySettings,
} from '../utils/nhiaFacilityDefaults'
import { getErrorMessage, isNetworkRequestError } from '../utils/requestErrors'
import { getNhiaMemberFeedbackMessage } from '../utils/nhiaFeedback'
import { logPerformance } from '../utils/performance'
// ✅ NHIS PHARMACY LEVEL PATCH START
import {
  PHARMACY_LEVELS,
  MEDICINE_ACCESS_LEVELS,
  assessMedicinePharmacyLevel,
  getEffectivePharmacyLevel,
} from '../utils/nhisPharmacyLevel'
// ✅ NHIS PHARMACY LEVEL PATCH END
import { DEFAULT_NHIS_DRUG_CATALOG } from '../data/nhisDefaultDrugCatalog'
import { getPharmacySettings } from '../services/settingsService'
import { tryLogAuditEvent } from '../services/auditService'
import {
  NHIS_RETURN_ALERT_REASONS,
  canContinueNhisReturnAlert,
  findNhisPatientReturnAlert,
  normalizeNhisReturnAlertSettings,
} from '../utils/nhisReturnAlert'
import DiagnosisSelector from '../components/DiagnosisSelector/DiagnosisSelector'
import './Nhis.css'

// ─── constants ────────────────────────────────────────────────────────────────

const CLAIM_STATUS_TABS = ['all', 'draft', 'pending_serving', 'returned_for_review', 'served', 'submitted', 'paid', 'rejected']
const NHIS_CLAIMS_DEFAULT_PAGE_SIZE = 100
const NHIS_CLAIMS_PAGE_SIZE_OPTIONS = [50, 100, 200]
const NHIS_CLAIMS_PAGE_CACHE_MS = 60000
const NHIS_CLAIMS_SEARCH_DEBOUNCE_MS = 400
const NHIS_CLAIM_ISSUE_BADGE_SCAN_LIMIT = 3000
const READINESS_FILTERS = [
  { id: 'all', label: 'All issues' },
  { id: 'not_included', label: 'Not included in CXF' },
  { id: 'status', label: 'Not yet served/submitted' },
  { id: 'attachment', label: 'Attachment problems' },
  { id: 'identifier', label: 'Member/HIN' },
  { id: 'verification', label: 'Unverified prescription' },
  { id: 'prescriber', label: 'Prescriber' },
  { id: 'diagnosis', label: 'Diagnosis' },
  { id: 'clinical', label: 'Clinical rules' },
  { id: 'tariff', label: 'Tariff/G-DRG' },
  { id: 'medicine', label: 'Medicine' },
  { id: 'other', label: 'Other' },
]
const getScrubIssueAuditSummary = (issues = []) => ({
  total: issues.length,
  claim_numbers: issues.slice(0, 20).map((issue) => issue.claim_number || issue.claimNumber || issue.id || 'Unnumbered'),
  issue_count: issues.reduce((count, issue) => count + (Array.isArray(issue.issues) ? issue.issues.length : 1), 0),
})

const getDuplicateScrubAuditSummary = (groups = []) => ({
  total_groups: groups.length,
  total_claims: groups.reduce((count, group) => count + (Array.isArray(group.claims) ? group.claims.length : 0), 0),
  examples: groups.slice(0, 10).map((group) => ({
    patient: group.patientName || '',
    member: group.member || '',
    service_date: group.serviceDate || '',
    claims: (group.claims || []).slice(0, 6).map((claim) => claim.claim_number || claim.id || 'Unnumbered'),
  })),
})
const isValidPrescribingFacilityRecord = (facility) =>
  Boolean(facility && facility.id && getNhisPrescribingFacilityDisplayName(facility))
const isValidPrescriberRecord = (prescriber) =>
  Boolean(prescriber && prescriber.id && getNhisPrescriberDisplayName(prescriber))
const CLAIM_ISSUE_FILTERS = [
  { id: 'all', label: 'All claims' },
  { id: 'any', label: 'All issues' },
  { id: 'missing-attachment', label: 'Missing attachment' },
  { id: 'attachment-type', label: 'Set attachment type' },
  { id: 'unverified-prescription', label: 'Unverified prescription' },
  { id: 'incomplete-intake', label: 'Incomplete intake' },
]
const CLAIM_STATUS_LABELS = {
  all: 'All',
  draft: 'Saved Details',
  pending_serving: 'Pending Serving',
  serving_in_progress: 'Serving',
  returned_for_review: 'For Review',
  served: 'Claim Ready',
  submitted: 'Submitted',
  paid: 'Paid',
  rejected: 'Rejected',
}

const useDebouncedValue = (value, delayMs) => {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])

  return debouncedValue
}
const MEDICINE_SERVING_STATUSES = [
  { value: 'fully_served', label: 'Fully Served' },
  { value: 'partially_served', label: 'Partially Served' },
  { value: 'not_available', label: 'Not Available' },
  { value: 'not_served', label: 'Not Served' },
]
const MEDICINE_NOT_FULLY_SERVED_REASONS = [
  'Out of stock',
  'Insufficient stock',
  'Patient refused',
  'Medicine changed',
  'Entered by mistake',
  'Other',
]
const isLocalClaimItBridgeBaseUrl = (baseUrl = '') => {
  try {
    const hostname = new URL(String(baseUrl || '').trim()).hostname.toLowerCase()
    return hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  } catch {
    return false
  }
}

const isLocalAppOrigin = () => {
  if (typeof window === 'undefined') return false
  const hostname = window.location.hostname.toLowerCase()
  return hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
}

const getNhisCalendarDate = (value = new Date()) => {
  const raw = String(value || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Accra',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const part = (type) => parts.find((item) => item.type === type)?.value || ''
    return [part('year'), part('month'), part('day')].filter(Boolean).join('-')
  } catch {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
}

const FREQUENCY_OPTIONS = [
  'OD',
  'BD',
  'BID',
  'TDS',
  'TID',
  'QID',
  'QD',
  'STAT',
  'PRN',
  ...Array.from({ length: 12 }, (_, index) => `${index + 1} hourly`),
]
const DURATION_OPTIONS = [
  ...Array.from({ length: 14 }, (_, index) => `${index + 1} day${index === 0 ? '' : 's'}`),
  '21 days',
  '28 days',
  '30 days',
  '42 days',
  '45 days',
  '56 days',
  '60 days',
  '84 days',
  '90 days',
  '120 days',
  '180 days',
  '365 days',
]

const CompactSuggestionInput = ({
  value,
  onValueChange,
  options,
  placeholder,
  disabled = false,
  required = false,
  onBlur,
  placement = 'bottom',
  ariaLabel,
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const normalizedOptions = useMemo(() => {
    const seen = new Set()
    return options
      .map((option) => (typeof option === 'string'
        ? { value: option, label: option, description: '' }
        : {
            value: String(option.value || ''),
            label: String(option.label || option.value || ''),
            description: String(option.description || ''),
          }))
      .filter((option) => {
        const key = option.value.trim().toLowerCase()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
  }, [options])
  const filteredOptions = useMemo(() => {
    const query = String(value || '').trim().toLowerCase()
    if (!query) return normalizedOptions
    return normalizedOptions.filter((option) => (
      option.label.toLowerCase().includes(query)
      || option.description.toLowerCase().includes(query)
    ))
  }, [normalizedOptions, value])

  const selectOption = (option) => {
    onValueChange(option.value)
    setIsOpen(false)
    setActiveIndex(-1)
  }

  return (
    <div className="nhis-compact-combobox">
      <input
        className="form-input"
        value={value}
        disabled={disabled}
        required={required}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={isOpen && filteredOptions.length > 0}
        onFocus={() => {
          setIsOpen(true)
          setActiveIndex(-1)
        }}
        onBlur={() => {
          setIsOpen(false)
          onBlur?.(value)
        }}
        onChange={(event) => {
          onValueChange(event.target.value)
          setIsOpen(true)
          setActiveIndex(-1)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setIsOpen(false)
            setActiveIndex(-1)
            return
          }
          if (!filteredOptions.length) return
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setIsOpen(true)
            setActiveIndex((current) => (current + 1) % filteredOptions.length)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setIsOpen(true)
            setActiveIndex((current) => (current <= 0 ? filteredOptions.length - 1 : current - 1))
          } else if (event.key === 'Enter' && isOpen && activeIndex >= 0) {
            event.preventDefault()
            selectOption(filteredOptions[activeIndex])
          }
        }}
      />
      {isOpen && filteredOptions.length > 0 && (
        <div
          className={`nhis-compact-suggestions nhis-compact-suggestions--${placement}`}
          role="listbox"
        >
          {filteredOptions.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`nhis-compact-suggestion${index === activeIndex ? ' is-active' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault()
                selectOption(option)
              }}
            >
              <span>{option.label}</span>
              {option.description && <small>{option.description}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const makeBlankClaim = () => ({
  patientId:         '',
  memberNo:          '',
  cardType:          '',
  hin:               '',
  surname:           '',
  otherNames:        '',
  folderNo:          '',
  gender:            '',
  dateOfBirth:       '',
  patientAddress:    '',
  childWeightKg:     '',
  cccNo:             '',
  authId:            '',
  authType:          'NHIS',
  newCcc:            '',
  otacCode:          '',
  attendanceVerificationStatus: '',
  attendanceVerificationSource: 'nehfams_manual',
  nhiaTransactionId: '',
  nhiaEligibilityStartDate: '',
  nhiaEligibilityEndDate: '',
  nhiaAttendanceDate: '',
  nhiaMemberStatus: '',
  nhiaMemberLookupPayload: null,
  diagnosis:         '',
  diagnosisDetails:  [],
  serviceDate:       getNhisCalendarDate(),
  referringFacility: '',
  referralCode:      '',
  physicianName:     '',
  preAuthCodes:      '',
  prescriptionFileUrl: '',
  prescriptionFilePath: '',
  prescriptionFileName: '',
  prescriptionFileType: '',
  prescriptionFileSize: '',
  prescriptionDocumentType: '',
  prescriptionVerified: false,
  prescriptionVerifiedBy: '',
  prescriptionVerifiedAt: '',
  prescriberId: '',
  prescribingFacilityId: '',
  prescriptionDate: '',
  prescriptionReference: '',
  prescriberNameSnapshot: '',
  prescriberLicenseSnapshot: '',
  prescribingFacilityNameSnapshot: '',
  prescribingFacilityCodeSnapshot: '',
  prescriptionEnteredBy: '',
  prescriptionEnteredAt: '',
  prescriptionUpdatedBy: '',
  prescriptionUpdatedAt: '',
  prescriptionEntryUserName: '',
  prescriptionUpdateUserName: '',
  claimitAttachmentFileName: '',
  claimitAttachmentFileType: '',
  claimitAttachmentMimeType: '',
  claimitAttachmentBase64: '',
  notes:             '',
  unservedMedicinesNote: '',
  encounterOutcome: '',
  noMedicineReason: '',
  noLabReason: '',
  noProcedureReason: '',
  externalPrescriptionStatus: '',
})

const BLANK_NHIS_PRESCRIBER = {
  fullName: '',
  title: '',
  professionalType: 'Doctor',
  licenseNumber: '',
  phone: '',
  email: '',
  primaryFacilityId: '',
  specialty: '',
  status: 'active',
  verificationStatus: 'unverified',
  notes: '',
}

const BLANK_NHIS_PRESCRIBING_FACILITY = {
  facilityName: '',
  facilityType: 'Clinic',
  nhiaFacilityCode: '',
  providerNumber: '',
  ownershipType: '',
  address: '',
  region: '',
  district: '',
  town: '',
  phone: '',
  email: '',
  contactPerson: '',
  status: 'active',
  verificationStatus: 'unverified',
  notes: '',
}

const makeBlankMedicine = () => ({
  nhisDrugId:    '',
  drugCode:      '',
  description:   '',
  genericName:   '',
  strength:      '',
  dosageForm:    '',
  unit:          'unit',
  unitPrice:     '',
  prescribedQty: '0',
  servedQty:     '0',
  dispensedQty:  '',
  servingStatus: 'pending',
  reasonIfNotFullyServed: '',
  enteredByClaimsOfficer: '',
  servedByMca: '',
  enteredAt: '',
  servedAt: '',
  dispensaryDate: getNhisCalendarDate(),
  dose:          '',
  frequency:     '',
  duration:      '',
  category:      '',
  // ✅ NHIS PHARMACY LEVEL PATCH START
  medicineAccessLevel: '',
  requiredPharmacyLevel: '',
  // ✅ NHIS PHARMACY LEVEL PATCH END
})

const makeBlankMedicineForDate = (dispensaryDate) => ({
  ...makeBlankMedicine(),
  dispensaryDate: dispensaryDate || getNhisCalendarDate(),
})

const BLANK_NHIS_DRUG = {
  code: '', description: '', genericName: '', strength: '',
  dosageForm: '', category: '', unit: 'unit', unitPrice: '',
  // ✅ NHIS PHARMACY LEVEL PATCH START
  medicineAccessLevel: '', requiredPharmacyLevel: '',
  // ✅ NHIS PHARMACY LEVEL PATCH END
}

const BLANK_NHIA_TARIFF = {
  tariffVersion: 'FEB 2023',
  facilityGroup: '',
  cateringOption: '',
  mdc: '',
  gdrgCode: '',
  description: '',
  ageBand: '',
  tariffAmount: '',
  currency: 'GHS',
  sourceFile: '',
  sourcePage: '',
}

const fmtCurrency = (n) =>
  `GHS ${Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const getClaimStatusLabel = (status = '') => CLAIM_STATUS_LABELS[String(status || '').toLowerCase()] || status || 'Draft'

const compactMedicines = (medicines = []) =>
  Array.isArray(medicines) ? medicines.filter((medicine) => medicine && typeof medicine === 'object') : []

const getMedicinePrescribedQty = (medicine = {}) => {
  medicine = medicine || {}
  return Number(medicine.prescribedQty ?? medicine.prescribed_qty ?? medicine.quantity ?? medicine.dispensedQty ?? medicine.dispensed_qty ?? 0) || 0
}

const getMedicineServedQty = (medicine = {}) => {
  medicine = medicine || {}
  return Number(medicine.servedQty ?? medicine.served_qty ?? medicine.dispensedQty ?? medicine.dispensed_qty ?? 0) || 0
}

const getMedicineUnitPrice = (medicine = {}) => {
  medicine = medicine || {}
  return Number(medicine.unitPrice ?? medicine.unit_price ?? 0) || 0
}

const getMedicinePrescribedAmount = (medicine = {}) =>
  getMedicineUnitPrice(medicine) * getMedicinePrescribedQty(medicine)

const getMedicineServedAmount = (medicine = {}) =>
  getMedicineUnitPrice(medicine) * getMedicineServedQty(medicine)

const normalizeMedicineServingStatus = (value, prescribedQty = 0, servedQty = 0) => {
  const status = String(value || '').trim().toLowerCase()
  if (['not_available', 'not_served'].includes(status)) return status
  if (status === 'fully_served' && servedQty >= prescribedQty) return 'fully_served'
  if (status === 'partially_served' && servedQty > 0 && servedQty < prescribedQty) return 'partially_served'
  if (servedQty <= 0) return 'pending'
  return servedQty >= prescribedQty ? 'fully_served' : 'partially_served'
}

const getMedicineServingStatusLabel = (value = '') =>
  MEDICINE_SERVING_STATUSES.find((status) => status.value === value)?.label ||
  (value === 'pending' ? 'Pending' : value || 'Pending')

const getClaimServingStatus = (medicines = []) => {
  medicines = compactMedicines(medicines)
  if (!medicines.length) return 'not_served'
  const statuses = medicines.map((medicine) =>
    normalizeMedicineServingStatus(
      medicine.servingStatus ?? medicine.serving_status,
      getMedicinePrescribedQty(medicine),
      getMedicineServedQty(medicine)
    )
  )
  if (statuses.every((status) => status === 'fully_served')) return 'fully_served'
  if (statuses.every((status) => ['not_available', 'not_served', 'pending'].includes(status))) return 'not_served'
  if (statuses.some((status) => ['fully_served', 'partially_served'].includes(status))) return 'partially_served'
  return 'pending'
}

const toLocalIsoDate = (date = new Date()) => {
  return getNhisCalendarDate(date)
}

const todayIsoDate = () => toLocalIsoDate()
const monthStartIsoDate = (date = new Date()) => toLocalIsoDate(new Date(date.getFullYear(), date.getMonth(), 1))
const monthEndIsoDate = (date = new Date()) => toLocalIsoDate(new Date(date.getFullYear(), date.getMonth() + 1, 0))
const previousMonthRange = (date = new Date()) => {
  const previousMonth = new Date(date.getFullYear(), date.getMonth() - 1, 1)
  return { from: monthStartIsoDate(previousMonth), to: monthEndIsoDate(previousMonth) }
}
const weekStartIsoDate = (date = new Date()) => {
  const start = new Date(date)
  const day = start.getDay()
  const offset = day === 0 ? 6 : day - 1
  start.setDate(start.getDate() - offset)
  return toLocalIsoDate(start)
}

const OPEN_CLAIM_STATUSES = new Set(['pending_serving', 'serving_in_progress', 'returned_for_review', 'served', 'submitted'])

const getClaimServiceDateKey = (claim = {}) =>
  getNhisCalendarDate(claim.service_date_from || claim.serviceDate || claim.created_at || claim.createdAt)

const formatClaimMonthLabel = (dateKey = '') => {
  if (!dateKey) return 'an earlier period'
  const [year, month] = dateKey.split('-').map(Number)
  if (!year || !month) return 'an earlier period'
  return new Date(year, month - 1, 1).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  })
}

const getClaimAgeDays = (dateKey = '') => {
  if (!dateKey) return null
  const started = new Date(`${dateKey}T00:00:00`)
  if (Number.isNaN(started.getTime())) return null
  const today = new Date(`${todayIsoDate()}T00:00:00`)
  return Math.max(0, Math.floor((today.getTime() - started.getTime()) / 86400000))
}

const fmtFileSize = (bytes) => {
  const size = Number(bytes || 0)
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const normalizeLookupText = (value) => String(value || '').toLowerCase()
const compactLookupText = (value) => normalizeLookupText(value).replace(/[^a-z0-9]/g, '')

const lookupMatches = (value, term) => {
  if (!value) return false
  return normalizeLookupText(value).includes(term) ||
    compactLookupText(value).includes(compactLookupText(term))
}

const patientNameParts = (fullName = '') => {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean)
  return {
    surname: parts[0] || '',
    otherNames: parts.slice(1).join(' '),
  }
}

const getPatientFullName = (patient = {}) =>
  patient.full_name ||
  patient.fullName ||
  [patient.surname, patient.other_names || patient.otherNames].filter(Boolean).join(' ')

const getPatientMemberNumber = (patient = {}) =>
  patient.nhis_member_no ||
  patient.nhisMemberNo ||
  patient.member_no ||
  patient.memberNo ||
  patient.insurance_id ||
  patient.insuranceId ||
  ''

const getPatientHin = (patient = {}) =>
  patient.nhis_hin || patient.nhisHin || patient.hin || ''

const getPatientFolderNo = (patient = {}) =>
  patient.folder_no || patient.folderNo || ''

const getPatientPhone = (patient = {}) =>
  patient.phone || patient.mobile || patient.contact || ''

const getPatientGender = (patient = {}) =>
  patient.gender || patient.sex || ''

const getPatientDateOfBirth = (patient = {}) =>
  patient.date_of_birth || patient.dateOfBirth || patient.dob || ''

const normalizeDateOfBirthValue = normalizeNhisDateOfBirth
const formatDateOfBirthInputValue = formatNhisDateOfBirthInput

const getPatientAddress = (patient = {}) =>
  patient.address || patient.patient_address || patient.patientAddress || ''

const getPatientInsuranceProvider = (patient = {}) =>
  patient.insurance_provider || patient.insuranceProvider || ''

const formatPatientLookupName = (patient = {}) =>
  getPatientFullName(patient) ||
  getPatientMemberNumber(patient) ||
  getPatientHin(patient) ||
  'Selected patient'

const patientSearchKey = (patient = {}) =>
  patient.id ||
  compactLookupText([
    getPatientFullName(patient),
    getPatientMemberNumber(patient),
    getPatientHin(patient),
    getPatientFolderNo(patient),
    getPatientDateOfBirth(patient),
  ].filter(Boolean).join('|'))

const nhisPatientListKey = (patient = {}) =>
  compactLookupText([
    getPatientMemberNumber(patient),
    getPatientHin(patient),
    getPatientFullName(patient),
    getPatientFolderNo(patient),
    getPatientDateOfBirth(patient),
  ].filter(Boolean).join('|')) || patientSearchKey(patient)

const mergeNhisPatientRecord = (existing, patient) =>
  existing
    ? {
        ...patient,
        ...existing,
        full_name: getPatientFullName(existing) || getPatientFullName(patient),
        nhis_member_no: getPatientMemberNumber(existing) || getPatientMemberNumber(patient),
        insurance_id: existing.insurance_id || patient.insurance_id || getPatientMemberNumber(existing) || getPatientMemberNumber(patient),
        nhis_hin: getPatientHin(existing) || getPatientHin(patient),
        folder_no: getPatientFolderNo(existing) || getPatientFolderNo(patient),
        phone: getPatientPhone(existing) || getPatientPhone(patient),
        gender: getPatientGender(existing) || getPatientGender(patient),
        date_of_birth: getPatientDateOfBirth(existing) || getPatientDateOfBirth(patient),
        address: getPatientAddress(existing) || getPatientAddress(patient),
        insurance_provider: getPatientInsuranceProvider(existing) || getPatientInsuranceProvider(patient),
        sourceClaimNumber: existing.sourceClaimNumber || patient.sourceClaimNumber || '',
      }
    : patient

const isNhisPatientRecord = (patient = {}) =>
  Boolean(
    getPatientMemberNumber(patient) ||
      getPatientHin(patient) ||
      String(getPatientInsuranceProvider(patient)).toLowerCase().includes('nhis') ||
      String(getPatientInsuranceProvider(patient)).toLowerCase().includes('national health')
  )

const claimToPatientSearchResult = (claim = {}) => ({
  id: claim.patient_id || `nhis-claim-${claim.id || claim.claim_number || patientSearchKey(claim)}`,
  patient_id: claim.patient_id || '',
  full_name: [claim.surname, claim.other_names].filter(Boolean).join(' ').trim(),
  nhis_member_no: claim.member_no || '',
  insurance_id: claim.member_no || '',
  nhis_hin: claim.hin || '',
  gender: claim.gender || '',
  date_of_birth: claim.date_of_birth || '',
  address: claim.patient_address || '',
  folder_no: claim.folder_no || '',
  sourceClaimNumber: claim.claim_number || '',
})

const buildPendingNhisClaimId = ({ organizationId = '', claimForm = {} } = {}) => {
  const key = compactLookupText([
    organizationId,
    claimForm.memberNo,
    claimForm.hin,
    claimForm.serviceDate,
    claimForm.surname,
    claimForm.otherNames,
  ].filter(Boolean).join('|'))
  return `pending-${key || 'claim'}`
}

const parseClaimDurationDays = (duration) => {
  const value = normalizeLookupText(duration)
  if (!value) return null
  const fractionMatch = value.match(/\b(\d+)\s*\/\s*7\b/)
  if (fractionMatch) return Number(fractionMatch[1])
  const numberMatch = value.match(/\b(\d+(?:\.\d+)?)\b/)
  if (!numberMatch) return null
  const amount = Number(numberMatch[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  if (value.includes('week')) return Math.round(amount * 7)
  if (value.includes('month')) return Math.round(amount * 30)
  return Math.round(amount)
}

const formatClaimDurationAsDays = (duration) => {
  const days = parseClaimDurationDays(duration)
  if (!days) return String(duration ?? '').trim()
  return `${days} day${days === 1 ? '' : 's'}`
}

const getClaimPatientKey = (claim = {}) => {
  const memberKey = compactLookupText(claim.memberNo || claim.member_no || claim.hin)
  if (memberKey) return memberKey
  return compactLookupText(
    [claim.surname, claim.otherNames || claim.other_names].filter(Boolean).join(' ')
  )
}

const getMedicineKey = (medicine = {}) =>
  compactLookupText(
    medicine.drugCode ||
      medicine.drug_code ||
      medicine.nhisDrugId ||
      medicine.nhis_drug_id ||
      medicine.description
  )

const getMedicineNameKey = (medicine = {}) =>
  compactLookupText(medicine.description || medicine.drug_name || medicine.name)

const getClaimServiceDate = (claim = {}) =>
  claim.serviceDate || claim.service_date_from || claim.dispensaryDate || claim.dispensary_date || ''

const getClaimCreatedTimestamp = (claim = {}) =>
  claim.created_at || claim.createdAt || claim.updated_at || claim.updatedAt || ''

const getClaimUpdatedTimestamp = (claim = {}) =>
  claim.updated_at || claim.updatedAt || claim.created_at || claim.createdAt || ''

const formatNhisServiceDateTime = (claim = {}) => {
  const serviceDate = getClaimServiceDate(claim)
  if (!serviceDate) return '—'

  const rawServiceDate = String(serviceDate).trim()
  if (rawServiceDate.includes('T')) {
    return formatAppDateTime(rawServiceDate)
  }

  const createdTimestamp = String(getClaimCreatedTimestamp(claim)).trim()
  if (createdTimestamp.includes('T')) {
    const timePart = createdTimestamp.split('T')[1]?.replace(/Z$/, '') || ''
    if (timePart) {
      return formatAppDateTime(`${rawServiceDate}T${timePart}`)
    }
  }

  return formatAppDate(rawServiceDate)
}

const isReadinessIssueNotIncluded = (issue = {}) => (
  issue.exportInclusion === 'not_included' ||
  issue.export_inclusion === 'not_included' ||
  issue.exportInclusionReason === 'status_not_exportable' ||
  issue.export_inclusion_reason === 'status_not_exportable'
)

const getReadinessIssueCategories = (issue = {}) => {
  const text = (Array.isArray(issue.issues) ? issue.issues : [])
    .join(' ')
    .toLowerCase()
  const categories = new Set()

  if (isReadinessIssueNotIncluded(issue) || /\bnot included in (this )?cxf\b|\bnot included in the export\b/.test(text)) {
    categories.add('not_included')
  }
  if (/\bnot yet ready for export\b/.test(text)) {
    categories.add('status')
  }
  if (/\battach|attachment|prescription file|scanned|pdf|jpeg|png|document type\b/.test(text)) {
    categories.add('attachment')
  }
  if (/\bhin|ghana card|member\/card|member identifier|member no|membership number|card serial\b/.test(text)) {
    categories.add('identifier')
  }
  if (/\bverify|verified|unverified\b/.test(text)) {
    categories.add('verification')
  }
  if (/\bprescriber|physician|provider|referral|ccc|authorization|authorisation\b/.test(text)) {
    categories.add('prescriber')
  }
  if (/\bdiagnosis|icd|treatment\b/.test(text)) {
    categories.add('diagnosis')
  }
  if (/\bclinical|risk|critical|age-restricted|gender|pregnancy|obstetric|prostate|infection|antibiotic|antimicrobial|chronic|specialist|supporting diagnosis|supporting malaria|diagnosis-lab|lab review|typhoid|widal|bp reading|glucose|hba1c\b/.test(text)) {
    categories.add('clinical')
  }
  if (/\bg-drg|gdrg|tariff|service \d+|procedure|investigation|laboratory|lab|provider class|facility group|catering\b/.test(text)) {
    categories.add('tariff')
  }
  if (/\bmedicine|drug|quantity|dispensed|served|dosage|level\b/.test(text)) {
    categories.add('medicine')
  }
  if (!categories.size) categories.add('other')
  return Array.from(categories)
}

const READINESS_CATEGORY_LABELS = {
  not_included: 'Not included',
  status: 'Not yet served/submitted',
  attachment: 'Attachment',
  identifier: 'Member/HIN',
  verification: 'Verification',
  prescriber: 'Prescriber',
  diagnosis: 'Diagnosis',
  clinical: 'Clinical',
  tariff: 'Tariff/G-DRG',
  medicine: 'Medicine',
  other: 'Other',
}

const getReadinessIssueSeverity = (text = '') => {
  const normalized = String(text || '').toLowerCase()
  if (/\bcritical\b|must|required|cannot|not allowed|does not appear to match|not clinically compatible|before submission|before exporting|blocked|exact dispensed quantity|greater than zero/.test(normalized)) {
    return 'error'
  }
  if (/\bhigh\b|warning|warn|unusual|confirm|should|missing|review|not supported|not explained/.test(normalized)) {
    return 'warning'
  }
  return 'info'
}

const getReadinessIssueLabel = (text = '') => {
  const normalized = String(text || '').toLowerCase()
  if (/\bdiagnosis[-\s]treatment|not clinically compatible|does not appear to match|supporting diagnosis|not explained by the recorded diagnosis/.test(normalized)) return 'Diagnosis-treatment'
  if (/\bdiagnosis[-\s]lab|lab review|laboratory|investigation|typhoid|widal|blood film|rdt\b/.test(normalized)) return 'Lab/investigation'
  if (/\bg-drg|gdrg|tariff|service \d+|procedure|investigation|provider class|facility group|catering/.test(normalized)) return 'Tariff/G-DRG'
  if (/\battach|attachment|prescription file|scanned|pdf|jpeg|png|document type\b/.test(normalized)) return 'Attachment'
  if (/\bverify|verified|unverified\b/.test(normalized)) return 'Verification'
  if (/\bprescriber|physician|referral|authorization|authorisation\b/.test(normalized)) return 'Prescriber'
  if (/\bhin|member\/card|member identifier|membership number|card serial\b/.test(normalized)) return 'Member/HIN'
  if (/\bccc|cc code|nhis member|ghana card|folder number|patient surname|date of dispensing|service is required/.test(normalized)) return 'Required field'
  if (/\bmedicine|drug|quantity|dispensed|served|dosage|dose|frequency|duration|level\b/.test(normalized)) return 'Medicine'
  if (/\bage|gender|pregnancy|prostate|child|pediatric\b/.test(normalized)) return 'Age/gender'
  return 'General'
}

const getReadinessIssueKey = (issue = {}) =>
  normalizeLookupText(issue.id || issue.claim_number || issue.claimNumber || issue.patientName)

const readinessIssueMatchesSearch = (issue = {}, searchTerm = '') => {
  const term = normalizeLookupText(searchTerm).trim()
  if (!term) return true
  const patientName = issue.patientName || [issue.surname, issue.other_names].filter(Boolean).join(' ')
  const values = [
    issue.claim_number,
    issue.claimNumber,
    patientName,
    issue.surname,
    issue.other_names,
    issue.member_no,
    issue.memberNo,
    issue.hin,
    issue.folder_no,
    issue.folderNo,
    issue.ccc_no,
    issue.cccNo,
    issue.status,
    ...(Array.isArray(issue.issues) ? issue.issues : []),
  ]
  return values.some((value) => lookupMatches(value, term))
}

const duplicateClaimGroupMatchesSearch = (group = {}, searchTerm = '') => {
  const term = normalizeLookupText(searchTerm).trim()
  if (!term) return true
  const groupValues = [
    group.patientName,
    group.member,
    group.serviceDate,
    group.totalAmount,
    group.key,
  ]
  const claimValues = (group.claims || []).flatMap((claim) => [
    claim.claim_number,
    claim.claimNumber,
    claim.surname,
    claim.other_names,
    [claim.surname, claim.other_names].filter(Boolean).join(' '),
    [claim.other_names, claim.surname].filter(Boolean).join(' '),
    claim.member_no,
    claim.memberNo,
    claim.hin,
    claim.folder_no,
    claim.folderNo,
    claim.ccc_no,
    claim.cccNo,
    claim.status,
    claim.service_date_from,
    claim.serviceDateFrom,
    claim.created_at,
    claim.createdAt,
    claim.updated_at,
    claim.updatedAt,
  ])
  return [...groupValues, ...claimValues].some((value) => lookupMatches(value, term))
}

const getTimestampMs = (value) => {
  const parsed = new Date(value || '')
  return Number.isNaN(parsed.getTime()) ? Number.POSITIVE_INFINITY : parsed.getTime()
}

const getLikelyOriginalClaimId = (claims = []) =>
  [...claims]
    .sort((a, b) => {
      const createdDiff = getTimestampMs(getClaimCreatedTimestamp(a)) - getTimestampMs(getClaimCreatedTimestamp(b))
      if (createdDiff !== 0) return createdDiff
      return String(a.claim_number || '').localeCompare(String(b.claim_number || ''))
    })[0]?.id || ''

const daysBetweenIsoDates = (fromDate, toDate) => {
  const from = new Date(fromDate)
  const to = new Date(toDate)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null
  return Math.floor((to.getTime() - from.getTime()) / 86400000)
}

const toNhisMedicineAlertDate = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const getClaimMedicineAlertDate = (claim = {}) =>
  toNhisMedicineAlertDate(
    claim.service_date_from ||
      claim.serviceDateFrom ||
      claim.service_date ||
      claim.serviceDate ||
      claim.dispensaryDate ||
      claim.dispensary_date ||
      claim.created_at ||
      claim.createdAt
  )

const buildNhisAddMedicineDuplicateAlerts = ({
  currentClaim,
  currentMedicines,
  candidateMedicine,
  existingClaims,
  editingClaimId,
  editingMedicineIndex,
  windowHours = 24,
}) => {
  const alerts = []
  const candidateMedicineKey = getMedicineKey(candidateMedicine)
  const candidateNameKey = getMedicineNameKey(candidateMedicine)
  const candidateLabel = candidateMedicine.description || candidateMedicine.drugCode || 'This medicine'
  const currentPatientKey = getClaimPatientKey(currentClaim)
  const currentDate = toNhisMedicineAlertDate(
    candidateMedicine.dispensaryDate || currentClaim.serviceDate || currentClaim.service_date || new Date()
  ) || new Date()
  const windowMs = Math.max(1, Number(windowHours) || 24) * 60 * 60 * 1000

  ;(currentMedicines || []).forEach((medicine, index) => {
    if (index === editingMedicineIndex) return
    const sameMedicine = (
      (candidateMedicineKey && candidateMedicineKey === getMedicineKey(medicine)) ||
      (candidateNameKey && candidateNameKey === getMedicineNameKey(medicine))
    )
    if (sameMedicine) {
      alerts.push(`${candidateLabel} is already on this open claim. Confirm this is intentional before adding another line.`)
    }
  })

  if (!currentPatientKey) return [...new Set(alerts)]

  ;(existingClaims || [])
    .filter((claim) => claim.id !== editingClaimId)
    .filter((claim) => getClaimPatientKey(claim) && getClaimPatientKey(claim) === currentPatientKey)
    .forEach((claim) => {
      const previousDate = getClaimMedicineAlertDate(claim)
      if (!previousDate) return
      const diffMs = currentDate.getTime() - previousDate.getTime()
      if (diffMs < 0 || diffMs > windowMs) return

      const existingMedicines = claim.nhis_claim_medicines || claim.medicines || claim.items || []
      const match = existingMedicines.find((existingMedicine) => (
        (candidateMedicineKey && candidateMedicineKey === getMedicineKey(existingMedicine)) ||
        (candidateNameKey && candidateNameKey === getMedicineNameKey(existingMedicine))
      ))
      if (!match) return

      const claimLabel = claim.claim_number || `${claim.surname || ''} ${claim.other_names || ''}`.trim() || 'a previous NHIS visit'
      const hoursSinceLast = Math.round((diffMs / (60 * 60 * 1000)) * 10) / 10
      alerts.push(
        `${candidateLabel} was already dispensed for this patient on ${formatAppDateTime(previousDate)} (${claimLabel}), ${hoursSinceLast} hour(s) ago.`
      )
    })

  return [...new Set(alerts)]
}

const buildNhisActiveMedicationOverlapMessage = (alerts = []) => {
  const visibleAlerts = (Array.isArray(alerts) ? alerts : []).slice(0, 3)
  if (!visibleAlerts.length) return ''

  const lines = visibleAlerts.map((alert, index) => {
    const medicine = alert.medicine_description || alert.medicine_code || `Medicine ${index + 1}`
    const matchText = {
      same_ingredient: 'Similar active ingredient',
      possible_completion_supply: 'Possible completion supply',
      partial_previous_supply: 'Previous partial supply',
      early_refill_review: 'Early refill review',
      exact_code: 'Same medicine code',
    }[alert.match_type] || 'Same medicine code'
    const previousDate = alert.previous_dispensed_date
      ? formatAppDate(alert.previous_dispensed_date)
      : 'Not recorded'
    const endDate = alert.coverage_end_date
      ? formatAppDate(alert.coverage_end_date)
      : 'Not recorded'
    const remainingDays = Number(alert.remaining_days || 0)
    const remainingText = remainingDays > 0
      ? `${remainingDays} day(s) remaining`
      : 'active coverage may still overlap'
    const quantitySupplied = alert.previous_quantity_supplied ?? alert.previousQuantitySupplied
    const previousDose = normalizeText(alert.previous_dose ?? alert.previousDose)
    const previousFrequency = normalizeText(alert.previous_frequency ?? alert.previousFrequency)
    const administrationsPerDay = Number(alert.calculated_administrations_per_day ?? alert.calculatedAdministrationsPerDay)
    const treatmentDays = Number(alert.calculated_treatment_days ?? alert.calculatedTreatmentDays)
    const quantityText = quantitySupplied !== null && quantitySupplied !== undefined && `${quantitySupplied}` !== ''
      ? `Quantity supplied: ${quantitySupplied}`
      : ''
    const doseText = previousDose ? `Dose: ${previousDose}` : ''
    const frequencyText = previousFrequency ? `Frequency: ${previousFrequency}` : ''
    const administrationsText = Number.isFinite(administrationsPerDay) && administrationsPerDay > 0
      ? `Calculated administrations/day: ${administrationsPerDay}`
      : ''
    const treatmentDaysText = Number.isFinite(treatmentDays) && treatmentDays > 0
      ? `Calculated treatment days: ${treatmentDays}`
      : ''
    const riskScore = Number(alert.risk_score)
    const riskText = Number.isFinite(riskScore) && riskScore > 0
      ? `Risk score: ${riskScore}/100`
      : ''
    const recommendedAction = normalizeText(alert.recommended_action)
    const dateQualityWarning = normalizeText(alert.date_quality_warning || alert.dateQualityWarning)
    const sourceLabel = normalizeText(alert.source_label) || 'Another participating HealthFlow facility'
    const reasonLines = Array.isArray(alert.risk_reasons)
      ? alert.risk_reasons.map((reason) => normalizeText(reason)).filter(Boolean).slice(0, 4)
      : []

    return [
      `${index + 1}. ${medicine}`,
      alert.previous_dispensed_date
        ? `Possible duplicate dispensing: ${medicine} was served to this patient at ${sourceLabel} on ${previousDate}.`
        : '',
      `Match: ${matchText}`,
      `Previous dispensing: ${previousDate}`,
      quantityText,
      doseText,
      frequencyText,
      administrationsText,
      treatmentDaysText,
      `Calculated treatment end: ${endDate}`,
      `Remaining coverage: ${remainingText}`,
      `Source: ${sourceLabel}`,
      dateQualityWarning ? 'Dispensing date requires review.' : '',
      riskText,
      recommendedAction ? `Recommended action: ${recommendedAction}` : '',
      ...reasonLines.map((reason) => `Reason: ${reason}`),
    ].filter(Boolean).join('\n')
  })

  return [
    'ACTIVE MEDICATION ALERT',
    'This member may already have active medicine coverage. Review before adding this medicine.',
    ...lines,
  ].join('\n\n')
}

const showNhisMedicationOverlapBlockAlert = (alerts = [], notifyFn = null) => {
  const message = buildNhisActiveMedicationOverlapMessage(alerts)
  if (!message) return
  const fullMessage = `${message}\n\nThis medicine cannot be added or served while active coverage remains. Correct the previous record, wait until coverage ends, or contact a claims officer/admin for review.`
  if (typeof notifyFn === 'function') {
    notifyFn(fullMessage, 'error')
    return
  }
  console.warn('[NHIS] Active medication overlap blocked:', fullMessage)
}

const buildNhisDuplicateWarnings = ({
  currentClaim,
  currentMedicines,
  existingClaims,
  editingClaimId,
}) => {
  const warnings = []
  const currentPatientKey = getClaimPatientKey(currentClaim)
  const currentDate = getClaimServiceDate(currentClaim)
  const currentTotal = currentMedicines.reduce((sum, medicine) => sum + Number(medicine.totalAmount || 0), 0)
  const seenMedicines = new Map()

  currentMedicines.forEach((medicine) => {
    const medicineKey = getMedicineKey(medicine)
    const nameKey = getMedicineNameKey(medicine)
    const duplicateKey = medicineKey || nameKey
    if (!duplicateKey) return
    if (seenMedicines.has(duplicateKey)) {
      warnings.push(`This claim already contains "${medicine.description}" more than once.`)
    } else {
      seenMedicines.set(duplicateKey, medicine)
    }
  })

  existingClaims
    .filter((claim) => claim.id !== editingClaimId)
    .filter((claim) => getClaimPatientKey(claim) && getClaimPatientKey(claim) === currentPatientKey)
    .forEach((claim) => {
      const existingMedicines = claim.nhis_claim_medicines || []
      const existingDate = getClaimServiceDate(claim)
      const existingTotal = Number(claim.total_amount || 0)
      const claimLabel = claim.claim_number || `${claim.surname || ''} ${claim.other_names || ''}`.trim() || 'existing claim'
      const sameDate = currentDate && existingDate && currentDate === existingDate
      const sameTotal = Math.abs(existingTotal - currentTotal) < 0.01

      if (sameDate && sameTotal) {
        warnings.push(`${claimLabel} has the same patient, date, and total amount.`)
      }

      currentMedicines.forEach((medicine) => {
        const currentMedicineKey = getMedicineKey(medicine)
        const currentNameKey = getMedicineNameKey(medicine)
        const match = existingMedicines.find((existingMedicine) => {
          const existingMedicineKey = getMedicineKey(existingMedicine)
          const existingNameKey = getMedicineNameKey(existingMedicine)
          return (
            (currentMedicineKey && currentMedicineKey === existingMedicineKey) ||
            (currentNameKey && currentNameKey === existingNameKey)
          )
        })

        if (!match) return

        const daysSinceLast = daysBetweenIsoDates(existingDate, currentDate)
        const servedDays = parseClaimDurationDays(match.duration || medicine.duration)
        const sameQuantity = Number(match.dispensed_qty || 0) === Number(medicine.dispensedQty || 0)
        const sameAmount = Math.abs(Number(match.total_amount || 0) - Number(medicine.totalAmount || 0)) < 0.01

        if (servedDays && daysSinceLast !== null && daysSinceLast >= 0 && daysSinceLast < servedDays) {
          warnings.push(
            `${medicine.description} was already served on ${formatAppDate(existingDate)} for ${servedDays} day(s); this is only ${daysSinceLast} day(s) later.`
          )
        } else if (sameQuantity && sameAmount) {
          warnings.push(`${claimLabel} has the same medicine, quantity, and amount for this patient.`)
        }
      })
    })

  return [...new Set(warnings)]
}

const buildNhisDuplicateClaimBlockers = ({
  currentClaim,
  currentMedicines,
  existingClaims,
  editingClaimId,
}) => {
  const currentPatientKey = getClaimPatientKey(currentClaim)
  const currentDate = getClaimServiceDate(currentClaim)
  const currentTotal = currentMedicines.reduce((sum, medicine) => sum + Number(medicine.totalAmount || 0), 0)
  if (!currentPatientKey || !currentDate) return []

  return [...new Set(
    existingClaims
      .filter((claim) => claim.id !== editingClaimId)
      .filter((claim) => getClaimPatientKey(claim) && getClaimPatientKey(claim) === currentPatientKey)
      .filter((claim) => {
        const existingDate = getClaimServiceDate(claim)
        const existingTotal = Number(claim.total_amount || 0)
        return existingDate && existingDate === currentDate && Math.abs(existingTotal - currentTotal) < 0.01
      })
      .map((claim) => {
        const claimLabel = claim.claim_number || `${claim.surname || ''} ${claim.other_names || ''}`.trim() || 'existing claim'
        return `${claimLabel} has the same patient, date, and total amount.`
      })
  )]
}

const getSettingValue = (settings, camelKey, snakeKey) =>
  settings?.[camelKey] ?? settings?.[snakeKey] ?? ''

const getPreferredTariffFacilityGroup = (settings, organization) => {
  const providerType =
    getSettingValue(settings, 'providerTypeDescription', 'provider_type_description') ||
    organization?.provider_type_description ||
    organization?.providerTypeDescription ||
    ''
  const normalizedProvider = compactLookupText(providerType)
  const explicitGroup =
    getSettingValue(settings, 'tariffFacilityGroup', 'tariff_facility_group') ||
    getSettingValue(settings, 'nhiaTariffFacilityGroup', 'nhia_tariff_facility_group') ||
    organization?.tariff_facility_group ||
    organization?.nhia_tariff_facility_group

  if (explicitGroup) {
    const normalizedExplicitGroup = compactLookupText(explicitGroup)
    if (
      normalizedExplicitGroup.includes('chagprimarycarehospital') ||
      (
        normalizedExplicitGroup.includes('chag') &&
        normalizedExplicitGroup.includes('primary') &&
        normalizedExplicitGroup.includes('hospital')
      )
    ) {
      return 'Private Primary Care Hospital'
    }
    return explicitGroup
  }

  if (normalizedProvider.includes('privateprimarycarehospital') ||
      (normalizedProvider.includes('private') && normalizedProvider.includes('primary') && normalizedProvider.includes('hospital'))) {
    return 'Private Primary Care Hospital'
  }

  if (normalizedProvider.includes('primary') && normalizedProvider.includes('hospital')) {
    return 'Private Primary Care Hospital'
  }

  if (normalizedProvider.includes('healthcenters') || normalizedProvider.includes('healthcentre')) {
    return 'CHAG Health Centre and Clinic'
  }

  return ''
}

const getPreferredTariffCateringOption = (settings) => {
  const admissionOption = getSettingValue(settings, 'admissionPaymentOption', 'admission_payment_option')
  if (admissionOption === 'patient_pays_admission') return 'exclusive'
  if (admissionOption === 'nhis_pays_admission') return 'inclusive'
  return ''
}

const StatusBadge = ({ status, incomplete = false }) => (
  <span className={`nhis-badge nhis-badge--${incomplete ? 'pending_serving' : status}`}>
    {incomplete ? 'Incomplete' : getClaimStatusLabel(status)}
  </span>
)

const looksLikeUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim())

// ─── component ────────────────────────────────────────────────────────────────

const Nhis = () => {
  const {
    role,
    user,
    profile,
    branch,
    organization,
    assignedRoles,
    canDeleteNhisClaims,
    canViewReports,
  } = useAuth()
  const { notify } = useNotification()
  const [searchParams, setSearchParams] = useSearchParams()
  const fileInputRef = useRef(null)
  const ruleFileInputRef = useRef(null)

  const normalizedRole = String(role || '').toLowerCase()
  const canEditNhisClaimAnytime = canPrivilegedCorrectNhisClaim({
    activeRole: normalizedRole,
    assignedRoles,
  })
  const privilegedNhisActionRole = canEditNhisClaimAnytime ? 'claims_officer' : normalizedRole
  // A staff member may have Claims Officer as an assigned role while their
  // currently selected role is Assistant. Privileged correction access must
  // follow the same role set as the server RPC, not the display role alone.
  const isMedicineCounterAssistant = normalizedRole === 'assistant' && !canEditNhisClaimAnytime
  const canWrite = canEditNhisClaimAnytime || (
    !isMedicineCounterAssistant && (
      ['admin', 'super_admin', 'pharmacist', 'billing', 'claims_officer', 'records_officer']
        .includes(normalizedRole) ||
      Boolean(profile?.can_manage_claims)
    )
  )
  const canServeNhisMedicines = canWrite || isMedicineCounterAssistant
  const canEditNhisPatientDetails = canWrite
  const organizationType = normalizeOrganizationType(organization?.organization_type)
  const organizationId = organization?.id || profile?.organization_id || ''
  const isHospital = organizationType === 'hospital'
  const isIncompletePharmacyClaim = (claim = {}) =>
    !isHospital && !hasVerifiedNhisPrescription(claim)
  const getNhisClaimIssueBadges = (claim = {}) => {
    const badges = []
    const status = normalizeText(claim.status).toLowerCase()
    if (!isHospital) {
      if (!hasNhisPrescriptionAttachment(claim)) {
        badges.push({ key: 'missing-attachment', label: 'Missing attachment', tone: 'danger' })
      } else if (String(claim.prescription_document_type || claim.prescriptionDocumentType || '').trim().toLowerCase() !== 'prescription') {
        badges.push({ key: 'attachment-type', label: 'Set attachment type', tone: 'warning' })
      } else if (['served', 'submitted', 'paid'].includes(status) && !hasVerifiedNhisPrescription(claim)) {
        badges.push({ key: 'unverified-prescription', label: 'Unverified prescription', tone: 'warning' })
      }
    }
    if (['pending_serving', 'serving_in_progress', 'returned_for_review'].includes(status) &&
      getNhisIncompleteIntakeItems({
        claim,
        medicines: claim.nhis_claim_medicines || [],
      }).length > 0
    ) {
      badges.push({ key: 'incomplete-intake', label: 'Incomplete intake', tone: 'info' })
    }
    return badges
  }

  // ── page sub-tab ─────────────────────────────────────────────
  const [pageTab, setPageTab] = useState('claims') // 'claims' | 'patients' | 'catalog' | 'gdrg' | 'review' | 'rules'

  // ── data ─────────────────────────────────────────────────────
  const [claims, setClaims]       = useState([])
  const [nhisDrugs, setNhisDrugs] = useState([])
  const [nhiaTariffItems, setNhiaTariffItems] = useState([])
  const [clinicalRules, setClinicalRules] = useState([])
  const [patients, setPatients]   = useState([])
  const [prescribers, setPrescribers] = useState([])
  const [prescribingFacilities, setPrescribingFacilities] = useState([])
  const [inventoryDrugs, setInventoryDrugs] = useState([])
  const [stats, setStats]         = useState({
    total: 0,
    pending_serving: 0,
    returned_for_review: 0,
    served: 0,
    submitted: 0,
    paid: 0,
    rejected: 0,
    totalClaimValue: 0,
    totalPaid: 0,
  })
  const [loading, setLoading]     = useState(true)
  const [claimsPageLoading, setClaimsPageLoading] = useState(false)
  const [claimsPage, setClaimsPage] = useState(1)
  const [claimsPageSize, setClaimsPageSize] = useState(NHIS_CLAIMS_DEFAULT_PAGE_SIZE)
  const [claimsTotal, setClaimsTotal] = useState(0)
  const [claimIssueCounts, setClaimIssueCounts] = useState({ all: 0 })
  const [claimIssueCountsLoading, setClaimIssueCountsLoading] = useState(false)
  const [openingFirstClaimIssue, setOpeningFirstClaimIssue] = useState(false)
  const [error, setError]         = useState('')
  const [catalogSeeding, setCatalogSeeding] = useState(false)

  // ── claims filter ─────────────────────────────────────────────
  const [claimTab, setClaimTab]         = useState('all')
  const [claimIssueFilter, setClaimIssueFilter] = useState('all')
  const [claimSearch, setClaimSearch]   = useState('')
  const debouncedClaimSearch = useDebouncedValue(claimSearch, NHIS_CLAIMS_SEARCH_DEBOUNCE_MS)
  const [nhisPatientSearch, setNhisPatientSearch] = useState('')
  const [prescriberSearch, setPrescriberSearch] = useState('')
  const [facilitySearch, setFacilitySearch] = useState('')
  const [claimDateFilter, setClaimDateFilter] = useState('month')
  const [claimFromDate, setClaimFromDate] = useState(monthStartIsoDate())
  const [claimToDate, setClaimToDate] = useState(todayIsoDate())

  // ── catalog filter ────────────────────────────────────────────
  const [catalogSearch, setCatalogSearch] = useState('')
  const [tariffCatalogSearch, setTariffCatalogSearch] = useState('')

  // ── modals ────────────────────────────────────────────────────
  const [showNewClaimModal, setShowNewClaimModal]   = useState(false)
  const [showMedModal, setShowMedModal]             = useState(false)   // new medicine sub-modal
  const [showDrugCatalogModal, setShowDrugCatalogModal] = useState(false)
  const [showImportModal, setShowImportModal]       = useState(false)
  const [showRuleImportModal, setShowRuleImportModal] = useState(false)
  const [showExportModal, setShowExportModal]       = useState(false)
  const [duplicateClaimGroups, setDuplicateClaimGroups] = useState([])
  const [duplicateExportIssues, setDuplicateExportIssues] = useState([])
  const [showDuplicateClaimReview, setShowDuplicateClaimReview] = useState(false)
  const [duplicateClaimSearch, setDuplicateClaimSearch] = useState('')
  const [readinessClaimIssues, setReadinessClaimIssues] = useState([])
  const [showReadinessClaimReview, setShowReadinessClaimReview] = useState(false)
  const [readinessIssueFilter, setReadinessIssueFilter] = useState('all')
  const [readinessIssueSearch, setReadinessIssueSearch] = useState('')
  const [readinessFixedCount, setReadinessFixedCount] = useState(0)
  const [readinessChecking, setReadinessChecking] = useState(false)
  const [readinessActiveClaimId, setReadinessActiveClaimId] = useState('')
  const [scrubWarningClaims, setScrubWarningClaims] = useState([])
  const [scrubWarningSearch, setScrubWarningSearch] = useState('')
  const [scrubWarningOverrideReason, setScrubWarningOverrideReason] = useState('')
  const [showScrubWarningOverride, setShowScrubWarningOverride] = useState(false)
  const [durationRepairReview, setDurationRepairReview] = useState(null)
  const [durationRepairValues, setDurationRepairValues] = useState({})
  const [durationRepairSaving, setDurationRepairSaving] = useState(false)
  const [durationRepairFilter, setDurationRepairFilter] = useState('all')
  const [viewClaim, setViewClaim]                   = useState(null)
  const [reopenDispensaryClaim, setReopenDispensaryClaim] = useState(null)
  const [reopenDispensaryReason, setReopenDispensaryReason] = useState('')
  const [discardConfirmation, setDiscardConfirmation] = useState(null)
  const [actionConfirmation, setActionConfirmation] = useState(null)
  const actionConfirmationResolverRef = useRef(null)

  const closeActionConfirmation = useCallback((confirmed = false) => {
    const resolver = actionConfirmationResolverRef.current
    actionConfirmationResolverRef.current = null
    setActionConfirmation(null)
    if (resolver) resolver(Boolean(confirmed))
  }, [])

  const requestActionConfirmation = useCallback((options) => new Promise((resolve) => {
    actionConfirmationResolverRef.current = resolve
    setActionConfirmation(options)
  }), [])

  // ── new claim form ────────────────────────────────────────────
  const [claimForm, setClaimForm]           = useState(makeBlankClaim)
  const [claimMedicines, setClaimMedicines] = useState([])
  const [claimServices, setClaimServices]   = useState([])
  const [claimSubmitting, setClaimSubmitting] = useState(false)
  const [claimSubmitIntent, setClaimSubmitIntent] = useState('')
  const [claimError, setClaimError]           = useState('')
  const [claimActionReview, setClaimActionReview] = useState(null)
  const [editingClaim, setEditingClaim]       = useState(null)
  const [correctionReason, setCorrectionReason] = useState('')
  const [correctionHistory, setCorrectionHistory] = useState([])
  const canCorrectDirectServedMedicine = canCorrectDirectServedNhisMedicine({
    claim: editingClaim,
    role: privilegedNhisActionRole,
  })
  const [prescriptionPdfFile, setPrescriptionPdfFile] = useState(null)

  // ── patient lookup (for claim form) ──────────────────────────
  const [patientSearch, setPatientSearch] = useState('')
  const [patientSearchResults, setPatientSearchResults] = useState([])
  const [patientSearchError, setPatientSearchError] = useState('')
  const [patientSearching, setPatientSearching] = useState(false)
  const [selectedClaimPatient, setSelectedClaimPatient] = useState(null)
  const [patientActiveMedicationState, setPatientActiveMedicationState] = useState({
    loading: false,
    checked: false,
    available: true,
    alerts: [],
    reason: '',
    error: '',
  })
  const activeMedicationPatientCheckRef = useRef(0)

  // ── medicine sub-modal ────────────────────────────────────────
  const [medForm, setMedForm]           = useState(makeBlankMedicine)
  const [medicineEntryDate, setMedicineEntryDate] = useState(getNhisCalendarDate)
  const [medCodeSearch, setMedCodeSearch] = useState('')
  const [medSearchResults, setMedSearchResults] = useState([])
  const [medSearching, setMedSearching] = useState(false)
  const [editingMedicineIndex, setEditingMedicineIndex] = useState(null)
  const [tariffSearch, setTariffSearch] = useState('')

  // ── drug catalog modal (add/edit) ─────────────────────────────
  const [editingDrug, setEditingDrug]   = useState(null) // null = add new
  const [drugForm, setDrugForm]         = useState(BLANK_NHIS_DRUG)
  const [drugSubmitting, setDrugSubmitting] = useState(false)
  const [editingTariff, setEditingTariff] = useState(null)
  const [tariffForm, setTariffForm] = useState(BLANK_NHIA_TARIFF)
  const [tariffSubmitting, setTariffSubmitting] = useState(false)
  const [prescriberForm, setPrescriberForm] = useState(BLANK_NHIS_PRESCRIBER)
  const [facilityForm, setFacilityForm] = useState(BLANK_NHIS_PRESCRIBING_FACILITY)
  const [prescribingRecordsLoading, setPrescribingRecordsLoading] = useState(false)
  const [prescriberSubmitting, setPrescriberSubmitting] = useState(false)
  const [facilitySubmitting, setFacilitySubmitting] = useState(false)
  const claimsPageCacheRef = useRef(new Map())
  const claimsTableRef = useRef(null)
  const claimsFilterKeyRef = useRef('')
  const claimIssueCountsLoadPromiseRef = useRef(null)
  const patientIndexLoadPromiseRef = useRef(null)
  const patientIndexLoadedRef = useRef(false)
  const inventoryDrugsLoadPromiseRef = useRef(null)

  // ── import modal ──────────────────────────────────────────────
  const [importRows, setImportRows]     = useState([])
  const [importErrors, setImportErrors] = useState([])
  const [importing, setImporting]       = useState(false)
  const [ruleImportRows, setRuleImportRows] = useState([])
  const [ruleImportErrors, setRuleImportErrors] = useState([])
  const [ruleImporting, setRuleImporting] = useState(false)

  // ─── direct NHIA API ─────────────────────────────────────────
  const [directNhiaSettings, setDirectNhiaSettings] = useState(null)
  const [facilitySettings, setFacilitySettings] = useState(null)
  const [nhiaSettingsLoading, setNhiaSettingsLoading] = useState(false)
  const [facilitySettingsLoading, setFacilitySettingsLoading] = useState(false)
  const [generatingCcCode, setGeneratingCcCode] = useState(false)
  const [lookingUpMember, setLookingUpMember] = useState(false)
  // Tracks the last member number we already looked up — prevents duplicate API calls
  // when the field loses focus without changing value.
  const lastLookedUpMemberRef = useRef('')
  const [returnAlert, setReturnAlert] = useState(null)
  const [returnAlertReason, setReturnAlertReason] = useState('Follow-up treatment')
  const [returnAlertOtherReason, setReturnAlertOtherReason] = useState('')
  const [returnAlertOverride, setReturnAlertOverride] = useState(null)

  // ── export modal ──────────────────────────────────────────────
  const [exportMonth, setExportMonth]   = useState(
    todayIsoDate().slice(0, 7) // YYYY-MM
  )
  const [exportMode, setExportMode]     = useState('partial')
  const [exportFromDate, setExportFromDate] = useState(monthStartIsoDate())
  const [exportToDate, setExportToDate] = useState(todayIsoDate())
  const [exportFormat, setExportFormat] = useState('cxf')
  const [exportRoute, setExportRoute] = useState('cxf_export')
  const [exporting, setExporting]       = useState(false)
  const [exportProgress, setExportProgress] = useState('')
  const [exportStartedAt, setExportStartedAt] = useState(null)
  const [exportElapsedSeconds, setExportElapsedSeconds] = useState(0)
  const exportInFlightRef = useRef(false)
  // Caches the readiness computed by the first (check) call to handleExport
  // so the second (approve) call, triggered by a separate click on the scrub
  // warning dialog, does not redo the same claim/blocker/warning loading a
  // second time. Invalidated on every fresh check, on dialog cancel, on any
  // claim edit made from the review flow, and always after being consumed —
  // it must never be reused beyond the single approval it was computed for.
  const preparedReadinessCacheRef = useRef(null)
  const exportIssueReviewAckRef = useRef('')
  // Tracks whether the scrub-warning override modal's "Approve Warnings &
  // Export" button should resume the batch export flow or a specific
  // single-claim export — set by whichever flow opens that shared modal.
  const exportResumeTargetRef = useRef({ type: 'batch' })
  const durationRepairResumeTargetRef = useRef({ type: 'batch' })
  const durationRepairTableRef = useRef(null)

  useEffect(() => {
    if (!exporting || !exportStartedAt) {
      setExportElapsedSeconds(0)
      return undefined
    }
    const tick = () => setExportElapsedSeconds(Math.max(0, Math.round((Date.now() - exportStartedAt) / 1000)))
    tick()
    const intervalId = setInterval(tick, 1000)
    return () => clearInterval(intervalId)
  }, [exporting, exportStartedAt])

  // ── status update ─────────────────────────────────────────────
  const [updatingStatus, setUpdatingStatus] = useState(null)
  const [claimActionLoading, setClaimActionLoading] = useState(null)
  const [rejectTarget, setRejectTarget]     = useState(null)
  const [rejectReason, setRejectReason]     = useState('')
  const isClaimActionBusy = (claimId, action = '') =>
    claimActionLoading?.claimId === claimId && (!action || claimActionLoading.action === action)
  const isClaimBusy = (claimId) => updatingStatus === claimId || claimActionLoading?.claimId === claimId
  const resolvedNhiaSettings = useMemo(
    () => applyNhiaFacilityDefaults(directNhiaSettings, organization),
    [directNhiaSettings, organization]
  )
  const activeTariffFacilityGroup = getPreferredTariffFacilityGroup(resolvedNhiaSettings, organization)
  const activeTariffCateringOption = getPreferredTariffCateringOption(resolvedNhiaSettings)
  const providerClassLevel = resolvedNhiaSettings?.providerClassLevel || resolvedNhiaSettings?.provider_class_level || ''
  const applicableTariffItems = useMemo(
    () => getApplicableNhiaTariffItems(nhiaTariffItems, {
      facilityGroup: activeTariffFacilityGroup,
      cateringOption: activeTariffCateringOption,
      providerClassLevel,
    }),
    [nhiaTariffItems, activeTariffFacilityGroup, activeTariffCateringOption, providerClassLevel]
  )
  const usingTemporaryUniversalTariff = useMemo(() => {
    if (!applicableTariffItems.length) return false
    return !applicableTariffItems.some((item) =>
      (!activeTariffFacilityGroup || item.facility_group === activeTariffFacilityGroup) &&
      (!activeTariffCateringOption || item.catering_option === activeTariffCateringOption)
    )
  }, [applicableTariffItems, activeTariffFacilityGroup, activeTariffCateringOption])

  // ── sync tab from URL ────────────────────────────────────────
  useEffect(() => {
    const t = searchParams.get('tab')
    if (CLAIM_STATUS_TABS.includes(t)) setClaimTab(t)
  }, [searchParams])

  const setStatusTab = (tab) => {
    setClaimsPage(1)
    setClaimTab(tab)
    setClaimIssueFilter('all')
    const p = new URLSearchParams(searchParams)
    tab === 'all' ? p.delete('tab') : p.set('tab', tab)
    setSearchParams(p, { replace: true })
  }

  const getClaimServerFilters = useCallback((options = {}) => {
    const { includeIssueFilter = false } = options
    const today = todayIsoDate()
    let fromDate = ''
    let toDate = ''
    let openOnly = false

    if (claimDateFilter === 'today') {
      fromDate = today
      toDate = today
    } else if (claimDateFilter === 'week') {
      fromDate = weekStartIsoDate()
      toDate = today
    } else if (claimDateFilter === 'month') {
      fromDate = monthStartIsoDate()
      toDate = today
    } else if (claimDateFilter === 'previous_month') {
      const previous = previousMonthRange()
      fromDate = previous.from
      toDate = previous.to
    } else if (claimDateFilter === 'custom') {
      fromDate = claimFromDate
      toDate = claimToDate
    } else if (claimDateFilter === 'open') {
      openOnly = true
    }

    return {
      includeDetails: false,
      status: claimTab !== 'all' ? claimTab : undefined,
      openOnly,
      fromDate,
      toDate,
      searchTerm: debouncedClaimSearch.trim(),
      ...(includeIssueFilter && claimIssueFilter !== 'all' ? { issueFilter: claimIssueFilter } : {}),
    }
  }, [claimDateFilter, claimFromDate, claimIssueFilter, debouncedClaimSearch, claimTab, claimToDate])

  const loadClaimsPage = useCallback(async (page = 1, options = {}) => {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (!isSupabaseConfigured()) {
      setClaims([])
      setClaimsTotal(0)
      return
    }

    const filters = getClaimServerFilters({ includeIssueFilter: true })
    const filterKey = JSON.stringify(filters)
    const pageKey = `${filterKey}|page:${page}|size:${claimsPageSize}`
    const cached = claimsPageCacheRef.current.get(pageKey)
    const now = Date.now()
    const sameFilter = claimsFilterKeyRef.current === filterKey
    const shouldLoadTotal = !sameFilter || options.refreshTotal === true

    if (!options.force && cached && now - cached.cachedAt < NHIS_CLAIMS_PAGE_CACHE_MS) {
      setClaims(cached.claims || [])
      if (cached.total != null) setClaimsTotal(Number(cached.total || 0))
      if (cached.stats) setStats(cached.stats)
      setClaimsPage(cached.page || page)
      claimsFilterKeyRef.current = filterKey
      logPerformance('nhis.claims.page.cache', startedAt, role, {
        page,
        pageSize: claimsPageSize,
        rows: cached.claims?.length || 0,
      })
      return
    }

    try {
      setClaimsPageLoading(true)
      const result = await getNhisClaimsPage({
        ...filters,
        page,
        pageSize: claimsPageSize,
        includeTotal: shouldLoadTotal,
      })
      setClaims(result.claims || [])
      if (result.total != null) {
        setClaimsTotal(Number(result.total || 0))
      }
      // The page RPC already computes per-status counts scoped to the same
      // status/date/search filters as the claims it returns (see
      // get_nhis_claims_page), so the tab badges above the list always match
      // what clicking them will actually show. Falls back to whatever stats
      // are already in state (the all-time load from loadAll) when this
      // particular fetch didn't request/receive them — e.g. issue-filter
      // browsing, which uses a different query path with no stats attached.
      if (result.stats) {
        setStats(result.stats)
      }
      setClaimsPage(result.page || page)
      claimsFilterKeyRef.current = filterKey
      claimsPageCacheRef.current.set(pageKey, {
        claims: result.claims || [],
        total: result.total,
        stats: result.stats || null,
        page: result.page || page,
        cachedAt: now,
      })
      logPerformance('nhis.claims.page', startedAt, role, {
        page: result.page || page,
        pageSize: claimsPageSize,
        rows: result.claims?.length || 0,
        counted: result.total != null,
      })
    } catch (err) {
      setError(err.message || 'Unable to load NHIS claims.')
    } finally {
      setClaimsPageLoading(false)
    }
  }, [claimsPageSize, getClaimServerFilters, role])

  const loadClaimIssueCounts = useCallback(async () => {
    if (!isSupabaseConfigured()) {
      setClaimIssueCounts({ all: 0 })
      return
    }

    if (claimIssueCountsLoadPromiseRef.current) {
      return claimIssueCountsLoadPromiseRef.current
    }

    try {
      setClaimIssueCountsLoading(true)
      const countRequest = getNhisClaimIssueCounts({
        ...getClaimServerFilters(),
        organizationType,
        issueCountMaxRows: NHIS_CLAIM_ISSUE_BADGE_SCAN_LIMIT,
      })
      claimIssueCountsLoadPromiseRef.current = countRequest
      const counts = await countRequest
      setClaimIssueCounts(counts || { all: 0 })
    } catch (countError) {
      console.warn('[NHIS] Claim issue counts could not be loaded.', {
        code: countError?.code || null,
        message: countError?.message || String(countError),
        details: countError?.details || null,
        hint: countError?.hint || null,
      })
      setClaimIssueCounts({ all: 0 })
    } finally {
      claimIssueCountsLoadPromiseRef.current = null
      setClaimIssueCountsLoading(false)
    }
  }, [getClaimServerFilters, organizationType])

  // ── load data ────────────────────────────────────────────────
  const ensurePatientIndexLoaded = useCallback(async () => {
    if (patientIndexLoadedRef.current) return []
    if (!patientIndexLoadPromiseRef.current) {
      patientIndexLoadPromiseRef.current = getAllPatients()
        .catch((patientLoadError) => {
          console.warn('[NHIS] Patient index could not be preloaded.', patientLoadError)
          return []
        })
        .finally(() => {
          patientIndexLoadPromiseRef.current = null
        })
    }

    const loadedPatients = await patientIndexLoadPromiseRef.current
    setPatients(loadedPatients || [])
    patientIndexLoadedRef.current = true
    return loadedPatients || []
  }, [])

  const loadPrescribingRecords = useCallback(async () => {
    try {
      setPrescribingRecordsLoading(true)
      const [facilityRows, prescriberRows] = await Promise.all([
        listNhisPrescribingFacilities({ status: 'all', limit: 1000 }),
        listNhisPrescribers({ status: 'all', limit: 1000 }),
      ])
      setPrescribingFacilities((facilityRows || []).filter(isValidPrescribingFacilityRecord))
      setPrescribers((prescriberRows || []).filter(isValidPrescriberRecord))
    } catch (recordsError) {
      console.warn('[NHIS] Prescriber/facility records could not be loaded.', recordsError)
      notify(recordsError.message || 'Unable to load NHIS prescriber records.', 'warning')
    } finally {
      setPrescribingRecordsLoading(false)
    }
  }, [notify])

  const loadAll = useCallback(async () => {
    if (!isSupabaseConfigured()) {
      setError('HealthFlow Cloud is not configured.')
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      setError('')
      const [drugsData, statsData, rulesData, tariffData] = await Promise.all([
        getAllNhisDrugs(),
        getNhisClaimStats(),
        getAllNhisClinicalRules(),
        getAllNhiaTariffItems({
          facilityGroup: activeTariffFacilityGroup,
          cateringOption: activeTariffCateringOption,
        }),
      ])

      let readyDrugsData = drugsData
      if (
        canWrite &&
        drugsData.length === 0 &&
        DEFAULT_NHIS_DRUG_CATALOG.length > 0 &&
        organization?.can_use_nhis !== false
      ) {
        try {
          setCatalogSeeding(true)
          await upsertNhisDrugs(DEFAULT_NHIS_DRUG_CATALOG, { syncInventory: false })
          readyDrugsData = await getAllNhisDrugs()
          notify(`Loaded ${readyDrugsData.length} default NHIS medicines into this facility.`, 'success')
        } catch (seedError) {
          notify(
            seedError.message || 'NHIS medicine catalog is empty. Import the NHIS drug template before adding medicines.',
            'warning'
          )
        } finally {
          setCatalogSeeding(false)
        }
      }

      setNhisDrugs(readyDrugsData)
      setStats(statsData)
      setClinicalRules(rulesData)
      setNhiaTariffItems(tariffData)
      void ensurePatientIndexLoaded()
      void loadPrescribingRecords()
    } catch (err) {
      setError(err.message || 'Unable to load NHIS data.')
    } finally {
      setLoading(false)
    }
  }, [canWrite, notify, organization?.can_use_nhis, isHospital, activeTariffFacilityGroup, activeTariffCateringOption, ensurePatientIndexLoaded, loadPrescribingRecords])

  const refreshClaimsOverview = useCallback(async () => {
    if (!isSupabaseConfigured()) {
      setError('HealthFlow Cloud is not configured.')
      return
    }
    try {
      setError('')
      const statsData = await getNhisClaimStats()
      claimsPageCacheRef.current.clear()
      await loadClaimsPage(claimsPage, { force: true, refreshTotal: true })
      void loadClaimIssueCounts()
      setStats(statsData)
    } catch (err) {
      setError(err.message || 'Unable to refresh NHIS claims.')
    }
  }, [claimsPage, loadClaimIssueCounts, loadClaimsPage])

  const filteredPrescribingFacilities = useMemo(() => {
    const term = normalizeText(facilitySearch).toLowerCase()
    const validFacilities = prescribingFacilities.filter((facility) => facility && facility.id)
    if (!term) return validFacilities
    return validFacilities.filter((facility) =>
      [
        facility.facility_name,
        facility.nhia_facility_code,
        facility.provider_number,
        facility.facility_type,
        facility.region,
        facility.district,
        facility.town,
      ].some((value) => normalizeText(value).toLowerCase().includes(term))
    )
  }, [facilitySearch, prescribingFacilities])

  const filteredPrescribers = useMemo(() => {
    const term = normalizeText(prescriberSearch).toLowerCase()
    const validPrescribers = prescribers.filter((prescriber) => prescriber && prescriber.id)
    if (!term) return validPrescribers
    return validPrescribers.filter((prescriber) =>
      [
        prescriber.full_name,
        prescriber.license_number,
        prescriber.professional_type,
        prescriber.specialty,
        prescriber.phone,
      ].some((value) => normalizeText(value).toLowerCase().includes(term))
    )
  }, [prescriberSearch, prescribers])

  const claimFacilityOptions = useMemo(
    () => prescribingFacilities.filter((facility) =>
      isValidPrescribingFacilityRecord(facility) &&
      normalizeText(facility.status).toLowerCase() !== 'inactive'
    ),
    [prescribingFacilities]
  )

  const claimPrescriberOptions = useMemo(
    () => prescribers.filter((prescriber) =>
      isValidPrescriberRecord(prescriber) &&
      normalizeText(prescriber.status).toLowerCase() !== 'inactive'
    ),
    [prescribers]
  )

  const getRecordOptions = () => ({
    organizationId,
    branchId: profile?.branch_id || branch?.id || null,
    userId: user?.id || null,
  })

  const handleSelectPrescribingFacility = (facilityId) => {
    const facility = prescribingFacilities.find((row) => row.id === facilityId) || null
    setClaimForm((previous) => ({
      ...previous,
      ...buildNhisPrescriptionSourceSnapshot({
        facility,
        prescriber: prescribers.find((row) => row.id === previous.prescriberId) || null,
      }),
      prescribingFacilityId: facility?.id || '',
    }))
  }

  const handleSelectPrescriber = (prescriberId) => {
    const prescriber = prescribers.find((row) => row.id === prescriberId) || null
    const facility = prescribingFacilities.find((row) => row.id === claimForm.prescribingFacilityId) ||
      prescribingFacilities.find((row) => row.id === prescriber?.primary_facility_id) ||
      null
    setClaimForm((previous) => ({
      ...previous,
      ...buildNhisPrescriptionSourceSnapshot({ facility, prescriber }),
      prescriberId: prescriber?.id || '',
      prescribingFacilityId: facility?.id || previous.prescribingFacilityId || '',
    }))
  }

  const findMatchingPrescribingFacility = (value) => {
    const term = normalizeText(value).toLowerCase()
    if (!term) return null
    return claimFacilityOptions.find((facility) => {
      const name = getNhisPrescribingFacilityDisplayName(facility).toLowerCase()
      const code = normalizeText(facility.nhia_facility_code ?? facility.nhiaFacilityCode).toLowerCase()
      return term === name || (code && term === code) || (code && term === `${name} - ${code}`)
    }) || null
  }

  const findMatchingPrescriber = (value) => {
    const term = normalizeText(value).toLowerCase()
    if (!term) return null
    return claimPrescriberOptions.find((prescriber) => {
      const displayName = getNhisPrescriberDisplayName(prescriber).toLowerCase()
      const fullName = normalizeText(prescriber.full_name ?? prescriber.fullName).toLowerCase()
      const license = normalizeText(prescriber.license_number ?? prescriber.licenseNumber).toLowerCase()
      return term === displayName || term === fullName || (license && term === license)
    }) || null
  }

  const handlePrescribingFacilityTextChange = (value) => {
    const facility = findMatchingPrescribingFacility(value)
    if (facility) {
      handleSelectPrescribingFacility(facility.id)
      return
    }
    setClaimForm((previous) => ({
      ...previous,
      referringFacility: value,
      prescribingFacilityId: '',
      prescribing_facility_id: null,
      prescribingFacilityNameSnapshot: value,
      prescribing_facility_name_snapshot: normalizeText(value) || null,
      prescribingFacilityCodeSnapshot: '',
      prescribing_facility_code_snapshot: null,
    }))
  }

  const handlePrescriberTextChange = (value) => {
    const prescriber = findMatchingPrescriber(value)
    if (prescriber) {
      handleSelectPrescriber(prescriber.id)
      return
    }
    setClaimForm((previous) => ({
      ...previous,
      physicianName: value,
      prescriberId: '',
      prescriber_id: null,
      prescriberNameSnapshot: value,
      prescriber_name_snapshot: normalizeText(value) || null,
      prescriberLicenseSnapshot: '',
      prescriber_license_snapshot: null,
    }))
  }

  const handleCreatePrescribingFacility = async (event) => {
    event.preventDefault()
    try {
      setFacilitySubmitting(true)
      const saved = await createNhisPrescribingFacility(facilityForm, getRecordOptions())
      setPrescribingFacilities((previous) =>
        [saved, ...previous.filter((row) => row && row.id !== saved?.id)]
          .filter(isValidPrescribingFacilityRecord)
      )
      setFacilityForm(BLANK_NHIS_PRESCRIBING_FACILITY)
      notify('Prescribing facility saved.', 'success')
    } catch (submitError) {
      notify(submitError.message || 'Unable to save prescribing facility.', 'error')
    } finally {
      setFacilitySubmitting(false)
    }
  }

  const handleCreatePrescriber = async (event) => {
    event.preventDefault()
    try {
      setPrescriberSubmitting(true)
      const saved = await createNhisPrescriber(prescriberForm, getRecordOptions())
      setPrescribers((previous) =>
        [saved, ...previous.filter((row) => row && row.id !== saved?.id)]
          .filter(isValidPrescriberRecord)
      )
      setPrescriberForm(BLANK_NHIS_PRESCRIBER)
      notify('Prescriber saved.', 'success')
    } catch (submitError) {
      notify(submitError.message || 'Unable to save prescriber.', 'error')
    } finally {
      setPrescriberSubmitting(false)
    }
  }

  const handleDeactivatePrescribingFacility = async (facility) => {
    try {
      const saved = await deactivateNhisPrescribingFacility(facility.id, {
        ...getRecordOptions(),
        record: facility,
      })
      setPrescribingFacilities((previous) =>
        previous
          .map((row) => row?.id === saved?.id ? saved : row)
          .filter(isValidPrescribingFacilityRecord)
      )
      notify('Prescribing facility deactivated.', 'success')
    } catch (submitError) {
      notify(submitError.message || 'Unable to deactivate prescribing facility.', 'error')
    }
  }

  const handleDeactivatePrescriber = async (prescriber) => {
    try {
      const saved = await deactivateNhisPrescriber(prescriber.id, {
        ...getRecordOptions(),
        record: prescriber,
      })
      setPrescribers((previous) =>
        previous
          .map((row) => row?.id === saved?.id ? saved : row)
          .filter(isValidPrescriberRecord)
      )
      notify('Prescriber deactivated.', 'success')
    } catch (submitError) {
      notify(submitError.message || 'Unable to deactivate prescriber.', 'error')
    }
  }

  const ensureInventoryDrugsLoaded = useCallback(async () => {
    if (inventoryDrugs.length > 0) return inventoryDrugs
    if (!inventoryDrugsLoadPromiseRef.current) {
      inventoryDrugsLoadPromiseRef.current = getAllDrugs({ includeCatalog: true, preferDirectRead: true })
        .catch((inventoryLoadError) => {
          console.warn('[NHIS] Inventory catalog could not be preloaded.', inventoryLoadError)
          return []
        })
        .finally(() => {
          inventoryDrugsLoadPromiseRef.current = null
        })
    }

    const loadedInventoryDrugs = await inventoryDrugsLoadPromiseRef.current
    setInventoryDrugs(loadedInventoryDrugs || [])
    return loadedInventoryDrugs || []
  }, [inventoryDrugs])

  const hydrateClaimForAction = useCallback(async (claim) => {
    if (!claim?._summaryOnly) return claim
    const fullClaim = await getNhisClaimForSubmission(claim.id)
    const hydrated = { ...claim, ...fullClaim, _summaryOnly: false }
    setClaims((current) => current.map((row) => (row.id === hydrated.id ? hydrated : row)))
    return hydrated
  }, [])

  useEffect(() => { void loadAll() }, [loadAll])

  useEffect(() => {
    void loadClaimsPage(claimsPage)
  }, [claimsPage, loadClaimsPage])

  useEffect(() => {
    void loadClaimIssueCounts()
  }, [loadClaimIssueCounts])

  useEffect(() => startClaimItBridgeQueueAutoSync({
    onSynced: (result) => {
      void refreshClaimsOverview()
      notify(`${result.submitted} queued CLAIM-it claim${result.submitted === 1 ? '' : 's'} submitted.`, 'success')
    },
  }), [notify, refreshClaimsOverview])

  const refreshDirectNhiaApiStatus = useCallback(async () => {
    try {
      setNhiaSettingsLoading(true)
      const settings = await getNhiaApiSettings({ organizationId })
      setDirectNhiaSettings(settings || null)
    } catch {
      setDirectNhiaSettings(null)
    } finally {
      setNhiaSettingsLoading(false)
    }
  }, [organizationId])

  useEffect(() => { void refreshDirectNhiaApiStatus() }, [refreshDirectNhiaApiStatus])

  useEffect(() => {
    let cancelled = false
    setFacilitySettingsLoading(true)
    getPharmacySettings()
      .then((settings) => {
        if (!cancelled) setFacilitySettings(settings || null)
      })
      .catch(() => {
        if (!cancelled) setFacilitySettings(null)
      })
      .finally(() => {
        if (!cancelled) setFacilitySettingsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ── filtered claims ──────────────────────────────────────────
  const claimDateRange = useMemo(() => {
    const today = todayIsoDate()
    if (claimDateFilter === 'today') return { from: today, to: today }
    if (claimDateFilter === 'week') return { from: weekStartIsoDate(), to: today }
    if (claimDateFilter === 'month') return { from: monthStartIsoDate(), to: today }
    if (claimDateFilter === 'previous_month') return previousMonthRange()
    if (claimDateFilter === 'custom') return { from: claimFromDate, to: claimToDate }
    return { from: '', to: '' }
  }, [claimDateFilter, claimFromDate, claimToDate])

  const carriedOverClaims = useMemo(() => {
    const currentMonthStart = monthStartIsoDate()
    return claims.filter((claim) => {
      const serviceDate = getClaimServiceDateKey(claim)
      return OPEN_CLAIM_STATUSES.has(claim.status) && serviceDate && serviceDate < currentMonthStart
    })
  }, [claims])

  const carriedOverStats = useMemo(() => {
    const totalAmount = carriedOverClaims.reduce((sum, claim) => sum + (Number(claim.total_amount) || 0), 0)
    const oldestDate = carriedOverClaims
      .map(getClaimServiceDateKey)
      .filter(Boolean)
      .sort()[0] || ''
    return {
      count: carriedOverClaims.length,
      totalAmount,
      oldestDate,
      oldestAgeDays: getClaimAgeDays(oldestDate),
    }
  }, [carriedOverClaims])

  const filteredClaims = useMemo(() => {
    const term = debouncedClaimSearch.trim().toLowerCase()
    return claims.filter((c) => {
      if (isMedicineCounterAssistant && c.status === 'draft') return false
      if (claimTab !== 'all' && c.status !== claimTab) return false
      if (claimIssueFilter === 'any' && getNhisClaimIssueBadges(c).length === 0) return false
      if (claimIssueFilter !== 'all' && claimIssueFilter !== 'any' && !getNhisClaimIssueBadges(c).some((badge) => badge.key === claimIssueFilter)) return false
      if (claimDateFilter === 'open') {
        if (!OPEN_CLAIM_STATUSES.has(c.status)) return false
      } else {
        const serviceDate = getClaimServiceDateKey(c)
        if (claimDateRange.from && (!serviceDate || serviceDate < claimDateRange.from)) return false
        if (claimDateRange.to && (!serviceDate || serviceDate > claimDateRange.to)) return false
      }
      if (!term) return true
      const surname = (c.surname || '').toLowerCase()
      const otherNames = (c.other_names || '').toLowerCase()
      const fullName = [surname, otherNames].filter(Boolean).join(' ')
      const reverseFullName = [otherNames, surname].filter(Boolean).join(' ')
      return (
        surname.includes(term) ||
        otherNames.includes(term) ||
        fullName.includes(term) ||
        reverseFullName.includes(term) ||
        (c.member_no     || '').toLowerCase().includes(term) ||
        (c.claim_number  || '').toLowerCase().includes(term) ||
        (c.hin           || '').toLowerCase().includes(term) ||
        (c.prescription_reference || '').toLowerCase().includes(term) ||
        (c.prescriber_name_snapshot || '').toLowerCase().includes(term) ||
        (c.physician_name || '').toLowerCase().includes(term) ||
        (c.prescribing_facility_name_snapshot || '').toLowerCase().includes(term) ||
        (c.referring_facility || '').toLowerCase().includes(term) ||
        (c.prescription_entry_user_name || '').toLowerCase().includes(term) ||
        (c.prescription_update_user_name || '').toLowerCase().includes(term)
      )
    })
  }, [claims, claimTab, claimIssueFilter, debouncedClaimSearch, claimDateFilter, claimDateRange, isMedicineCounterAssistant])

  const activeClaimIssueFilter = CLAIM_ISSUE_FILTERS.find((filter) => filter.id === claimIssueFilter)
  const activeClaimIssueCount = claimIssueFilter === 'all'
    ? claimIssueCounts.all || 0
    : claimIssueFilter === 'any'
      ? claimIssueCounts.all || 0
      : claimIssueCounts[claimIssueFilter] || 0
  const claimViewReadinessLabel = useMemo(() => {
    if (claimDateFilter === 'open') return 'All open claims'
    if (claimDateFilter === 'all') return 'All dates'
    if (claimDateRange.from && claimDateRange.to && claimDateRange.from === claimDateRange.to) {
      return formatAppDate(claimDateRange.from)
    }
    if (claimDateRange.from && claimDateRange.to) {
      return `${formatAppDate(claimDateRange.from)} to ${formatAppDate(claimDateRange.to)}`
    }
    if (claimDateRange.from) return `From ${formatAppDate(claimDateRange.from)}`
    if (claimDateRange.to) return `Up to ${formatAppDate(claimDateRange.to)}`
    return 'Current filters'
  }, [claimDateFilter, claimDateRange])

  const claimViewReadinessItems = useMemo(() => ([
    {
      key: 'missing-attachment',
      label: 'Missing prescription',
      count: claimIssueCounts['missing-attachment'] || 0,
      tone: 'danger',
    },
    {
      key: 'attachment-type',
      label: 'Set attachment type',
      count: claimIssueCounts['attachment-type'] || 0,
      tone: 'warning',
    },
    {
      key: 'unverified-prescription',
      label: 'Unverified prescription',
      count: claimIssueCounts['unverified-prescription'] || 0,
      tone: 'warning',
    },
    {
      key: 'incomplete-intake',
      label: 'Incomplete intake',
      count: claimIssueCounts['incomplete-intake'] || 0,
      tone: 'info',
    },
  ]), [claimIssueCounts])

  const openFirstClaimIssue = async (issueFilterOverride = '') => {
    if (openingFirstClaimIssue) return
    const selectedIssueFilter = issueFilterOverride || claimIssueFilter
    const issueFilter = selectedIssueFilter === 'all' ? 'any' : selectedIssueFilter

    try {
      setOpeningFirstClaimIssue(true)
      const result = await getNhisClaimsPage({
        ...getClaimServerFilters({ includeIssueFilter: false }),
        issueFilter,
        page: 1,
        pageSize: 1,
        includeTotal: false,
      })
      const firstIssueClaim = result.claims?.[0]
      if (!firstIssueClaim) {
        notify('No matching NHIS claim issue was found for the current filters.', 'info')
        await loadClaimIssueCounts({ force: true })
        return
      }
      await openEditClaim(firstIssueClaim)
    } catch (err) {
      notify(err.message || 'Unable to open the first NHIS claim issue.', 'error')
    } finally {
      setOpeningFirstClaimIssue(false)
    }
  }

  const reviewClaimIssueFilter = async (issueFilter) => {
    setClaimsPage(1)
    setClaimIssueFilter(issueFilter)
    await openFirstClaimIssue(issueFilter)
  }

  const claimsTotalPages = Math.max(1, Math.ceil(claimsTotal / claimsPageSize))
  const claimsShowingFrom = claimsTotal === 0 ? 0 : ((claimsPage - 1) * claimsPageSize) + 1
  const claimsShowingTo = Math.min(claimsPage * claimsPageSize, claimsTotal)
  const goToClaimsPage = (page) => {
    const nextPage = Math.min(claimsTotalPages, Math.max(1, Number(page) || 1))
    if (nextPage === claimsPage) return
    setClaimsPage(nextPage)
    window.requestAnimationFrame(() => {
      claimsTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const renderClaimsPagination = (placement) => (
    <div className={`nhis-pagination nhis-pagination--${placement}`}>
      <span>
        Showing {claimsShowingFrom}-{claimsShowingTo} of {claimsTotal} claim{claimsTotal === 1 ? '' : 's'}
      </span>
      <div className="nhis-pagination-actions">
        <label className="nhis-page-size">
          <span>Rows</span>
          <select
            value={claimsPageSize}
            onChange={(event) => {
              claimsPageCacheRef.current.clear()
              setClaimsPage(1)
              setClaimsPageSize(Number(event.target.value) || NHIS_CLAIMS_DEFAULT_PAGE_SIZE)
            }}
            disabled={claimsPageLoading}
            aria-label={`Claims per page (${placement})`}
          >
            {NHIS_CLAIMS_PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={claimsPageLoading || claimsPage <= 1}
          onClick={() => goToClaimsPage(claimsPage - 1)}
        >
          Previous
        </button>
        <span>Page {claimsPage} of {claimsTotalPages}</span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={claimsPageLoading || claimsPage >= claimsTotalPages}
          onClick={() => goToClaimsPage(claimsPage + 1)}
        >
          Next
        </button>
      </div>
    </div>
  )
  const canServeClaimDirectly = canNhisClaimBeServedDirectly({
    claim: editingClaim,
    role: privilegedNhisActionRole,
  })

  const allNhisPatients = useMemo(() => {
    const merged = new Map()
    const addPatient = (patient) => {
      const key = nhisPatientListKey(patient)
      if (!key) return
      merged.set(key, mergeNhisPatientRecord(merged.get(key), patient))
    }

    patients
      .filter(isNhisPatientRecord)
      .forEach(addPatient)

    claims
      .map(claimToPatientSearchResult)
      .filter(isNhisPatientRecord)
      .forEach(addPatient)

    return [...merged.values()].sort((left, right) =>
      formatPatientLookupName(left).localeCompare(formatPatientLookupName(right))
    )
  }, [claims, patients])

  const visibleNhisPatients = useMemo(() => {
    const term = debouncedClaimSearch.trim().toLowerCase()
    return allNhisPatients.filter((patient) => {
      if (!term) return true
      return (
        lookupMatches(formatPatientLookupName(patient), term) ||
        lookupMatches(getPatientMemberNumber(patient), term) ||
        lookupMatches(getPatientHin(patient), term) ||
        lookupMatches(getPatientFolderNo(patient), term) ||
        lookupMatches(getPatientPhone(patient), term)
      )
    })
  }, [allNhisPatients, debouncedClaimSearch])

  const filteredNhisPatients = useMemo(() => {
    const term = nhisPatientSearch.trim().toLowerCase()
    return allNhisPatients.filter((patient) => {
      if (!term) return true
      return (
        lookupMatches(formatPatientLookupName(patient), term) ||
        lookupMatches(getPatientMemberNumber(patient), term) ||
        lookupMatches(getPatientHin(patient), term) ||
        lookupMatches(getPatientFolderNo(patient), term) ||
        lookupMatches(getPatientPhone(patient), term) ||
        lookupMatches(getPatientAddress(patient), term)
      )
    })
  }, [allNhisPatients, nhisPatientSearch])

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

  // ── patient matches for claim form ───────────────────────────
  const localPatientMatches = useMemo(() => {
    const term = patientSearch.trim().toLowerCase()
    if (!term) return []
    return patients
      .filter(
        (p) =>
          lookupMatches(p.full_name, term) ||
          lookupMatches(p.fullName, term) ||
          lookupMatches(p.phone, term) ||
          lookupMatches(p.mobile, term) ||
          lookupMatches(getPatientMemberNumber(p), term) ||
          lookupMatches(getPatientHin(p), term) ||
          lookupMatches(getPatientFolderNo(p), term)
      )
  }, [patients, patientSearch])

  const priorClaimPatientMatches = useMemo(() => {
    const term = patientSearch.trim().toLowerCase()
    if (!term) return []
    const merged = new Map()
    claims
      .filter((claim) =>
        lookupMatches([claim.surname, claim.other_names].filter(Boolean).join(' '), term) ||
        lookupMatches(claim.member_no, term) ||
        lookupMatches(claim.hin, term) ||
        lookupMatches(claim.folder_no, term)
      )
      .forEach((claim) => {
        const result = claimToPatientSearchResult(claim)
        const key = patientSearchKey(result)
        if (key && !merged.has(key)) merged.set(key, result)
      })
    return [...merged.values()]
  }, [claims, patientSearch])

  useEffect(() => {
    const term = patientSearch.trim()
    if (!showNewClaimModal || selectedClaimPatient || term.length < 2) {
      setPatientSearchResults([])
      setPatientSearchError('')
      setPatientSearching(false)
      return undefined
    }

    let cancelled = false
    setPatientSearching(true)
    setPatientSearchError('')
    const timer = setTimeout(async () => {
      try {
        const remoteMatches = await searchPatients(term)
        if (!cancelled) {
          setPatientSearchResults(remoteMatches || [])
          setPatientSearchError('')
        }
      } catch (err) {
        console.warn('NHIS patient search failed:', err)
        if (!cancelled) {
          setPatientSearchResults([])
          setPatientSearchError(getErrorMessage(err) || 'Patient search failed on the local branch server.')
        }
      } finally {
        if (!cancelled) setPatientSearching(false)
      }
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [patientSearch, selectedClaimPatient, showNewClaimModal])

  const filteredPatients = useMemo(() => {
    const merged = new Map()
    ;[...patientSearchResults, ...localPatientMatches, ...priorClaimPatientMatches]
      .filter((patient) => patient?.full_name || patient?.nhis_member_no || patient?.insurance_id || patient?.nhis_hin)
      .forEach((patient) => {
        const key = patientSearchKey(patient)
        if (!key) return
        const existing = merged.get(key)
        merged.set(key, existing
          ? {
              ...patient,
              ...existing,
              folder_no: existing.folder_no || patient.folder_no || '',
              sourceClaimNumber: existing.sourceClaimNumber || patient.sourceClaimNumber || '',
              patient_id: existing.patient_id || patient.patient_id || '',
            }
          : patient)
      })
    return [...merged.values()].slice(0, 10)
  }, [patientSearchResults, localPatientMatches, priorClaimPatientMatches])

  const filteredTariffItems = useMemo(() => {
    const term = tariffSearch.trim().toLowerCase()
    if (!term) return []
    return applicableTariffItems
      .filter((item) => {
        return (
          lookupMatches(item.gdrg_code, term) ||
          lookupMatches(item.description, term) ||
          lookupMatches(item.mdc, term) ||
          lookupMatches(item.facility_group, term)
        )
      })
      .slice(0, 10)
  }, [applicableTariffItems, tariffSearch])

  const filteredTariffCatalog = useMemo(() => {
    const term = tariffCatalogSearch.trim().toLowerCase()
    const rows = applicableTariffItems.filter((item) => {
      if (!term) return true
      return (
        lookupMatches(item.gdrg_code, term) ||
        lookupMatches(item.description, term) ||
        lookupMatches(item.mdc, term) ||
        lookupMatches(item.facility_group, term) ||
        lookupMatches(item.catering_option, term) ||
        lookupMatches(item.age_band, term)
      )
    })
    return rows.slice(0, 500)
  }, [applicableTariffItems, tariffCatalogSearch])

  const integrationMode = resolvedNhiaSettings?.integrationMode || resolvedNhiaSettings?.integration_mode || 'claimit_export'
  const validationMode = resolvedNhiaSettings?.validationMode || resolvedNhiaSettings?.validation_mode || 'validate_before_submit'
  const claimControlMode = resolvedNhiaSettings?.claimControlMode || resolvedNhiaSettings?.claim_control_mode || (integrationMode === 'claimit_bridge' ? 'claimit_bridge' : 'manual')
  const ccEndpointPath = resolvedNhiaSettings?.ccEndpointPath ||
    resolvedNhiaSettings?.cc_endpoint_path ||
    resolvedNhiaSettings?.ccCodeEndpointPath ||
    resolvedNhiaSettings?.cc_code_endpoint_path ||
    ''
  const isClaimItBridgeMode = integrationMode === 'claimit_bridge'
  const usesClaimItValidationFlow = isClaimItBridgeMode ||
    integrationMode === 'claimit_export' ||
    integrationMode === 'claimit_local_bridge' ||
    validationMode === 'validate_before_submit' ||
    validationMode === 'claimit_local_bridge' ||
    claimControlMode === 'claimit_bridge_ccc'
  const nhiaApiBaseUrl = resolvedNhiaSettings?.apiBaseUrl ||
    resolvedNhiaSettings?.api_base_url ||
    ''
  const claimItSubmitBaseUrl = resolvedNhiaSettings?.claimitSubmitBaseUrl ||
    resolvedNhiaSettings?.claimit_submit_base_url ||
    resolvedNhiaSettings?.productionBaseUrl ||
    resolvedNhiaSettings?.production_base_url ||
    resolvedNhiaSettings?.sandboxBaseUrl ||
    resolvedNhiaSettings?.sandbox_base_url ||
    ''
  const claimSubmissionBaseUrl = isClaimItBridgeMode ? claimItSubmitBaseUrl : nhiaApiBaseUrl
  const isLocalClaimItBridgeProfile = ['local_server', 'lan_ip'].includes(
    resolvedNhiaSettings?.connectionProfile || resolvedNhiaSettings?.connection_profile || 'local_server'
  )
  const isLocalClaimItBridgeUrl = isLocalClaimItBridgeBaseUrl(claimSubmissionBaseUrl)
  const isHostedPageWithLocalClaimItBridge = usesClaimItValidationFlow &&
    isLocalClaimItBridgeProfile &&
    isLocalClaimItBridgeUrl &&
    !isLocalAppOrigin()
  const canManuallyEditCcCode = role === 'admin' || role === 'super_admin'
  const allowsDirectNhiaSubmission = ['claimit_bridge', 'direct_nhia_api', 'hybrid'].includes(integrationMode)
  const directNhiaApiAvailable = Boolean(
    allowsDirectNhiaSubmission &&
      resolvedNhiaSettings?.directApiEnabled &&
      !isHostedPageWithLocalClaimItBridge &&
      claimSubmissionBaseUrl &&
      resolvedNhiaSettings?.claimEndpointPath
  )
  const memberLookupEndpointPath = resolvedNhiaSettings?.memberLookupEndpointPath ||
    resolvedNhiaSettings?.member_lookup_endpoint_path || ''
  const isBranchNhiaConfigSource = ['local_branch_server', 'local_cache'].includes(
    resolvedNhiaSettings?.configSource || resolvedNhiaSettings?.source
  )
  const isBranchServerEnabled = shouldUseBranchServer()
  const shouldUseOfflineNhiaUrl = isBranchServerEnabled
  const effectiveMemberLookupEndpointPath = memberLookupEndpointPath ||
    (isBranchServerEnabled || isBranchNhiaConfigSource ? '/api/hmis/genCCC' : '')
  const nhiaCcCodeApiAvailable = Boolean(
    (resolvedNhiaSettings?.directApiEnabled ||
      integrationMode === 'claimit_assisted' ||
      ['claimit_bridge', 'claimit_bridge_ccc', 'direct_api'].includes(claimControlMode)) &&
      (nhiaApiBaseUrl || isBranchServerEnabled || isBranchNhiaConfigSource) &&
      effectiveMemberLookupEndpointPath
  )
  const canGenerateNhiaCcCode = Boolean(nhiaCcCodeApiAvailable && integrationMode !== 'claimit_export')
  const nhisPageSubtitle = isHospital
    ? 'NHIA hospital service claims, tariffs, diagnoses, and direct CLAIM-it submission'
    : 'NHIS medicine dispensing claims and catalog workflows for community and hospital pharmacies'

  const hasMedicineSearchTerm = medCodeSearch.trim().length > 0
  // ✅ NHIS PHARMACY LEVEL PATCH START
  const facilityPharmacyLevel = getEffectivePharmacyLevel(organization, resolvedNhiaSettings)
  // ✅ NHIS PHARMACY LEVEL PATCH END

  const configReview = useMemo(() => {
    const apiIssues = []
    const apiWarnings = []
    const isPharmacyWorkflow = organizationType !== 'hospital'
    if (isPharmacyWorkflow && !facilityPharmacyLevel) apiIssues.push('Pharmacy/facility level is not configured.')
    if (!providerClassLevel) apiIssues.push('NHIA provider class/level is not configured.')
    if (!hasNhiaFacilitySettings(resolvedNhiaSettings)) {
      apiWarnings.push('NHIA API settings are not configured; CLAIM-it export remains available.')
    } else {
      if (!resolvedNhiaSettings.facilityCode && !resolvedNhiaSettings.facility_code) apiIssues.push('NHIA facility code is missing.')
      if (!resolvedNhiaSettings.providerNumber && !resolvedNhiaSettings.provider_number) apiIssues.push('NHIA provider number is missing.')
      if (resolvedNhiaSettings.directApiEnabled) {
        if (isClaimItBridgeMode && !claimItSubmitBaseUrl) apiIssues.push('CLAIM-it submit base URL is missing.')
        if (!isClaimItBridgeMode && !nhiaApiBaseUrl) apiIssues.push('Direct NHIA API base URL is missing.')
        if (!resolvedNhiaSettings.claimEndpointPath && !resolvedNhiaSettings.claim_endpoint_path) apiIssues.push('Claim submission endpoint path is missing.')
      } else {
        apiWarnings.push('Direct API is off; use CLAIM-it export/import.')
      }
    }

    const reviewMedicine = (medicine, source) => {
      const accessLevel = medicine.medicine_access_level || medicine.medicineAccessLevel || ''
      const requiredLevel = medicine.required_pharmacy_level || medicine.requiredPharmacyLevel || ''
      const prescribingLevel = medicine.category || medicine.nhis_category || ''
      const levelCheck = assessMedicinePharmacyLevel(medicine, facilityPharmacyLevel)
      const issues = []
      const warnings = []
      if (facilityPharmacyLevel !== 'P1' && !accessLevel && !requiredLevel) warnings.push('Level not configured.')
      if (!prescribingLevel && source === 'NHIS catalog') warnings.push('NHIS prescribing level is missing.')
      if (!levelCheck.allowed) issues.push(levelCheck.message)
      return {
        id: `${source}-${medicine.id || medicine.code || medicine.nhis_code || medicine.name}`,
        source,
        code: medicine.code || medicine.nhis_code || '',
        name: medicine.description || medicine.name || medicine.generic_name || '',
        accessLevel,
        requiredLevel,
        prescribingLevel,
        issues,
        warnings,
        status: issues.length ? 'Blocked' : warnings.length ? 'Needs config' : 'Ready',
      }
    }

    const catalogRows = isPharmacyWorkflow ? nhisDrugs.map((drug) => reviewMedicine(drug, 'NHIS catalog')) : []
    const inventoryRows = isPharmacyWorkflow
      ? inventoryDrugs
          .filter((drug) => drug.is_nhis_listed || drug.nhis_code || drug.medicine_access_level || drug.required_pharmacy_level)
          .map((drug) => reviewMedicine(drug, 'Inventory'))
      : []

    const claimRows = claims.map((claim) => {
      const readiness = assessNhisClaimReadiness(
        {
          ...claim,
          organizationType: claim.organization_type || organizationType,
          providerClassLevel,
        },
        claim.nhis_claim_medicines || [],
        {
          finalSubmission: true,
          providerClassLevel,
          pharmacyLevel: facilityPharmacyLevel,
          nhisDrugCatalog: nhisDrugs,
          nhiaTariffServices: claim.nhis_claim_services || [],
          currentNhiaTariffItems: nhiaTariffItems,
          // ✅ NHIS CLAIM LOGIC SEPARATION PATCH START
          tariffFacilityGroup: activeTariffFacilityGroup,
          tariffCateringOption: activeTariffCateringOption,
          // ✅ NHIS CLAIM LOGIC SEPARATION PATCH END
        }
      )
      return {
        id: claim.id,
        claimNumber: claim.claim_number,
        patient: `${claim.surname || ''} ${claim.other_names || ''}`.trim(),
        status: claim.status,
        blockers: readiness.blockers,
        warnings: readiness.warnings,
      }
    })

    const medicineRows = [...catalogRows, ...inventoryRows]
    return {
      apiIssues,
      apiWarnings,
      medicineRows,
      claimRows,
      summary: {
        configIssues: apiIssues.length,
        configWarnings: apiWarnings.length,
        medicinesTotal: medicineRows.length,
        medicinesBlocked: medicineRows.filter((row) => row.issues.length).length,
        medicinesNeedsConfig: medicineRows.filter((row) => !row.issues.length && row.warnings.length).length,
        claimsBlocked: claimRows.filter((row) => row.blockers.length).length,
        claimsWarnings: claimRows.filter((row) => !row.blockers.length && row.warnings.length).length,
      },
    }
  }, [
    claims,
    facilityPharmacyLevel,
    inventoryDrugs,
    nhisDrugs,
    nhiaTariffItems,
    organizationType,
    providerClassLevel,
    resolvedNhiaSettings,
    activeTariffFacilityGroup,
    activeTariffCateringOption,
  ])

  const getCatalogCategoryForMedicine = (medicine = {}) => {
    medicine = medicine || {}
    const code = String(medicine.drugCode || medicine.drug_code || '').trim().toUpperCase()
    const id = String(medicine.nhisDrugId || medicine.nhis_drug_id || '').trim()
    const match = nhisDrugs.find((drug) =>
      (code && String(drug.code || '').trim().toUpperCase() === code) ||
      (id && String(drug.id || '').trim() === id)
    )
    return match?.category || ''
  }

  const returnAlertSettings = useMemo(
    () => normalizeNhisReturnAlertSettings(facilitySettings || {}),
    [facilitySettings]
  )

  const getReturnAlertBranchLabel = (claim = {}) => {
    const label = normalizeText(
      claim.branch_name ||
        claim.branchName ||
        claim.branch?.name ||
        claim.facility_branch ||
        claim.facilityBranch
    )
    if (label) return label

    const claimBranchId = normalizeText(claim.branch_id || claim.branchId)
    if (claimBranchId && normalizeText(branch?.id) === claimBranchId) {
      return normalizeText(branch?.name || branch?.branch_name || branch?.code) || 'Current branch'
    }
    if (!claimBranchId || looksLikeUuid(claimBranchId)) return 'Recorded branch'
    return claimBranchId
  }

  const getReturnAlertUserLabel = (claim = {}) => {
    const label = normalizeText(
      claim.served_by_name ||
        claim.servedByName ||
        claim.created_by_name ||
        claim.createdByName ||
        claim.user_name ||
        claim.userName ||
        claim.created_by_email ||
        claim.createdByEmail
    )
    if (label) return label

    const userId = normalizeText(claim.served_by || claim.servedBy || claim.created_by || claim.createdBy)
    if (userId && normalizeText(user?.id) === userId) {
      return normalizeText(profile?.full_name || profile?.fullName || user?.email) || 'Current user'
    }
    if (!userId || looksLikeUuid(userId)) return 'Recorded user'
    return userId
  }

  const getCurrentPrescriptionActorLabel = () =>
    normalizeText(
      profile?.full_name ||
        profile?.fullName ||
        profile?.name ||
        user?.email ||
        user?.id
    )

  const hasPrescriptionTraceDetails = (form = claimForm, uploadedPrescription = {}) =>
    Boolean(
      normalizeText(form.prescriptionReference) ||
        normalizeText(form.physicianName) ||
        normalizeText(form.prescriberNameSnapshot) ||
        normalizeText(form.referringFacility) ||
        normalizeText(form.prescribingFacilityNameSnapshot) ||
        normalizeText(form.prescriptionDate) ||
        normalizeText(form.prescriptionFileName) ||
        normalizeText(uploadedPrescription.prescriptionFileName) ||
        normalizeText(uploadedPrescription.prescription_file_name)
    )

  const getCurrentReturnAlertPatient = (patient = selectedClaimPatient, form = claimForm) => ({
    ...patient,
    memberNo: form.memberNo || patient?.nhis_member_no || patient?.member_no,
    member_no: form.memberNo || patient?.member_no,
    nhis_member_no: form.memberNo || patient?.nhis_member_no,
    hin: form.hin || patient?.nhis_hin || patient?.hin,
    nhis_hin: form.hin || patient?.nhis_hin,
    phone: patient?.phone || patient?.mobile || '',
  })

  const buildReturnAlertForPatient = (patient, medicines = claimMedicines) =>
    findNhisPatientReturnAlert({
      currentPatient: getCurrentReturnAlertPatient(patient),
      currentMedicines: medicines,
      claims,
      now: new Date(),
      settings: returnAlertSettings,
      editingClaimId: editingClaim?.id || '',
    })

  const getReturnAlertReasonText = () =>
    returnAlertReason === 'Other'
      ? normalizeText(returnAlertOtherReason)
      : normalizeText(returnAlertReason)

  const isReturnAlertOverrideFor = (alert) =>
    Boolean(
      alert &&
        returnAlertOverride &&
        returnAlertOverride.previousClaimId === alert.previousClaim?.id
    )

  const openReturnAlert = (alert) => {
    setReturnAlert(alert)
    setReturnAlertReason('Follow-up treatment')
    setReturnAlertOtherReason('')
  }

  const closeReturnAlert = () => {
    setReturnAlert(null)
    setReturnAlertReason('Follow-up treatment')
    setReturnAlertOtherReason('')
  }

  const continueReturnAlert = () => {
    if (!returnAlert) return
    if (!canContinueNhisReturnAlert(role, returnAlertSettings)) {
      notify('Your role is not allowed to continue after a patient return alert.', 'error')
      return
    }
    const reason = getReturnAlertReasonText()
    if (returnAlertSettings.requireReason && !reason) {
      notify('Select or enter a reason before continuing.', 'warning')
      return
    }
    setReturnAlertOverride({
      previousClaimId: returnAlert.previousClaim?.id || '',
      previousClaimNumber: returnAlert.previousClaim?.claim_number || returnAlert.previousClaim?.claimNumber || '',
      patientKey: `${claimForm.memberNo || ''}|${claimForm.hin || ''}`,
      reason,
      alert: returnAlert,
      continuedAt: new Date().toISOString(),
    })
    closeReturnAlert()
  }

  // ── select patient for claim ──────────────────────────────────
  const resetPatientActiveMedicationState = useCallback(() => {
    activeMedicationPatientCheckRef.current += 1
    setPatientActiveMedicationState({
      loading: false,
      checked: false,
      available: true,
      alerts: [],
      reason: '',
      error: '',
    })
  }, [])

  const getActiveMedicationUnavailableMessage = useCallback((reason = '') => {
    if (reason === 'offline_branch') {
      return 'Cross-facility active medicine check is unavailable while this browser is using the local branch server. Local checks still continue.'
    }
    if (reason === 'rpc_not_deployed') {
      return 'Cross-facility active medicine check is waiting for the latest database patch. Local checks still continue.'
    }
    return 'Cross-facility active medicine check could not be completed. Local checks still continue.'
  }, [])

  const runPatientActiveMedicationCheck = useCallback(async ({
    memberNo = claimForm.memberNo,
    hin = claimForm.hin,
    serviceDate = claimForm.serviceDate || todayIsoDate(),
    currentClaimId = editingClaim?.id || null,
    silent = false,
  } = {}) => {
    const effectiveMemberNo = normalizeText(memberNo)
    const effectiveHin = normalizeText(hin)
    if (!effectiveMemberNo && !effectiveHin) {
      resetPatientActiveMedicationState()
      return
    }

    const requestId = activeMedicationPatientCheckRef.current + 1
    activeMedicationPatientCheckRef.current = requestId
    setPatientActiveMedicationState((prev) => ({
      ...prev,
      loading: true,
      checked: true,
      error: '',
    }))

    try {
      const result = await getNhisPatientActiveMedications({
        memberNo: effectiveMemberNo,
        hin: effectiveHin,
        serviceDate,
        currentClaimId,
        currentOrganizationId: organizationId || null,
      })
      if (activeMedicationPatientCheckRef.current !== requestId) return
      const alerts = Array.isArray(result?.alerts) ? result.alerts : []
      setPatientActiveMedicationState({
        loading: false,
        checked: true,
        available: result?.available !== false,
        alerts,
        reason: result?.reason || '',
        error: '',
      })
      if (!silent && result?.available === false) {
        notify(getActiveMedicationUnavailableMessage(result.reason), 'warning')
      } else if (!silent && alerts.length) {
        notify(`HealthFlow found ${alerts.length} active medicine record${alerts.length === 1 ? '' : 's'} for this patient.`, 'warning')
      }
    } catch (error) {
      if (activeMedicationPatientCheckRef.current !== requestId) return
      console.warn('[NHIS] Patient active medication check failed.', {
        code: error?.code || null,
        message: error?.message || 'Unknown error',
      })
      setPatientActiveMedicationState({
        loading: false,
        checked: true,
        available: false,
        alerts: [],
        reason: '',
        error: error?.message || 'Patient active medication check failed.',
      })
      if (!silent) {
        notify(getActiveMedicationUnavailableMessage(), 'warning')
      }
    }
  }, [
    claimForm.hin,
    claimForm.memberNo,
    claimForm.serviceDate,
    editingClaim?.id,
    getActiveMedicationUnavailableMessage,
    notify,
    organizationId,
    resetPatientActiveMedicationState,
  ])

  const selectPatient = (patient) => {
    const memberNo = getPatientMemberNumber(patient)
    const normalizedMemberNo = normalizeNhiaMemberNumber(memberNo)
    const nameParts = patientNameParts(formatPatientLookupName(patient))
    const selectedPatient = {
      ...patient,
      full_name: formatPatientLookupName(patient),
      nhis_member_no: normalizedMemberNo || getPatientMemberNumber(patient),
      nhis_hin: getPatientHin(patient),
      folder_no: getPatientFolderNo(patient),
    }
    setClaimForm((prev) => ({
      ...prev,
      patientId:   patient.patient_id || (String(patient.id || '').startsWith('nhis-claim-') ? '' : patient.id),
      surname:     nameParts.surname,
      otherNames:  nameParts.otherNames,
      gender:      getPatientGender(patient),
      dateOfBirth: normalizeDateOfBirthValue(getPatientDateOfBirth(patient)),
      patientAddress: getPatientAddress(patient),
      folderNo:    getPatientFolderNo(patient) || prev.folderNo,
      memberNo:    normalizedMemberNo,
      cardType:    getNhiaLookupCardType(normalizedMemberNo),
      hin:         getPatientHin(patient),
    }))
    setSelectedClaimPatient(selectedPatient)
    setPatientSearch(formatPatientLookupName(selectedPatient))
    setPatientSearchResults([])
    setPatientSearchError('')
    setReturnAlertOverride(null)
    runPatientActiveMedicationCheck({
      memberNo: normalizedMemberNo,
      hin: getPatientHin(patient),
      serviceDate: claimForm.serviceDate || todayIsoDate(),
      currentClaimId: editingClaim?.id || null,
      silent: true,
    })
    const alert = buildReturnAlertForPatient(selectedPatient)
    if (alert) openReturnAlert(alert)
  }

  const handlePatientSearchChange = (event) => {
    setSelectedClaimPatient(null)
    setReturnAlertOverride(null)
    resetPatientActiveMedicationState()
    setPatientSearch(event.target.value)
  }

  const clearSelectedPatient = () => {
    setSelectedClaimPatient(null)
    setReturnAlertOverride(null)
    resetPatientActiveMedicationState()
    setPatientSearch('')
    setPatientSearchResults([])
    setPatientSearchError('')
  }

  // ── medicine code search ──────────────────────────────────────
  const hasClaimModalWork = () => {
    if (editingClaim || selectedClaimPatient || prescriptionPdfFile) return true
    if (claimMedicines.length > 0 || claimServices.length > 0) return true
    if (claimForm.diagnosisDetails?.length > 0) return true
    const draftFields = [
      'patientId',
      'memberNo',
      'cardType',
      'hin',
      'surname',
      'otherNames',
      'folderNo',
      'gender',
      'dateOfBirth',
      'patientAddress',
      'childWeightKg',
      'cccNo',
      'authId',
      'newCcc',
      'otacCode',
      'attendanceVerificationStatus',
      'nhiaTransactionId',
      'nhiaEligibilityStartDate',
      'nhiaEligibilityEndDate',
      'nhiaAttendanceDate',
      'nhiaMemberStatus',
      'diagnosis',
      'referringFacility',
      'referralCode',
      'physicianName',
      'preAuthCodes',
      'prescriptionFileUrl',
      'prescriptionFilePath',
      'prescriptionFileName',
      'prescriptionDocumentType',
      'prescriberId',
      'prescribingFacilityId',
      'prescriptionDate',
      'prescriptionReference',
      'notes',
      'unservedMedicinesNote',
      'encounterOutcome',
      'noMedicineReason',
      'noLabReason',
      'noProcedureReason',
      'externalPrescriptionStatus',
    ]
    return draftFields.some((field) => normalizeText(claimForm[field]))
  }

  const openNewClaimModal = () => {
    resetClaimModal()
    setShowNewClaimModal(true)
    void ensureInventoryDrugsLoaded()
  }

  const openNewClaimForPatient = (patient) => {
    resetClaimModal()
    selectPatient(patient)
    setShowNewClaimModal(true)
    void ensureInventoryDrugsLoaded()
  }

  const finishCloseClaimModal = () => {
    setClaimActionReview(null)
    setShowNewClaimModal(false)
    resetClaimModal()
    setReadinessActiveClaimId('')
    if (duplicateClaimGroups.length > 0) {
      setShowDuplicateClaimReview(true)
    } else if (readinessClaimIssues.length > 0) {
      setShowReadinessClaimReview(true)
    }
  }

  const closeClaimModal = ({ force = false } = {}) => {
    if (!force && hasClaimModalWork()) {
      setDiscardConfirmation({
        title: 'Discard this NHIS claim work?',
        details: [
          {
            label: 'Patient',
            value: [claimForm.surname, claimForm.otherNames].filter(Boolean).join(' ') || 'Not saved yet',
          },
          {
            label: 'Member number',
            value: claimForm.memberNo || claimForm.hin || 'Not entered',
          },
        ],
        warning: 'Unsaved entries in this claim form will be lost. Use Save Details first if you want to keep the work.',
        confirmText: 'Discard work',
        cancelText: 'Keep editing',
        onConfirm: finishCloseClaimModal,
      })
      return
    }
    finishCloseClaimModal()
  }

  const closeDuplicateClaimReview = () => {
    setShowDuplicateClaimReview(false)
    setDuplicateClaimGroups([])
    setDuplicateExportIssues([])
    setDuplicateClaimSearch('')
  }

  const closeReadinessClaimReview = () => {
    setShowReadinessClaimReview(false)
    setReadinessClaimIssues([])
    setReadinessIssueFilter('all')
    setReadinessIssueSearch('')
    setReadinessFixedCount(0)
    setReadinessActiveClaimId('')
  }

  const returnToDuplicateClaimReview = () => {
    if (duplicateClaimGroups.length > 0) {
      setShowDuplicateClaimReview(true)
    }
  }

  const returnToReadinessClaimReview = () => {
    if (readinessClaimIssues.length > 0) {
      setShowReadinessClaimReview(true)
    }
  }

  const closeViewClaim = () => {
    setViewClaim(null)
    if (duplicateClaimGroups.length > 0) {
      returnToDuplicateClaimReview()
    } else {
      returnToReadinessClaimReview()
    }
  }

  const openEditClaim = async (selectedClaim) => {
    void ensureInventoryDrugsLoaded()
    const canOpenForMcaServing = isMedicineCounterAssistant && canMcaOpenNhisClaimForServing(selectedClaim)
    const canPrivilegedCorrectSelectedClaim =
      canEditNhisClaimAnytime && canCorrectNhisClaimStatus(selectedClaim.status)
    if (canEditNhisClaimAnytime && !canPrivilegedCorrectSelectedClaim) {
      notify('This claim has already been externally submitted or finalized and cannot be corrected in place.', 'warning')
      return false
    }
    if (!canOpenForMcaServing && !canPrivilegedCorrectSelectedClaim && selectedClaim.status !== 'served') {
      notify('Only served NHIS claims can be edited before submission/export.', 'warning')
      return false
    }

    let claim = selectedClaim
    setClaimActionLoading({ claimId: selectedClaim.id, action: 'edit' })
    try {
      claim = await hydrateClaimForAction(selectedClaim)
    } catch (err) {
      notify(err.message || 'Unable to load the full NHIS claim details.', 'error')
      return false
    } finally {
      setClaimActionLoading(null)
    }

    if (isMedicineCounterAssistant && isNhisClaimDirectlyServed(claim)) {
      notify('This claim was served directly by the Claims Officer and does not require dispensary input.', 'warning')
      return false
    }

    // Dispensary medication edits are limited to the 24h window (or a 12h supervisor
    // re-open). The branch server also enforces this; this is early feedback.
    if (isMedicineCounterAssistant && shouldApplyMcaEditWindowToClaim(claim.status) && !isMcaEditWindowOpen(claim)) {
      notify('The 24-hour edit window for this claim has closed. Ask an admin or claims officer to re-open it.', 'warning')
      return false
    }

    setEditingClaim(claim)
    setCorrectionReason('')
    if (canEditNhisClaimAnytime && !shouldUseBranchServer()) {
      getNhisClaimCorrectionHistory(claim.id)
        .then(setCorrectionHistory)
        .catch(() => setCorrectionHistory([]))
    } else {
      setCorrectionHistory([])
    }
    setClaimError('')
    setPatientSearch(formatPatientLookupName(claim))
    setSelectedClaimPatient({
      id: claim.patient_id || `nhis-claim-${claim.id || claim.claim_number || ''}`,
      full_name: formatPatientLookupName(claim),
      nhis_member_no: claim.member_no || '',
      nhis_hin: claim.hin || '',
      folder_no: claim.folder_no || '',
      sourceClaimNumber: claim.claim_number || '',
    })
    setMedForm(makeBlankMedicine())
    setEditingMedicineIndex(null)
    setClaimForm({
      patientId: claim.patient_id || '',
      memberNo: claim.member_no || '',
      cardType: claim.card_type || getNhiaLookupCardType(claim.member_no || ''),
      hin: claim.hin || '',
      surname: claim.surname || '',
      otherNames: claim.other_names || '',
      folderNo: claim.folder_no || '',
      gender: claim.gender || '',
      dateOfBirth: normalizeDateOfBirthValue(claim.date_of_birth),
      patientAddress: claim.patient_address || '',
      childWeightKg: claim.child_weight_kg ?? '',
      cccNo: claim.ccc_no || '',
      authId: claim.nhia_auth_id || '',
      authType: claim.nhia_auth_type || 'NHIS',
      newCcc: claim.nhia_new_ccc_status || '',
      otacCode: claim.nhia_otac || '',
      attendanceVerificationStatus: claim.nhia_attendance_verification_status || '',
      attendanceVerificationSource: claim.nhia_attendance_verification_source || 'nehfams_manual',
      nhiaTransactionId: claim.nhia_transaction_id || '',
      nhiaEligibilityStartDate: claim.nhia_eligibility_start_date || '',
      nhiaEligibilityEndDate: claim.nhia_eligibility_end_date || '',
      nhiaAttendanceDate: claim.nhia_attendance_date || '',
      nhiaMemberStatus: claim.nhia_member_status || '',
      nhiaMemberLookupPayload: claim.nhia_member_lookup_payload || null,
      diagnosis: claim.diagnosis || '',
      diagnosisDetails: claim.diagnosis_details || [],
      serviceDate: claim.service_date_from || todayIsoDate(),
      referringFacility: claim.referring_facility || '',
      referralCode: claim.referral_code || '',
      physicianName: claim.physician_name || '',
      preAuthCodes: claim.pre_auth_codes || '',
      prescriptionFileUrl: claim.prescription_file_url || '',
      prescriptionFilePath: claim.prescription_file_path || '',
      prescriptionFileName: claim.prescription_file_name || '',
      prescriptionFileType: claim.prescription_file_type || '',
      prescriptionFileSize: claim.prescription_file_size || '',
      prescriptionDocumentType: claim.prescription_document_type || '',
      prescriptionVerified: claim.prescription_verified === true,
      prescriptionVerifiedBy: claim.prescription_verified_by || '',
      prescriptionVerifiedAt: claim.prescription_verified_at || '',
      prescriberId: claim.prescriber_id || '',
      prescribingFacilityId: claim.prescribing_facility_id || '',
      prescriptionDate: claim.prescription_date || '',
      prescriptionReference: claim.prescription_reference || '',
      prescriberNameSnapshot: claim.prescriber_name_snapshot || claim.physician_name || '',
      prescriberLicenseSnapshot: claim.prescriber_license_snapshot || '',
      prescribingFacilityNameSnapshot: claim.prescribing_facility_name_snapshot || claim.referring_facility || '',
      prescribingFacilityCodeSnapshot: claim.prescribing_facility_code_snapshot || '',
      prescriptionEnteredBy: claim.prescription_entered_by || '',
      prescriptionEnteredAt: claim.prescription_entered_at || '',
      prescriptionUpdatedBy: claim.prescription_updated_by || '',
      prescriptionUpdatedAt: claim.prescription_updated_at || '',
      prescriptionEntryUserName: claim.prescription_entry_user_name || '',
      prescriptionUpdateUserName: claim.prescription_update_user_name || '',
      claimitAttachmentFileName: claim.claimit_attachment_file_name || '',
      claimitAttachmentFileType: claim.claimit_attachment_file_type || '',
      claimitAttachmentMimeType: claim.claimit_attachment_mime_type || '',
      claimitAttachmentBase64: claim.claimit_attachment_base64 || '',
      notes: claim.notes || '',
      unservedMedicinesNote: claim.unserved_medicines_note || '',
      encounterOutcome: claim.encounter_outcome || '',
      noMedicineReason: claim.no_medicine_reason || '',
      noLabReason: claim.no_lab_reason || '',
      noProcedureReason: claim.no_procedure_reason || '',
      externalPrescriptionStatus: claim.external_prescription_status || '',
    })
    setPrescriptionPdfFile(null)
    setClaimMedicines(
      compactMedicines(claim.nhis_claim_medicines).map((medicine) => ({
        sourceMedicineId: medicine.id || '',
        originalDuration: medicine.duration || '',
        nhisDrugId: medicine.nhis_drug_id || '',
        drugCode: medicine.drug_code || '',
        description: medicine.description || '',
        unit: medicine.unit || 'unit',
        unitPrice: Number.parseFloat(medicine.unit_price || 0),
        prescribedQty: Number.parseFloat(medicine.prescribed_qty ?? medicine.dispensed_qty ?? 0),
        servedQty: Number.parseFloat(medicine.served_qty ?? medicine.dispensed_qty ?? 0),
        dispensedQty: Number.parseFloat(medicine.dispensed_qty || 0),
        servingStatus: normalizeMedicineServingStatus(
          medicine.serving_status,
          Number.parseFloat(medicine.prescribed_qty ?? medicine.dispensed_qty ?? 0),
          Number.parseFloat(medicine.served_qty ?? medicine.dispensed_qty ?? 0)
        ),
        reasonIfNotFullyServed: medicine.reason_if_not_fully_served || '',
        enteredByClaimsOfficer: medicine.entered_by_claims_officer || '',
        servedByMca: medicine.served_by_mca || '',
        enteredAt: medicine.entered_at || '',
        servedAt: medicine.served_at || '',
        dispensaryDate: medicine.dispensary_date || null,
        dose: medicine.dose || '',
        frequency: medicine.frequency || '',
        duration: medicine.duration || '',
        totalAmount: Number.parseFloat(medicine.total_amount || 0),
        category: getCatalogCategoryForMedicine(medicine),
        // ✅ NHIS PHARMACY LEVEL PATCH START
        medicineAccessLevel: medicine.medicine_access_level || '',
        requiredPharmacyLevel: medicine.required_pharmacy_level || '',
        // ✅ NHIS PHARMACY LEVEL PATCH END
      }))
    )
    setClaimServices(
      (claim.nhis_claim_services || []).map((service) => ({
        nhiaTariffItemId: service.nhia_tariff_item_id || '',
        tariffVersion: service.tariff_version || 'FEB 2023',
        facilityGroup: service.facility_group || '',
        cateringOption: service.catering_option || '',
        mdc: service.mdc || '',
        gdrgCode: service.gdrg_code || '',
        description: service.description || '',
        ageBand: service.age_band || '',
        unitPrice: Number.parseFloat(service.unit_price || 0),
        quantity: Number.parseFloat(service.quantity || 1),
        serviceDate: service.service_date || claim.service_date_from || '',
        totalAmount: Number.parseFloat(service.total_amount || 0),
        sourceFile: service.source_file || '',
        sourcePage: service.source_page || null,
      }))
    )
    setShowNewClaimModal(true)
    return true
  }

  const openViewClaim = async (claim) => {
    setClaimActionLoading({ claimId: claim.id, action: 'view' })
    try {
      setViewClaim(await hydrateClaimForAction(claim))
      return true
    } catch (err) {
      notify(err.message || 'Unable to load the full NHIS claim details.', 'error')
      return false
    } finally {
      setClaimActionLoading(null)
    }
  }

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
          genericName: drug.generic_name || '',
          strength:    drug.strength || '',
          dosageForm:  drug.dosage_form || '',
          unit:        drug.unit,
          unitPrice:   String(drug.unit_price),
          category:    drug.category || '',
          // ✅ NHIS PHARMACY LEVEL PATCH START
          medicineAccessLevel: drug.medicine_access_level || '',
          requiredPharmacyLevel: drug.required_pharmacy_level || '',
          // ✅ NHIS PHARMACY LEVEL PATCH END
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
      genericName:  drug.generic_name || '',
      strength:     drug.strength || '',
      dosageForm:   drug.dosage_form || '',
      unit:         drug.unit,
      unitPrice:    String(drug.unit_price),
      category:     drug.category || '',
      // ✅ NHIS PHARMACY LEVEL PATCH START
      medicineAccessLevel: drug.medicine_access_level || '',
      requiredPharmacyLevel: drug.required_pharmacy_level || '',
      // ✅ NHIS PHARMACY LEVEL PATCH END
    }))
    setMedCodeSearch('')
    setMedSearchResults([])
  }

  // ── add medicine to claim ─────────────────────────────────────
  const finishCloseMedicineModal = () => {
    setShowMedModal(false)
    setEditingMedicineIndex(null)
    setMedForm(makeBlankMedicine())
    setMedicineEntryDate(getNhisCalendarDate())
    setMedCodeSearch('')
    setMedSearchResults([])
  }

  const closeMedicineModal = ({ force = false } = {}) => {
    if (!force) {
      const hasMedicineWork = Boolean(
        editingMedicineIndex !== null ||
        medCodeSearch ||
        medSearchResults.length > 0 ||
        [
          'nhisDrugId',
          'drugCode',
          'description',
          'dose',
          'frequency',
          'duration',
          'reasonIfNotFullyServed',
        ].some((field) => normalizeText(medForm[field])) ||
        Number(medForm.dispensedQty) > 0
      )
      if (hasMedicineWork) {
        setDiscardConfirmation({
          title: 'Discard this medicine entry?',
          warning: 'Unsaved medicine details will be lost. Add or save the medicine first if you want to keep it.',
          confirmText: 'Discard medicine',
          cancelText: 'Keep editing',
          onConfirm: finishCloseMedicineModal,
        })
        return
      }
    }
    finishCloseMedicineModal()
  }

  const addMedicineToList = async () => {
    const qty   = Number.parseFloat(medForm.dispensedQty) || 0
    const price = Number.parseFloat(medForm.unitPrice)    || 0
    const requestedServingStatus = String(medForm.servingStatus || '').toLowerCase()
    const currentMedicine = editingMedicineIndex === null ? null : claimMedicines[editingMedicineIndex]
    const retainsHistoricalDuration = Boolean(
      currentMedicine?.sourceMedicineId &&
      currentMedicine.originalDuration === medForm.duration
    )
    const durationIssue = validateNhisMedicineDurationInput(medForm.duration)
    if (durationIssue && !retainsHistoricalDuration) {
      notify(durationIssue, 'warning')
      return
    }
    const allowsZeroServedQty = isMedicineCounterAssistant && ['not_available', 'not_served'].includes(requestedServingStatus)
    if (!(qty > 0) && !allowsZeroServedQty) {
      notify(isMedicineCounterAssistant ? 'Served quantity is required.' : 'Prescribed quantity is required.', 'warning')
      return
    }
    if (isMedicineCounterAssistant && editingMedicineIndex === null) {
      notify('Dispensary users can only serve medicines entered by the Claims Officer.', 'warning')
      return
    }
    const prescribedQty = isMedicineCounterAssistant
      ? getMedicinePrescribedQty(currentMedicine)
      : qty
    const servedQty = isMedicineCounterAssistant
      ? qty
      : canCorrectDirectServedMedicine && currentMedicine
        ? Number.parseFloat(medForm.servedQty) || 0
        : getMedicineServedQty(currentMedicine)
    const servingStatus = normalizeMedicineServingStatus(medForm.servingStatus, prescribedQty, servedQty)
    if (
      isMedicineCounterAssistant &&
      ['not_available', 'not_served'].includes(servingStatus) &&
      servedQty > 0
    ) {
      notify('Set served quantity to 0 when a medicine is not available or not served.', 'warning')
      return
    }
    if (
      isMedicineCounterAssistant &&
      ['partially_served', 'not_available', 'not_served'].includes(servingStatus) &&
      !String(medForm.reasonIfNotFullyServed || '').trim()
    ) {
      notify('Select a reason when a medicine is not fully served.', 'warning')
      return
    }

    const nextMedicine = {
      sourceMedicineId: currentMedicine?.sourceMedicineId || medForm.sourceMedicineId || '',
      originalDuration: currentMedicine?.originalDuration || medForm.originalDuration || '',
      nhisDrugId:    medForm.nhisDrugId   || null,
      drugCode:      medForm.drugCode,
      description:   medForm.description,
      unit:          medForm.unit,
      unitPrice:     price,
      prescribedQty,
      servedQty,
      dispensedQty:  servedQty,
      servingStatus,
      reasonIfNotFullyServed: ['partially_served', 'not_available', 'not_served'].includes(servingStatus)
        ? medForm.reasonIfNotFullyServed
        : '',
      enteredByClaimsOfficer: medForm.enteredByClaimsOfficer || currentMedicine?.enteredByClaimsOfficer || currentMedicine?.entered_by_claims_officer || user?.id || '',
      servedByMca: isMedicineCounterAssistant ? (user?.id || '') : (currentMedicine?.servedByMca || currentMedicine?.served_by_mca || ''),
      enteredAt: medForm.enteredAt || currentMedicine?.enteredAt || currentMedicine?.entered_at || new Date().toISOString(),
      servedAt: isMedicineCounterAssistant ? new Date().toISOString() : (currentMedicine?.servedAt || currentMedicine?.served_at || ''),
      dispensaryDate: medForm.dispensaryDate || null,
      dose:          medForm.dose,
      frequency:     medForm.frequency,
      duration:      retainsHistoricalDuration ? medForm.duration : formatClaimDurationAsDays(medForm.duration),
      totalAmount:   price * servedQty,
      category:      medForm.category || getCatalogCategoryForMedicine(medForm),
      // ✅ NHIS PHARMACY LEVEL PATCH START
      medicineAccessLevel: medForm.medicineAccessLevel || null,
      requiredPharmacyLevel: medForm.requiredPharmacyLevel || null,
      // ✅ NHIS PHARMACY LEVEL PATCH END
    }

    const duplicateAlerts = buildNhisAddMedicineDuplicateAlerts({
      currentClaim: claimForm,
      currentMedicines: claimMedicines,
      candidateMedicine: nextMedicine,
      existingClaims: claims,
      editingClaimId: editingClaim?.id,
      editingMedicineIndex,
      windowHours: returnAlertSettings.windowHours,
    })
    if (duplicateAlerts.length) {
      const proceed = await requestActionConfirmation({
        eyebrow: 'Duplicate medicine alert',
        title: 'Continue adding this medicine?',
        details: duplicateAlerts.slice(0, 5).map((alert, index) => ({
          label: `Alert ${index + 1}`,
          value: alert,
        })),
        warning: 'HealthFlow found possible repeat dispensing for this patient. Review before continuing.',
        confirmText: 'Continue',
        cancelText: 'Review first',
      })
      if (!proceed) {
        notify('Medicine was not added. Please verify the repeat dispensing first.', 'warning')
        return
      }
    }

    try {
      const overlapResult = await checkNhisActiveMedicationOverlap({
        memberNo: claimForm.memberNo,
        hin: claimForm.hin,
        medicineCode: nextMedicine.drugCode,
        serviceDate: nextMedicine.dispensaryDate || claimForm.serviceDate || null,
        currentClaimId: editingClaim?.id || null,
        currentOrganizationId: organizationId || null,
        genericName: nextMedicine.genericName || medForm.genericName || '',
        strength: nextMedicine.strength || medForm.strength || '',
        dosageForm: nextMedicine.dosageForm || medForm.dosageForm || '',
        requestedQuantity: nextMedicine.dispensedQty,
        dose: nextMedicine.dose,
        frequency: nextMedicine.frequency,
        duration: nextMedicine.duration,
      })
      const overlapAlerts = overlapResult?.alerts || []
      if (overlapAlerts.length) {
        showNhisMedicationOverlapBlockAlert(overlapAlerts, notify)
        await tryLogAuditEvent({
          eventType: 'nhis_claim.active_medication_overlap_blocked',
          entityType: 'nhis_claims',
          entityId: editingClaim?.id || null,
          action: 'block_active_medication_overlap',
          details: {
            medicine_code: nextMedicine.drugCode || '',
            medicine_description: nextMedicine.description || '',
            member_no: claimForm.memberNo || '',
            hin: claimForm.hin || '',
            service_date: nextMedicine.dispensaryDate || claimForm.serviceDate || '',
            alert_count: overlapAlerts.length,
            previous_claim_references: overlapAlerts
              .map((alert) => alert.previous_claim_reference)
              .filter(Boolean)
              .slice(0, 5),
          },
        })
        notify('Medicine was not added because active medication coverage still remains.', 'error')
        return
      } else if (overlapResult && overlapResult.available === false) {
        notify('Cross-facility active medication check is not available for this session. Local checks will still continue.', 'warning')
      }
    } catch (overlapError) {
      console.warn('[NHIS] Active medication overlap check failed.', {
        code: overlapError?.code || null,
        message: overlapError?.message || 'Unknown error',
      })
      notify('Cross-facility active medication check could not be completed. Local checks will still continue.', 'warning')
    }

    setClaimMedicines((prev) => {
      if (editingMedicineIndex === null || editingMedicineIndex < 0 || editingMedicineIndex >= prev.length) {
        return [...prev, nextMedicine]
      }

      return prev.map((medicine, index) => index === editingMedicineIndex ? nextMedicine : medicine)
    })
    const nextEntryDate = medForm.dispensaryDate || medicineEntryDate || getNhisCalendarDate()
    setMedicineEntryDate(nextEntryDate)
    setMedForm(makeBlankMedicineForDate(nextEntryDate))
    setMedCodeSearch('')
    setMedSearchResults([])
    setEditingMedicineIndex(null)
    if (editingMedicineIndex !== null) {
      setShowMedModal(false)
    }
  }

  const openEditMedicine = (index) => {
    const medicine = claimMedicines[index]
    if (!medicine) return

    setMedForm({
      sourceMedicineId: medicine.sourceMedicineId || '',
      originalDuration: medicine.originalDuration || medicine.duration || '',
      nhisDrugId: medicine.nhisDrugId || '',
      drugCode: medicine.drugCode || '',
      description: medicine.description || '',
      unit: medicine.unit || 'unit',
      unitPrice: String(medicine.unitPrice ?? ''),
      prescribedQty: String(getMedicinePrescribedQty(medicine)),
      servedQty: String(getMedicineServedQty(medicine)),
      dispensedQty: String(isMedicineCounterAssistant ? getMedicineServedQty(medicine) : getMedicinePrescribedQty(medicine)),
      servingStatus: normalizeMedicineServingStatus(
        medicine.servingStatus ?? medicine.serving_status,
        getMedicinePrescribedQty(medicine),
        getMedicineServedQty(medicine)
      ),
      reasonIfNotFullyServed: medicine.reasonIfNotFullyServed || medicine.reason_if_not_fully_served || '',
      enteredByClaimsOfficer: medicine.enteredByClaimsOfficer || medicine.entered_by_claims_officer || '',
      servedByMca: medicine.servedByMca || medicine.served_by_mca || '',
      enteredAt: medicine.enteredAt || medicine.entered_at || '',
      servedAt: medicine.servedAt || medicine.served_at || '',
      dispensaryDate: medicine.dispensaryDate || todayIsoDate(),
      dose: medicine.dose || '',
      frequency: medicine.frequency || '',
      duration: medicine.duration || '',
      category: medicine.category || getCatalogCategoryForMedicine(medicine),
      // ✅ NHIS PHARMACY LEVEL PATCH START
      medicineAccessLevel: medicine.medicineAccessLevel || medicine.medicine_access_level || '',
      requiredPharmacyLevel: medicine.requiredPharmacyLevel || medicine.required_pharmacy_level || '',
      // ✅ NHIS PHARMACY LEVEL PATCH END
    })
    setMedicineEntryDate(medicine.dispensaryDate || todayIsoDate())
    setMedCodeSearch('')
    setMedSearchResults([])
    setEditingMedicineIndex(index)
    setShowMedModal(true)
  }

  const removeMedicine = (index) => {
    setClaimMedicines((prev) => prev.filter((_, i) => i !== index))
  }

  const addTariffServiceToClaim = (item) => {
    if (!isNhiaTariffItemAllowedForProviderClass(item, providerClassLevel)) {
      notify(
        `This G-DRG/tariff is not available for provider level ${providerClassLevel || 'not configured'}.`,
        'warning'
      )
      return
    }
    const amount = Number.parseFloat(item.tariff_amount || 0) || 0
    setClaimServices((prev) => ([
      ...prev,
      {
        nhiaTariffItemId: item.id,
        tariffVersion: item.tariff_version || 'FEB 2023',
        facilityGroup: item.facility_group || '',
        cateringOption: item.catering_option || '',
        mdc: item.mdc || '',
        gdrgCode: item.gdrg_code || '',
        description: item.description || '',
        ageBand: item.age_band || '',
        unitPrice: amount,
        quantity: 1,
        serviceDate: claimForm.serviceDate || todayIsoDate(),
        totalAmount: amount,
        sourceFile: item.source_file || '',
        sourcePage: item.source_page || null,
      },
    ]))
    setTariffSearch('')
  }

  const updateTariffServiceQuantity = (index, value) => {
    const parsedQuantity = Number.parseFloat(value)
    const quantity = Number.isFinite(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : 1
    setClaimServices((prev) => prev.map((service, serviceIndex) => (
      serviceIndex === index
        ? { ...service, quantity, totalAmount: quantity * Number(service.unitPrice || 0) }
        : service
    )))
  }

  const removeTariffService = (index) => {
    setClaimServices((prev) => prev.filter((_, i) => i !== index))
  }

  const claimTotal = useMemo(
    () =>
      compactMedicines(claimMedicines).reduce((s, m) => s + getMedicineServedAmount(m), 0) +
      claimServices.reduce((s, service) => s + Number(service.totalAmount || 0), 0),
    [claimMedicines, claimServices]
  )

  const requestedClaimTotal = useMemo(
    () =>
      compactMedicines(claimMedicines).reduce((s, m) => s + getMedicinePrescribedAmount(m), 0) +
      claimServices.reduce((s, service) => s + Number(service.totalAmount || 0), 0),
    [claimMedicines, claimServices]
  )

  const showRequestedClaimTotal = !isMedicineCounterAssistant && Math.abs(requestedClaimTotal - claimTotal) > 0.01

  const getDirectNhiaOptions = () => ({
    organizationId,
    organizationType,
    facilityName: resolvedNhiaSettings?.facilityName || organization?.name || organization?.pharmacy_name || '',
    // ✅ NHIA CONFIG PATCH START
    facilityType: resolvedNhiaSettings?.facilityType || resolvedNhiaSettings?.facility_type || resolvedNhiaSettings?.providerTypeDescription || '',
    pharmacyFacilityLevel: resolvedNhiaSettings?.pharmacyFacilityLevel || resolvedNhiaSettings?.pharmacy_facility_level || resolvedNhiaSettings?.pharmacyLevel || '',
    providerLevelCode: resolvedNhiaSettings?.providerLevelCode || resolvedNhiaSettings?.provider_level_code || '',
    credentialCode: resolvedNhiaSettings?.credentialCode || resolvedNhiaSettings?.credential_code || resolvedNhiaSettings?.facilityCode || '',
    licenseNumber: resolvedNhiaSettings?.licenseNumber || resolvedNhiaSettings?.license_number || organization?.license_number || '',
    accreditationExpiryDate: getNhiaAccreditationExpiryDate(resolvedNhiaSettings),
    accreditationDateGenerated: getNhiaAccreditationDateGenerated(resolvedNhiaSettings),
    _inferredProviderClassLevel: resolvedNhiaSettings?._inferredProviderClassLevel,
    _inferredPharmacyFacilityLevel: resolvedNhiaSettings?._inferredPharmacyFacilityLevel,
    // ✅ NHIA CONFIG PATCH END
    facilityCode: resolvedNhiaSettings?.facilityCode || '',
    providerNumber: resolvedNhiaSettings?.providerNumber || '',
    schemeName: resolvedNhiaSettings?.schemeName || 'National Health Insurance',
    providerTypeDescription: resolvedNhiaSettings?.providerTypeDescription || '',
    providerClassLevel,
    claimsOfficerName: resolvedNhiaSettings?.claimsOfficerName || '',
    admissionPaymentOption: resolvedNhiaSettings?.admissionPaymentOption || 'nhis_pays_admission',
    claimitValidationEnabled: resolvedNhiaSettings?.claimitValidationEnabled !== false,
    claimsOfficerSignatureUrl: resolvedNhiaSettings?.claimsOfficerSignatureUrl || '',
    submitterId: resolvedNhiaSettings?.submitterId || '',
    integrationMode,
    connectionProfile: resolvedNhiaSettings?.connectionProfile || resolvedNhiaSettings?.connection_profile || 'local_server',
    validationMode,
    claimControlMode,
    apiBaseUrl: nhiaApiBaseUrl,
    claimitSubmitBaseUrl: claimItSubmitBaseUrl,
    claimEndpointPath: resolvedNhiaSettings?.claimEndpointPath || resolvedNhiaSettings?.claim_endpoint_path || '',
    claimValidationEndpointPath: resolvedNhiaSettings?.claimValidationEndpointPath || resolvedNhiaSettings?.claim_validation_endpoint_path || '',
    ccEndpointPath,
    ccCodeEndpointPath: ccEndpointPath,
    claimStatusEndpointPath: resolvedNhiaSettings?.claimStatusEndpointPath || resolvedNhiaSettings?.claim_status_endpoint_path || '',
    memberLookupEndpointPath: resolvedNhiaSettings?.memberLookupEndpointPath || resolvedNhiaSettings?.member_lookup_endpoint_path || '',
    directApiSource: ['local_branch_server', 'local_cache'].includes(
      resolvedNhiaSettings?.configSource || resolvedNhiaSettings?.source
    ) ? 'branch' : 'hosted',
    directPayloadFormat: resolvedNhiaSettings?.exportFormat || 'json',
    // ✅ NHIS PHARMACY LEVEL PATCH START
    pharmacyLevel: facilityPharmacyLevel,
    // ✅ NHIS PHARMACY LEVEL PATCH END
    // ✅ NHIS CLAIM LOGIC SEPARATION PATCH START
    tariffFacilityGroup: activeTariffFacilityGroup,
    tariffCateringOption: activeTariffCateringOption,
    // ✅ NHIS CLAIM LOGIC SEPARATION PATCH END
  })

  const getNhisRequestErrorMessage = (err, fallback = 'Request failed.', outcome = '') => {
    if (!isNetworkRequestError(err)) {
      return getErrorMessage(err, fallback)
    }

    if (directNhiaApiAvailable) {
      const isBranchSubmit = ['local_branch_server', 'local_cache'].includes(
        resolvedNhiaSettings?.configSource || resolvedNhiaSettings?.source
      )
      const target = isBranchSubmit ? 'local branch server' : 'hosted NHIA/CLAIM-it service'
      const check = isBranchSubmit
        ? 'Confirm the branch server is running and the local server URL/token are correct.'
        : 'Check internet access and the NHIA API base URL/endpoint in Settings.'
      return `Unable to reach the ${target}. ${check}${outcome ? ` ${outcome}` : ''}`
    }

    return `Unable to reach the database or local branch server. Check connectivity, then try again.${outcome ? ` ${outcome}` : ''}`
  }

  const readiness = useMemo(
    () => assessNhisClaimReadiness(
      { ...claimForm, organizationType },
      claimMedicines,
      {
        requireMedicineDirections: Boolean(editingClaim),
        enforceDiagnosisTreatmentMatch: Boolean(isHospital),
        enforceClinicalScrub: Boolean(isHospital),
        enforcePrescribingLevel: true,
        requirePrescriptionAttachment: Boolean(editingClaim && !isHospital),
        requireVerifiedPrescription: Boolean(editingClaim && !isHospital),
        claimControlMode,
        providerClassLevel,
        // ✅ NHIS PHARMACY LEVEL PATCH START
        pharmacyLevel: facilityPharmacyLevel,
        // ✅ NHIS PHARMACY LEVEL PATCH END
        nhisDrugCatalog: nhisDrugs,
        clinicalRules,
        nhiaTariffServices: claimServices,
        currentNhiaTariffItems: nhiaTariffItems,
        // ✅ NHIS CLAIM LOGIC SEPARATION PATCH START
        tariffFacilityGroup: activeTariffFacilityGroup,
        tariffCateringOption: activeTariffCateringOption,
        // ✅ NHIS CLAIM LOGIC SEPARATION PATCH END
      }
    ),
    [claimForm, claimMedicines, claimServices, organizationType, editingClaim, isHospital, clinicalRules, claimControlMode, providerClassLevel, facilityPharmacyLevel, nhisDrugs, nhiaTariffItems, activeTariffFacilityGroup, activeTariffCateringOption]
  )

  const readinessPassed = readiness.issues.length === 0
  const readinessBlocked = readiness.blockers.length > 0
  const mcaReadiness = useMemo(() => splitMcaReadinessIssues(readiness), [readiness])
  const prescriptionAttachmentReview = useMemo(
    () => getNhisPrescriptionAttachmentReview(claimForm, prescriptionPdfFile),
    [claimForm, prescriptionPdfFile]
  )
  const canSaveIncompleteIntake = canSaveNhisIncompleteIntake({
    isMedicineCounterAssistant,
    isEditing: Boolean(editingClaim),
    status: editingClaim?.status,
    blockerCount: readiness.blockers.length,
  }) || (canEditNhisClaimAnytime && canCorrectNhisClaimStatus(editingClaim?.status))
  const incompleteIntakeItems = getNhisIncompleteIntakeItems({
    claim: claimForm,
    medicines: compactMedicines(claimMedicines),
    pendingFile: prescriptionPdfFile,
  })
  const effectiveReadinessBlocked = isMedicineCounterAssistant
    ? mcaReadiness.medicineBlockers.length > 0
    : readinessBlocked
  const effectiveReadinessPassed = isMedicineCounterAssistant
    ? mcaReadiness.medicineBlockers.length === 0 && mcaReadiness.medicineWarnings.length === 0
    : readinessPassed
  const canSaveCommunityPharmacyClaim = isMedicineCounterAssistant
    ? mcaReadiness.canSaveMedicines
    : canSaveIncompleteIntake || readiness.blockers.length === 0

  const handlePrescriptionPdfSelect = (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    const validationError = validateNhisPrescriptionPdfFile(file)
    if (validationError) {
      setClaimError(validationError)
      event.target.value = ''
      return
    }

    setPrescriptionPdfFile(file)
    setClaimError('')
    setClaimForm((prev) => ({
      ...prev,
      prescriptionFileUrl: '',
      prescriptionFilePath: prev.prescriptionFilePath || '',
      prescriptionFileName: file.name,
      prescriptionFileType: file.type || (
        file.name.toLowerCase().endsWith('.png')
          ? 'image/png'
          : file.name.toLowerCase().match(/\.jpe?g$/)
            ? 'image/jpeg'
            : 'application/pdf'
      ),
      prescriptionFileSize: file.size,
      prescriptionDocumentType: '',
      prescriptionVerified: false,
      prescriptionVerifiedBy: '',
      prescriptionVerifiedAt: '',
      claimitAttachmentFileName: '',
      claimitAttachmentFileType: '',
      claimitAttachmentMimeType: '',
      claimitAttachmentBase64: '',
    }))
    event.target.value = ''
  }

  const clearPrescriptionPdf = () => {
    setPrescriptionPdfFile(null)
    setClaimForm((prev) => ({
      ...prev,
      prescriptionFileUrl: '',
      prescriptionFilePath: '',
      prescriptionFileName: '',
      prescriptionFileType: '',
      prescriptionFileSize: '',
      prescriptionDocumentType: '',
      prescriptionVerified: false,
      prescriptionVerifiedBy: '',
      prescriptionVerifiedAt: '',
      claimitAttachmentFileName: '',
      claimitAttachmentFileType: '',
      claimitAttachmentMimeType: '',
      claimitAttachmentBase64: '',
    }))
  }

  const openPrescriptionPdf = async (claim) => {
    try {
      const newWindow = window.open('', '_blank')
      if (newWindow) newWindow.opener = null
      const path = claim?.prescription_file_path
      const url = path
        ? await getNhisPrescriptionSignedUrl(path)
        : claim?.prescription_file_url

      if (!url) {
        newWindow?.close()
        notify('No prescription file is attached to this claim.', 'warning')
        return
      }

      const openUrl = String(url).startsWith('data:')
        ? URL.createObjectURL(await (await fetch(url)).blob())
        : url

      if (newWindow) {
        newWindow.location.href = openUrl
      } else {
        window.open(openUrl, '_blank', 'noopener,noreferrer')
      }

      if (openUrl !== url) {
        window.setTimeout(() => URL.revokeObjectURL(openUrl), 60 * 1000)
      }
    } catch (err) {
      notify(err.message || 'Unable to open prescription file.', 'error')
    }
  }

  // ── submit claim ──────────────────────────────────────────────
  // Shared helper — applies member details from an NHIA genCCC response to the
  // claim form. Used by both handleMemberLookup and handleGenerateCcCode so that
  // auto-fill behaviour is always identical regardless of which path triggered it.
  const applyMemberDetailsToForm = useCallback((prev, memberDetails) => {
    if (!memberDetails) return prev
    const nameParts = (memberDetails.memberName || '').trim().split(/\s+/)
    const surname = nameParts.length > 1 ? nameParts[nameParts.length - 1] : nameParts[0] || prev.surname
    const otherNames = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : prev.otherNames
    return {
      ...prev,
      hin: memberDetails.hin || '',
      surname: surname || prev.surname,
      otherNames: otherNames || prev.otherNames,
      dateOfBirth: normalizeDateOfBirthValue(memberDetails.dateOfBirth) || prev.dateOfBirth,
      gender: normalizeNhisGender(memberDetails.gender) || prev.gender,
      ...(memberDetails.ccCode ? { cccNo: memberDetails.ccCode, ccCode: memberDetails.ccCode } : {}),
      authId: memberDetails.authId || prev.authId,
      authType: memberDetails.authType || prev.authType || 'NHIS',
      newCcc: memberDetails.newCcc ?? prev.newCcc,
      otacCode: memberDetails.otacCode || prev.otacCode,
      attendanceVerificationStatus: memberDetails.attendanceVerificationStatus || prev.attendanceVerificationStatus,
      attendanceVerificationSource: memberDetails.attendanceVerificationSource || prev.attendanceVerificationSource || 'nehfams_manual',
      nhiaTransactionId: memberDetails.transactionId || prev.nhiaTransactionId,
      nhiaEligibilityStartDate: memberDetails.eligibilityStartDate || prev.nhiaEligibilityStartDate,
      nhiaEligibilityEndDate: memberDetails.eligibilityEndDate || prev.nhiaEligibilityEndDate,
      nhiaAttendanceDate: memberDetails.attendanceDate || prev.nhiaAttendanceDate,
      nhiaMemberStatus: memberDetails.status || prev.nhiaMemberStatus,
      nhiaMemberLookupPayload: memberDetails.raw || prev.nhiaMemberLookupPayload,
    }
  }, [])

  // Called when the member number field loses focus. Calls NHIA genCCC to verify
  // eligibility and auto-fill name, HIN, DOB, gender, and CC code.
  // Skips if the value hasn't changed since the last successful lookup.
  const handleMemberLookup = useCallback(async (memberNo, explicitCardType = '') => {
    const memberNumber = (memberNo || claimForm.memberNo || '').trim()
    if (!memberNumber) {
      notify('memberNumber is required.', 'warning')
      return
    }
    const selectedCardType = explicitCardType || claimForm.cardType || getNhiaLookupCardType(memberNumber)
    if (selectedCardType === 'GHANACARD' && !isGhanaCardNumber(memberNumber)) {
      notify('Enter the full Ghana Card number in the format GHA-#########-# before generating a CC code.', 'warning')
      return
    }
    if (!canGenerateNhiaCcCode) return
    // Skip if we already looked up this exact member number.
    if (lastLookedUpMemberRef.current === memberNumber) return

    if (!shouldUseOfflineNhiaUrl) return   // Cloud path: lookup not yet wired, skip silently

    try {
      setLookingUpMember(true)
      const normalizedMemberNumber = normalizeNhiaMemberNumber(memberNumber)
      const result = await branchLookupNhiaMember({
        memberNumber: normalizedMemberNumber,
        cardType: selectedCardType,
      })
      if (!result) return
      lastLookedUpMemberRef.current = normalizedMemberNumber
      setClaimForm((prev) => applyMemberDetailsToForm(prev, result))

      if (result.status && result.status.toUpperCase() !== 'ACTIVE') {
        notify(`Member status: ${result.status}. Verify eligibility before proceeding.`, 'warning')
      } else if (result.ccCode) {
        notify(`Member verified — ${result.memberName || memberNumber}. CC code auto-filled.`, 'success')
      } else {
        notify(`Member verified — ${result.memberName || memberNumber}.`, 'info')
      }
    } catch (err) {
      const message = getNhiaMemberFeedbackMessage(getErrorMessage(err), 'Member lookup failed.')
      notify(message, 'error')
      if (import.meta.env.DEV) console.warn('Member lookup failed:', message)
    } finally {
      setLookingUpMember(false)
    }
  }, [claimForm.memberNo, claimForm.cardType, canGenerateNhiaCcCode, resolvedNhiaSettings, applyMemberDetailsToForm, notify])

  const handleGenerateCcCode = async () => {
    if (!canEditNhisPatientDetails) {
      notify('Dispensary assistants cannot generate or change NHIA CC codes.', 'error')
      return
    }
    if (!canGenerateNhiaCcCode) {
      setClaimForm((prev) => ({ ...prev, cccNo: '' }))
      notify(
        integrationMode === 'claimit_export'
          ? 'CLAIM-it CXF export mode does not generate live NHIA CCC codes. Select a live NHIA/CLAIM-it API mode in Settings, or enter the CC/CCC manually.'
          : 'NHIA CCC generation is not configured. Set the NHIA API base URL and /api/hmis/genCCC endpoint in Settings.',
        'info'
      )
      return
    }

    const memberNumber = normalizeNhiaMemberNumber(claimForm.memberNo)
    if (!memberNumber) {
      notify('Enter the patient NHIS Member No / Ghana Card field before generating a CC/CCC code.', 'warning')
      return
    }
    const selectedCardType = claimForm.cardType || getNhiaLookupCardType(memberNumber)
    if (selectedCardType === 'GHANACARD' && !isGhanaCardNumber(memberNumber)) {
      notify('Enter the full Ghana Card number in the format GHA-#########-# before generating a CC code.', 'warning')
      return
    }

    try {
      setGeneratingCcCode(true)
      notify('NHIA CCC Verification', 'info')
      const claimId = editingClaim?.id || claimForm.id || buildPendingNhisClaimId({ organizationId, claimForm })
      const claimContext = {
        claimId,
        claim_id: claimId,
        organizationId,
        branchId: profile?.branch_id || branch?.id || null,
        organizationType,
        patientName: `${claimForm.surname} ${claimForm.otherNames || ''}`.trim(),
        memberNumber,
        cardType: selectedCardType,
        hin: claimForm.hin,
        diagnosis: claimForm.diagnosis,
        serviceDate: claimForm.serviceDate,
        totalAmount: claimTotal,
      }
      const cccRoute = isBranchServerEnabled ? 'local_branch' : 'cloud'
      await tryLogAuditEvent({
        eventType: 'nhis_claim.ccc_generation',
        entityType: 'nhis_claims',
        entityId: editingClaim?.id || claimForm.id || null,
        action: 'generate_ccc_started',
        details: {
          route: cccRoute,
          card_type: selectedCardType,
          claim_control_mode: claimControlMode,
          integration_mode: integrationMode,
          config_source: resolvedNhiaSettings?.configSource || resolvedNhiaSettings?.source || '',
          user_id: user?.id || '',
          role,
        },
      })
      const generateCcCode = cccRoute === 'local_branch'
        ? generateBranchNhiaCcCode
        : generateHostedNhiaCcCode
      const result = await generateCcCode(claimContext)
      const memberDetails = result?.memberDetails
      if (memberDetails) {
        lastLookedUpMemberRef.current = memberNumber
        setClaimForm((prev) => applyMemberDetailsToForm(prev, memberDetails))
      }
      if (result?.eligibilityError) {
        setClaimForm((prev) => ({ ...prev, cccNo: '', ccCode: '' }))
        notify(getNhiaMemberFeedbackMessage(result.eligibilityError), 'warning')
        return
      }
      if (result?.status === 'pending' || result?.source === 'pending') {
        setClaimForm((prev) => ({ ...prev, cccNo: '' }))
        notify(result.message || 'Pending NHIA CCC verification.', 'info')
        return
      }
      if (!result?.ccCode) {
        throw new Error('No CCC/CC code was returned.')
      }
      const ccCode = normalizeNhisCcCode(result.ccCode)
      if (ccCode.length !== 5) {
        throw new Error('NHIA API returned a CCC/CC code that is not exactly 5 digits.')
      }
      setClaimForm((prev) => applyMemberDetailsToForm(
        { ...prev, cccNo: ccCode, ccCode },
        memberDetails || null
      ))
      await tryLogAuditEvent({
        eventType: 'nhis_claim.ccc_generation',
        entityType: 'nhis_claims',
        entityId: editingClaim?.id || claimForm.id || null,
        action: 'generate_ccc_succeeded',
        details: {
          route: cccRoute,
          card_type: selectedCardType,
          source: result.source || '',
          claim_control_mode: claimControlMode,
          integration_mode: integrationMode,
          user_id: user?.id || '',
          role,
        },
      })
      notify(
        result.source === 'claimit_bridge'
          ? 'CCC/CC code returned by CLAIM-it.'
          : result.source === 'api'
            ? `CCC/CC code generated from NHIA API${memberDetails?.memberName ? ` — ${memberDetails.memberName}` : ''}.`
            : 'CCC/CC code generated for direct NHIA submission.',
        'success'
      )
    } catch (err) {
      await tryLogAuditEvent({
        eventType: 'nhis_claim.ccc_generation',
        entityType: 'nhis_claims',
        entityId: editingClaim?.id || claimForm.id || null,
        action: 'generate_ccc_failed',
        details: {
          route: isBranchServerEnabled ? 'local_branch' : 'cloud',
          card_type: selectedCardType,
          claim_control_mode: claimControlMode,
          integration_mode: integrationMode,
          message: getErrorMessage(err),
          user_id: user?.id || '',
          role,
        },
      })
      notify(
        getNhiaMemberFeedbackMessage(err.message, 'Unable to generate CCC/CC code.'),
        'error'
      )
    } finally {
      setGeneratingCcCode(false)
    }
  }

  const handleSubmitClaim = async (e, intent = 'dispatch', reviewConfirmed = false, medicinesOverride = null) => {
    e.preventDefault()
    const saveAsDraft = intent === 'save_details'
    const serveDirectly = intent === 'serve_directly'
    if (serveDirectly && editingClaim && !canNhisClaimBeServedDirectly({
      claim: editingClaim,
      role: privilegedNhisActionRole,
    })) {
      setClaimError(
        isNhisClaimDirectlyServed(editingClaim)
          ? 'This claim was already served directly. Use Save Intake Updates to save corrections without serving it again.'
          : 'This claim cannot be served directly in its current state.'
      )
      return
    }
    const effectiveClaimMedicines = serveDirectly
      ? markNhisMedicinesServedDirectly(medicinesOverride || claimMedicines, {
          actorId: user?.id || '',
        })
      : (medicinesOverride || claimMedicines)

    if (serveDirectly && compactMedicines(effectiveClaimMedicines).length === 0) {
      setClaimError('Add at least one medicine before serving directly.')
      return
    }
    if (serveDirectly && shouldUseBranchServer()) {
      setClaimError('Direct serving requires an online cloud connection so the serving record can be saved safely.')
      return
    }
    if (!isMedicineCounterAssistant && readiness.blockers.length && !canSaveIncompleteIntake) {
      setClaimError(`NHIS claim scrub failed: ${readiness.blockers.slice(0, 5).join(' ')}`)
      return
    }

    if (isMedicineCounterAssistant && mcaReadiness.medicineBlockers.length) {
      setClaimError(`Medicine save check failed: ${mcaReadiness.medicineBlockers.slice(0, 5).join(' ')}`)
      return
    }

    const normalizedDateOfBirth = normalizeDateOfBirthValue(claimForm.dateOfBirth)
    if (claimForm.dateOfBirth && !normalizedDateOfBirth) {
      setClaimError('Date of birth must be day/month/year, for example 18/06/2026.')
      return
    }

    if (!editingClaim && returnAlertSettings.enabled) {
      const alert = buildReturnAlertForPatient(selectedClaimPatient || claimForm, effectiveClaimMedicines)
      if (alert && !isReturnAlertOverrideFor(alert)) {
        openReturnAlert(alert)
        setClaimError('Patient return alert requires verification before saving this NHIS visit.')
        return
      }
    }

    const duplicateClaimBlockers = buildNhisDuplicateClaimBlockers({
      currentClaim: claimForm,
      currentMedicines: effectiveClaimMedicines,
      existingClaims: claims,
      editingClaimId: editingClaim?.id,
    })
    if (duplicateClaimBlockers.length) {
      setClaimError(`Duplicate NHIS claim blocked: ${duplicateClaimBlockers[0]}`)
      return
    }

    const duplicateWarnings = buildNhisDuplicateWarnings({
      currentClaim: claimForm,
      currentMedicines: effectiveClaimMedicines,
      existingClaims: claims,
      editingClaimId: editingClaim?.id,
    })
    if (duplicateWarnings.length && saveAsDraft && !reviewConfirmed) {
      const proceed = await requestActionConfirmation({
        eyebrow: 'Duplicate review',
        title: 'Continue saving this claim?',
        details: duplicateWarnings.slice(0, 6).map((warning, index) => ({
          label: `Warning ${index + 1}`,
          value: warning,
        })),
        warning: 'HealthFlow found possible duplicate claim or medicine details. Review before saving.',
        confirmText: 'Continue',
        cancelText: 'Go back',
      })
      if (!proceed) {
        setClaimError(`Possible duplicate found: ${duplicateWarnings[0]}`)
        return
      }
    }

    if (!saveAsDraft && !reviewConfirmed) {
      setClaimActionReview({ intent, duplicateWarnings })
      return
    }

    try {
      setClaimSubmitting(true)
      setClaimSubmitIntent(intent)
      setClaimError('')
      const uploadedPrescription = prescriptionPdfFile
        ? await uploadNhisPrescriptionPdf(prescriptionPdfFile, {
            organizationId: organization?.id,
            claimId: editingClaim?.id,
            yearMonth: (claimForm.serviceDate || todayIsoDate()).slice(0, 7),
          })
        : {}
      const prescriptionTraceAt = new Date().toISOString()
      const prescriptionTraceActorId = user?.id || null
      const prescriptionTraceActorName = getCurrentPrescriptionActorLabel()
      const shouldRecordPrescriptionTrace = hasPrescriptionTraceDetails(claimForm, uploadedPrescription)
      const payload = {
        ...claimForm,
        ...uploadedPrescription,
        organizationType,
        organizationId,
        organization_id: organizationId || null,
        providerClassLevel,
        branchId: profile?.branch_id || branch?.id || null,
        createdBy: user?.id || null,
      }
      if (shouldRecordPrescriptionTrace) {
        payload.prescriptionEnteredBy = claimForm.prescriptionEnteredBy || editingClaim?.prescription_entered_by || prescriptionTraceActorId
        payload.prescriptionEnteredAt = claimForm.prescriptionEnteredAt || editingClaim?.prescription_entered_at || prescriptionTraceAt
        payload.prescriptionEntryUserName = claimForm.prescriptionEntryUserName || editingClaim?.prescription_entry_user_name || prescriptionTraceActorName
        payload.prescriptionUpdatedBy = prescriptionTraceActorId
        payload.prescriptionUpdatedAt = prescriptionTraceAt
        payload.prescriptionUpdateUserName = prescriptionTraceActorName
      }
      if (!editingClaim) {
        payload.status = getNhisIntakeSaveStatus({ intent, isNew: true })
        payload.servingStatus = 'pending'
        payload.allowIncompleteReview = true
      } else if (saveAsDraft) {
        payload.status = getNhisIntakeSaveStatus({
          intent,
          currentStatus: editingClaim.status,
        })
        payload.servingStatus = 'pending'
        payload.allowIncompleteReview = true
      } else if (normalizeText(editingClaim.status).toLowerCase() === 'draft') {
        payload.status = getNhisIntakeSaveStatus({
          intent,
          currentStatus: editingClaim.status,
        })
        payload.servingStatus = 'pending'
        payload.allowIncompleteReview = true
      } else if (isMedicineCounterAssistant) {
        payload.status = 'returned_for_review'
        payload.servingStatus = getClaimServingStatus(effectiveClaimMedicines)
      } else if (shouldFinalizeNhisServingReview(editingClaim.status) && readiness.blockers.length === 0) {
        payload.status = 'served'
        payload.servingStatus = getClaimServingStatus(effectiveClaimMedicines)
        payload.servingReviewedBy = user?.id || null
        payload.servingReviewedAt = new Date().toISOString()
      } else {
        payload.status = editingClaim.status
        payload.servingStatus = getClaimServingStatus(effectiveClaimMedicines)
        payload.allowIncompleteReview = true
      }
      payload.expectedUpdatedAt = editingClaim?.updated_at || editingClaim?.updatedAt || ''
      const payloadHasReadablePrescriptionFile = Boolean(
        payload.prescriptionFilePath ||
        payload.prescription_file_path ||
        payload.prescriptionFileUrl ||
        payload.prescription_file_url ||
        payload.claimitAttachmentBase64 ||
        payload.claimit_attachment_base64
      )

      let successMessage = serveDirectly
        ? 'Claim medicines served directly.'
        : saveAsDraft
        ? 'Claim details saved. The claim has not been sent to the dispensary.'
        : editingClaim
        ? (
            isMedicineCounterAssistant
              ? 'NHIS medicines saved for Claims Officer review.'
              : canSaveIncompleteIntake && readiness.blockers.length
                ? 'NHIS intake updates saved. The claim remains incomplete and available to the dispensary.'
                : 'NHIS claim reviewed and marked ready.'
          )
        : incompleteIntakeItems.length
          ? `NHIS claim sent to dispensary with incomplete intake: ${incompleteIntakeItems.join(' and ')}.`
          : 'NHIS prescription saved and sent to dispensary for serving.'
      let savedClaimRecord = null
      const returnAlertOverrideSnapshot = returnAlertOverride
      if (editingClaim) {
        const savedClaim = await updateNhisClaim(editingClaim.id, payload, effectiveClaimMedicines, {
          providerClassLevel,
          claimControlMode,
          useBranchServer: isBranchServerEnabled,
          // ✅ NHIS PHARMACY LEVEL PATCH START
          pharmacyLevel: facilityPharmacyLevel,
          // ✅ NHIS PHARMACY LEVEL PATCH END
          nhisDrugCatalog: nhisDrugs,
          nhiaTariffServices: claimServices,
          tariffFacilityGroup: activeTariffFacilityGroup,
          tariffCateringOption: activeTariffCateringOption,
          medicinesOnly: isMedicineCounterAssistant,
          allowIncompleteReview: canSaveIncompleteIntake,
          expectedUpdatedAt: editingClaim.updated_at || editingClaim.updatedAt || '',
          requirePrescriptionAttachment: !isHospital,
          requireVerifiedPrescription: !isHospital,
          privilegedCorrection: canEditNhisClaimAnytime,
          correctionReason,
          existingMedicines: editingClaim.nhis_claim_medicines || editingClaim.medicines || [],
        })
        savedClaimRecord = savedClaim || editingClaim
        const claimForSubmission = savedClaim || editingClaim
        const isServedClaim = normalizeText(claimForSubmission?.status || editingClaim.status).toLowerCase() === 'served'
        const hasReadablePrescriptionFile = Boolean(
          payloadHasReadablePrescriptionFile ||
            claimForSubmission?.prescription_file_path ||
            claimForSubmission?.prescription_file_url ||
            claimForSubmission?.claimit_attachment_base64 ||
            claimForSubmission?.prescriptionFilePath ||
            claimForSubmission?.prescriptionFileUrl ||
            claimForSubmission?.claimitAttachmentBase64
        )
        if (canWrite && isServedClaim && directNhiaApiAvailable && hasReadablePrescriptionFile) {
          try {
            const submitResult = await submitNhisClaimDirect(editingClaim.id, {
              ...getDirectNhiaOptions(),
              claim: claimForSubmission,
            })
            successMessage = submitResult?.queued
              ? 'NHIS claim corrections saved and queued for CLAIM-it bridge submission.'
              : 'NHIS claim corrections saved and submitted through CLAIM-it.'
          } catch (submitError) {
            await refreshClaimsOverview()
            setPrescriptionPdfFile(null)
            setEditingClaim(savedClaim || editingClaim)
            setClaimError(getNhisRequestErrorMessage(
              submitError,
              'Corrections were saved locally, but CLAIM-it submission failed.',
              'The prescription file remains saved on the local claim.'
            ))
            notify('NHIS claim corrections and prescription file saved locally. CLAIM-it rejected the submission.', 'warning')
            return
          }
        } else if (canWrite && isServedClaim && directNhiaApiAvailable) {
          successMessage = 'NHIS claim corrections saved locally. CLAIM-it submission was skipped because no readable prescription attachment is on the claim.'
        }
      } else {
        const createPayload = returnAlertOverrideSnapshot?.alert
          ? {
              ...payload,
              nhisReturnOverrideReason: returnAlertOverrideSnapshot.reason,
              nhisReturnPreviousClaimId: returnAlertOverrideSnapshot.alert.previousClaim?.id || '',
            }
          : payload
        savedClaimRecord = await createNhisClaim(createPayload, effectiveClaimMedicines, {
          providerClassLevel,
          claimControlMode,
          useBranchServer: isBranchServerEnabled,
          // ✅ NHIS PHARMACY LEVEL PATCH START
          pharmacyLevel: facilityPharmacyLevel,
          // ✅ NHIS PHARMACY LEVEL PATCH END
          nhisDrugCatalog: nhisDrugs,
          nhiaTariffServices: claimServices,
          tariffFacilityGroup: activeTariffFacilityGroup,
          tariffCateringOption: activeTariffCateringOption,
        })
      }

      if (serveDirectly) {
        try {
          const directServeResult = await serveNhisClaimDirect(savedClaimRecord?.id || editingClaim?.id)
          savedClaimRecord = { ...(savedClaimRecord || {}), ...(directServeResult || {}) }
          successMessage = readiness.blockers.length
            ? 'Medicines served directly. The claim remains incomplete until final-submission requirements are completed.'
            : 'Medicines served directly and the claim marked ready.'
        } catch (directServeError) {
          await refreshClaimsOverview()
          throw new Error(
            `Claim details were saved, but direct serving did not complete: ${
              directServeError.message || 'Direct serving failed.'
            }`
          )
        }
      }

      if (!editingClaim && returnAlertOverrideSnapshot?.alert) {
        const alert = returnAlertOverrideSnapshot.alert
        await tryLogAuditEvent({
          eventType: 'nhis.patient_return_override',
          entityType: 'nhis_claims',
          entityId: savedClaimRecord?.id || '',
          action: 'override',
          details: {
            patient: `${payload.surname || ''} ${payload.otherNames || ''}`.trim(),
            member_no: payload.memberNo || '',
            hin: payload.hin || '',
            previous_visit_id: alert.previousClaim?.id || '',
            previous_claim_number: alert.previousClaim?.claim_number || alert.previousClaim?.claimNumber || '',
            current_visit_id: savedClaimRecord?.id || '',
            current_claim_number: savedClaimRecord?.claim_number || savedClaimRecord?.claimNumber || '',
            time_difference_minutes: alert.minutesSincePrevious,
            time_difference_hours: alert.hoursSincePrevious,
            same_medication_repeated: Boolean(alert.sameMedicationRepeated),
            repeated_medicines: alert.repeatedMedicines || [],
            previous_medicines: alert.previousMedicines || [],
            current_medicines: alert.currentMedicines || [],
            reason: returnAlertOverrideSnapshot.reason,
            user_id: user?.id || '',
            role,
          },
        })
      }

      await tryLogAuditEvent({
        eventType: serveDirectly
          ? 'nhis_claim.served_directly'
          : saveAsDraft
          ? 'nhis_claim.details_saved'
          : editingClaim
            ? 'nhis_claim.intake_updated'
            : 'nhis_claim.sent_to_dispensary',
        entityType: 'nhis_claims',
        entityId: savedClaimRecord?.id || editingClaim?.id || '',
        action: serveDirectly
          ? 'serve_directly'
          : saveAsDraft
            ? 'save_details'
            : editingClaim
              ? 'update_intake'
              : 'dispatch',
        details: {
          claim_number: savedClaimRecord?.claim_number || editingClaim?.claim_number || '',
          medicine_count: compactMedicines(effectiveClaimMedicines).length,
          prescription_attached: incompleteIntakeItems.includes('prescription attachment') === false,
          prescription_document_type: payload.prescriptionDocumentType || '',
          prescription_verified: payload.prescriptionVerified === true,
          prescription_verified_by: payload.prescriptionVerifiedBy || '',
          prescription_verified_at: payload.prescriptionVerifiedAt || '',
          prescription_reference: payload.prescriptionReference || '',
          prescriber: payload.prescriberNameSnapshot || payload.physicianName || '',
          prescribing_facility: payload.prescribingFacilityNameSnapshot || payload.referringFacility || '',
          prescription_entered_by: payload.prescriptionEnteredBy || '',
          prescription_entered_by_name: payload.prescriptionEntryUserName || '',
          prescription_updated_by: payload.prescriptionUpdatedBy || '',
          prescription_updated_by_name: payload.prescriptionUpdateUserName || '',
          incomplete_items: incompleteIntakeItems,
          status: savedClaimRecord?.status || payload.status || '',
          inventory_deducted: false,
          served_directly_by: serveDirectly ? user?.id || '' : '',
        },
      })

      if (shouldRecordPrescriptionTrace) {
        await tryLogAuditEvent({
          eventType: 'nhis_claim.prescription_trace',
          entityType: 'nhis_claims',
          entityId: savedClaimRecord?.id || editingClaim?.id || '',
          action: editingClaim ? 'prescription_updated' : 'prescription_entered',
          details: {
            claim_number: savedClaimRecord?.claim_number || editingClaim?.claim_number || '',
            prescription_reference: payload.prescriptionReference || '',
            prescriber: payload.prescriberNameSnapshot || payload.physicianName || '',
            prescriber_license: payload.prescriberLicenseSnapshot || '',
            prescribing_facility: payload.prescribingFacilityNameSnapshot || payload.referringFacility || '',
            prescribing_facility_code: payload.prescribingFacilityCodeSnapshot || '',
            prescription_date: payload.prescriptionDate || '',
            prescription_file_name: payload.prescriptionFileName || '',
            entered_by: payload.prescriptionEnteredBy || '',
            entered_by_name: payload.prescriptionEntryUserName || '',
            updated_by: payload.prescriptionUpdatedBy || '',
            updated_by_name: payload.prescriptionUpdateUserName || '',
            user_id: user?.id || '',
            role,
          },
        })
      }

      const wasReadinessCorrection = readinessClaimIssues.length > 0
      setShowNewClaimModal(false)
      resetClaimModal()
      if (duplicateClaimGroups.length > 0) {
        setShowDuplicateClaimReview(true)
      } else if (wasReadinessCorrection) {
        const correctedClaimId = savedClaimRecord?.id || editingClaim?.id || ''
        const correctedClaimNumber = savedClaimRecord?.claim_number || editingClaim?.claim_number || ''
        const remainingReadinessIssues = readinessClaimIssues.filter((issue) =>
          (correctedClaimId && issue.id === correctedClaimId) ||
          (correctedClaimNumber && issue.claim_number === correctedClaimNumber)
            ? false
            : true
        )
        setReadinessClaimIssues(remainingReadinessIssues)
        if (remainingReadinessIssues.length < readinessClaimIssues.length) {
          setReadinessFixedCount((count) => count + 1)
        }
        if (remainingReadinessIssues.length > 0) {
          setShowReadinessClaimReview(true)
        }
      }
      setReadinessActiveClaimId('')
      await refreshClaimsOverview()
      notify(successMessage, 'success')
      if (wasReadinessCorrection) {
        await handleCheckExportReadiness({
          keepModalOpen: true,
          preserveFilter: true,
          showExportModalOnReady: true,
        })
      }
    } catch (err) {
      setClaimError(getNhisRequestErrorMessage(
        err,
        'Unable to save claim.',
        editingClaim && directNhiaApiAvailable ? 'Corrections were not submitted.' : 'The claim was not saved.'
      ))
    } finally {
      setClaimSubmitting(false)
      setClaimSubmitIntent('')
    }
  }

  const resetClaimModal = () => {
    setClaimForm(makeBlankClaim())
    setClaimMedicines([])
    setClaimServices([])
    setClaimError('')
    setPatientSearch('')
    setPatientSearchResults([])
    setPatientSearchError('')
    setSelectedClaimPatient(null)
    setMedForm(makeBlankMedicine())
    setEditingMedicineIndex(null)
    setTariffSearch('')
    setEditingClaim(null)
    setCorrectionReason('')
    setCorrectionHistory([])
    setPrescriptionPdfFile(null)
    setReturnAlert(null)
    setReturnAlertOverride(null)
    setReturnAlertReason('Follow-up treatment')
    setReturnAlertOtherReason('')
  }

  // ── status updates ────────────────────────────────────────────
  const handleStatusUpdate = async (claim, newStatus) => {
    try {
      setUpdatingStatus(claim.id)
      const fullClaim = await hydrateClaimForAction(claim)
      if (newStatus === 'submitted') {
        const blockers = await validateNhisClaimFinalReadiness(
          { ...fullClaim, organizationType, providerClassLevel },
          fullClaim.nhis_claim_medicines || [],
          {
            providerClassLevel,
            // ✅ NHIS PHARMACY LEVEL PATCH START
            pharmacyLevel: facilityPharmacyLevel,
            // ✅ NHIS PHARMACY LEVEL PATCH END
            nhisDrugCatalog: nhisDrugs,
            nhiaTariffServices: fullClaim.nhis_claim_services || [],
            currentNhiaTariffItems: nhiaTariffItems,
            tariffFacilityGroup: activeTariffFacilityGroup,
            tariffCateringOption: activeTariffCateringOption,
            requirePrescriptionAttachment: !isHospital,
            requireVerifiedPrescription: !isHospital,
          }
        )

        if (blockers.length) {
          notify(
            `Final NHIS check failed: ${blockers.slice(0, 3).join(' ')}`,
            'error'
          )
          return
        }
      }

      if (!(await requestActionConfirmation({
        eyebrow: 'NHIS claim status',
        title: newStatus === 'submitted'
          ? 'Submit this NHIS claim?'
          : 'Mark this NHIS claim as paid?',
        details: [
          { label: 'Claim', value: fullClaim.claim_number },
          {
            label: 'Patient',
            value: [fullClaim.surname, fullClaim.other_names || fullClaim.otherNames]
              .filter(Boolean)
              .join(' '),
          },
          {
            label: 'Amount',
            value: `GHS ${Number(fullClaim.total_claim_amount || fullClaim.total_amount || 0).toFixed(2)}`,
          },
        ],
        warning: newStatus === 'submitted'
          ? 'This performs the final readiness-controlled submission step and may send the claim through CLAIM-it when configured.'
          : 'This records that payment has been received for the submitted claim.',
        confirmText: newStatus === 'submitted'
          ? 'Submit claim'
          : 'Mark as paid',
        cancelText: 'Cancel',
      }))) return

      const hasReadablePrescriptionFile = Boolean(
        fullClaim.prescription_file_path ||
        fullClaim.prescription_file_url ||
        fullClaim.claimit_attachment_base64
      )
      if (newStatus === 'submitted' && directNhiaApiAvailable && hasReadablePrescriptionFile) {
        const submitResult = await submitNhisClaimDirect(fullClaim.id, {
          ...getDirectNhiaOptions(),
          claim: fullClaim,
        })
        if (submitResult?.queued) {
          await refreshClaimsOverview()
          notify(`Claim ${fullClaim.claim_number} queued for CLAIM-it bridge submission.`, 'info')
          return
        }
      } else {
        await updateNhisClaimStatus(fullClaim.id, newStatus, '', user?.id || null)
      }
        await refreshClaimsOverview()
        notify(
        newStatus === 'submitted' && directNhiaApiAvailable && hasReadablePrescriptionFile
          ? `Claim ${fullClaim.claim_number} submitted through CLAIM-it.`
          : `Claim ${fullClaim.claim_number} marked as ${newStatus}.`,
        'success'
      )
    } catch (err) {
      notify(getNhisRequestErrorMessage(err, 'Update failed.', 'The claim was not marked Submitted.'), 'error')
    } finally {
      setUpdatingStatus(null)
    }
  }

  const handleRejectConfirm = async () => {
    if (!rejectReason.trim()) { notify('Rejection reason is required.', 'warning'); return }
    if (!(await requestActionConfirmation({
      eyebrow: 'NHIS claim rejection',
      title: 'Reject this NHIS claim?',
      details: [
        { label: 'Claim', value: rejectTarget?.claim_number },
        { label: 'Reason', value: rejectReason.trim() },
      ],
      warning: 'The rejection and its reason will be recorded in the claim history.',
      confirmText: 'Reject claim',
      cancelText: 'Cancel',
    }))) return
    try {
      setUpdatingStatus(rejectTarget.id)
      await updateNhisClaimStatus(rejectTarget.id, 'rejected', rejectReason.trim(), user?.id || null)
      setRejectTarget(null)
      setRejectReason('')
      await refreshClaimsOverview()
      notify(`Claim ${rejectTarget.claim_number} rejected.`, 'info')
    } catch (err) {
      notify(err.message || 'Unable to reject claim.', 'error')
    } finally {
      setUpdatingStatus(null)
    }
  }

  const handleDeleteClaim = async (claim) => {
    if (!canDeleteNhisClaims) {
      notify('Only an administrator can delete NHIS claims.', 'warning')
      return
    }
    if (!(await requestActionConfirmation({
      eyebrow: 'Recycle Bin',
      title: 'Move this NHIS claim to the Recycle Bin?',
      details: [
        { label: 'Claim', value: claim.claim_number },
        {
          label: 'Patient',
          value: [claim.surname, claim.other_names || claim.otherNames].filter(Boolean).join(' '),
        },
        { label: 'Status', value: claim.status },
      ],
      warning: 'The claim will leave the active workspace. An administrator can restore it.',
      confirmText: 'Move to Recycle Bin',
      cancelText: 'Cancel',
    }))) return

    try {
      setUpdatingStatus(claim.id)
      await deleteNhisClaim(claim.id, { role, canDeleteNhisClaims })
      if (viewClaim?.id === claim.id) closeViewClaim()
      if (editingClaim?.id === claim.id) closeClaimModal({ force: true })
      await refreshClaimsOverview()
      notify(`Claim ${claim.claim_number} moved to the Recycle Bin.`, 'success')
    } catch (err) {
      notify(err.message || 'Unable to delete claim.', 'error')
    } finally {
      setUpdatingStatus(null)
    }
  }

  const handleKeepDuplicateClaim = async (group, keepClaim) => {
    if (!canDeleteNhisClaims) {
      notify('Only an administrator can resolve duplicates by moving claims to the Recycle Bin.', 'warning')
      return
    }

    const claimsToRecycle = (group.claims || []).filter((claim) => claim.id && claim.id !== keepClaim.id)
    if (!keepClaim?.id || claimsToRecycle.length === 0) {
      notify('There are no other duplicate claims to move.', 'info')
      return
    }

    if (!(await requestActionConfirmation({
      eyebrow: 'Duplicate resolution',
      title: 'Keep this NHIS claim and recycle the duplicates?',
      details: [
        { label: 'Keep', value: keepClaim.claim_number || 'Selected claim' },
        {
          label: 'Move to Recycle Bin',
          value: claimsToRecycle.map((claim) => claim.claim_number || 'Unnumbered').join(', '),
        },
        {
          label: 'Patient',
          value: group.patientName || [keepClaim.surname, keepClaim.other_names || keepClaim.otherNames].filter(Boolean).join(' '),
        },
        { label: 'Service date', value: group.serviceDate || getClaimServiceDate(keepClaim) || 'Not recorded' },
      ],
      warning: 'Only the selected claim will remain active. The other duplicate claim(s) can be restored by an administrator from the Recycle Bin.',
      confirmText: 'Keep selected claim',
      cancelText: 'Cancel',
    }))) return

    try {
      setUpdatingStatus(keepClaim.id)
      await Promise.all(claimsToRecycle.map((claim) => deleteNhisClaim(claim.id, { role, canDeleteNhisClaims })))
      const nextDuplicateGroups = duplicateClaimGroups
        .map((currentGroup) => {
          const sameGroup = currentGroup === group || Boolean(group.key && currentGroup.key === group.key)
          if (!sameGroup) return currentGroup
          const remainingClaims = (currentGroup.claims || []).filter((claim) => claim.id === keepClaim.id)
          return { ...currentGroup, claims: remainingClaims }
        })
        .filter((currentGroup) => (currentGroup.claims || []).length > 1)
      setDuplicateClaimGroups(nextDuplicateGroups)
      if (nextDuplicateGroups.length === 0) setShowDuplicateClaimReview(false)
      await refreshClaimsOverview()
      notify(`Kept ${keepClaim.claim_number || 'the selected claim'} and moved ${claimsToRecycle.length} duplicate claim${claimsToRecycle.length === 1 ? '' : 's'} to the Recycle Bin.`, 'success')
    } catch (err) {
      notify(err.message || 'Unable to resolve duplicate claims.', 'error')
    } finally {
      setUpdatingStatus(null)
    }
  }

  const handleRecycleDuplicateClaim = async (group, duplicateClaim) => {
    if (!canDeleteNhisClaims) {
      notify('Only an administrator can move duplicate NHIS claims to the Recycle Bin.', 'warning')
      return
    }

    if (!duplicateClaim?.id) {
      notify('This duplicate claim cannot be moved because its record ID is missing.', 'warning')
      return
    }

    const remainingClaims = (group.claims || []).filter((claim) => claim.id && claim.id !== duplicateClaim.id)
    if (remainingClaims.length === 0) {
      notify('At least one claim must remain active in the duplicate group.', 'warning')
      return
    }

    if (!(await requestActionConfirmation({
      eyebrow: 'Duplicate resolution',
      title: 'Move this duplicate claim to the Recycle Bin?',
      details: [
        { label: 'Move', value: duplicateClaim.claim_number || 'Selected duplicate' },
        {
          label: 'Keep active',
          value: remainingClaims.map((claim) => claim.claim_number || 'Unnumbered').join(', '),
        },
        {
          label: 'Patient',
          value: group.patientName || [duplicateClaim.surname, duplicateClaim.other_names || duplicateClaim.otherNames].filter(Boolean).join(' '),
        },
        { label: 'Service date', value: group.serviceDate || getClaimServiceDate(duplicateClaim) || 'Not recorded' },
      ],
      warning: 'This only moves the selected duplicate to the Recycle Bin. An administrator can restore it if needed.',
      confirmText: 'Delete duplicate',
      cancelText: 'Cancel',
    }))) return

    try {
      setUpdatingStatus(duplicateClaim.id)
      await deleteNhisClaim(duplicateClaim.id, { role, canDeleteNhisClaims })
      const nextDuplicateGroups = duplicateClaimGroups
        .map((currentGroup) => {
          const sameGroup = currentGroup === group || Boolean(group.key && currentGroup.key === group.key)
          if (!sameGroup) return currentGroup
          return {
            ...currentGroup,
            claims: (currentGroup.claims || []).filter((claim) => claim.id !== duplicateClaim.id),
          }
        })
        .filter((currentGroup) => (currentGroup.claims || []).length > 1)
      setDuplicateClaimGroups(nextDuplicateGroups)
      if (nextDuplicateGroups.length === 0) setShowDuplicateClaimReview(false)
      await refreshClaimsOverview()
      notify(`${duplicateClaim.claim_number || 'The duplicate claim'} moved to the Recycle Bin.`, 'success')
    } catch (err) {
      notify(err.message || 'Unable to move duplicate claim to the Recycle Bin.', 'error')
    } finally {
      setUpdatingStatus(null)
    }
  }

  // Admin / claims officer re-opens the dispensary medication edit window for 12 hours.
  const canReopenMca = canReopenMcaEditWindow(normalizedRole)
  const handleReopenMcaEdit = async (claim) => {
    if (!canReopenMca) {
      notify('Only an admin or claims officer can re-open the dispensary correction window.', 'warning')
      return
    }
    setReopenDispensaryClaim(claim)
    setReopenDispensaryReason('')
  }

  const closeReopenDispensaryModal = () => {
    setReopenDispensaryClaim(null)
    setReopenDispensaryReason('')
  }

  const confirmReopenMcaEdit = async () => {
    const claim = reopenDispensaryClaim
    if (!claim) return
    const reason = reopenDispensaryReason.trim()
    if (!reason) {
      notify('A reason is required to re-open the dispensary correction window.', 'warning')
      return
    }
    try {
      setUpdatingStatus(claim.id)
      await reopenBranchMcaEditWindow(claim.id, reason)
      closeReopenDispensaryModal()
      await refreshClaimsOverview()
      notify(`Dispensary correction window re-opened for ${claim.claim_number} (12 hours).`, 'success')
    } catch (err) {
      notify(err.message || 'Unable to re-open the dispensary correction window.', 'error')
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
      // ✅ NHIS PHARMACY LEVEL PATCH START
      medicineAccessLevel: drug.medicine_access_level || '',
      requiredPharmacyLevel: drug.required_pharmacy_level || '',
      // ✅ NHIS PHARMACY LEVEL PATCH END
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
    if (!(await requestActionConfirmation({
      eyebrow: 'NHIS catalog',
      title: 'Remove this medicine from the NHIS catalog?',
      details: [
        { label: 'Medicine', value: drug.description },
        { label: 'Code', value: drug.drug_code || drug.code },
      ],
      warning: 'This removes the catalog item from the active NHIS catalog view.',
      confirmText: 'Remove medicine',
      cancelText: 'Cancel',
    }))) return
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
  const openEditTariff = (tariff) => {
    setEditingTariff(tariff)
    setTariffForm({
      tariffVersion: tariff.tariff_version || 'FEB 2023',
      facilityGroup: tariff.facility_group || '',
      cateringOption: tariff.catering_option || '',
      mdc: tariff.mdc || '',
      gdrgCode: tariff.gdrg_code || '',
      description: tariff.description || '',
      ageBand: tariff.age_band || '',
      tariffAmount: String(tariff.tariff_amount ?? ''),
      currency: tariff.currency || 'GHS',
      sourceFile: tariff.source_file || '',
      sourcePage: tariff.source_page ? String(tariff.source_page) : '',
    })
  }

  const closeTariffModal = () => {
    setEditingTariff(null)
    setTariffForm(BLANK_NHIA_TARIFF)
  }

  const handleSaveTariff = async (e) => {
    e.preventDefault()
    if (!editingTariff) return
    try {
      setTariffSubmitting(true)
      await updateNhiaTariffItem(editingTariff.id, tariffForm)
      const fresh = await getAllNhiaTariffItems({
        facilityGroup: activeTariffFacilityGroup,
        cateringOption: activeTariffCateringOption,
      })
      setNhiaTariffItems(fresh)
      closeTariffModal()
      notify('G-DRG tariff updated.', 'success')
    } catch (err) {
      notify(err.message || 'Unable to save G-DRG tariff.', 'error')
    } finally {
      setTariffSubmitting(false)
    }
  }

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      notify('Please select an Excel file (.xlsx).', 'error')
      return
    }
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

  const handleDownloadTemplate = async () => {
    const blob = await generateNhisDrugTemplate()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'nhis-drug-template.xlsx'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleRuleFileSelect = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      notify('Please select an Excel file (.xlsx).', 'error')
      return
    }
    try {
      const { rows, errors } = await parseNhisClinicalRuleFile(file)
      setRuleImportRows(rows)
      setRuleImportErrors(errors)
      setShowRuleImportModal(true)
    } catch (err) {
      notify(err.message || 'Unable to parse clinical rules.', 'error')
    }
  }

  const handleConfirmRuleImport = async () => {
    if (!ruleImportRows.length) return
    try {
      setRuleImporting(true)
      const count = await upsertNhisClinicalRules(ruleImportRows, user?.id || null)
      setShowRuleImportModal(false)
      setRuleImportRows([])
      setRuleImportErrors([])
      const fresh = await getAllNhisClinicalRules()
      setClinicalRules(fresh)
      notify(`${count} clinical rules imported/updated.`, 'success')
    } catch (err) {
      notify(err.message || 'Clinical rule import failed.', 'error')
    } finally {
      setRuleImporting(false)
    }
  }

  const handleDownloadRuleTemplate = async () => {
    const blob = await generateNhisClinicalRuleTemplate()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'nhis-clinical-rule-template.xlsx'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // ── export ────────────────────────────────────────────────────
  const readinessIssueCounts = useMemo(() => {
    const counts = { all: readinessClaimIssues.length }
    for (const issue of readinessClaimIssues) {
      for (const category of getReadinessIssueCategories(issue)) {
        counts[category] = (counts[category] || 0) + 1
      }
    }
    return counts
  }, [readinessClaimIssues])

  const readinessNotIncludedCount = useMemo(
    () => readinessClaimIssues.filter(isReadinessIssueNotIncluded).length,
    [readinessClaimIssues]
  )

  const readinessExportBlockingCount = Math.max(0, readinessClaimIssues.length - readinessNotIncludedCount)

  const filteredDuplicateClaimGroups = useMemo(() =>
    duplicateClaimGroups.filter((group) => duplicateClaimGroupMatchesSearch(group, duplicateClaimSearch)),
  [duplicateClaimGroups, duplicateClaimSearch])

  const filteredReadinessClaimIssues = useMemo(() => {
    return readinessClaimIssues.filter((issue) => {
      const matchesFilter = readinessIssueFilter === 'all' ||
        getReadinessIssueCategories(issue).includes(readinessIssueFilter)
      return matchesFilter && readinessIssueMatchesSearch(issue, readinessIssueSearch)
    })
  }, [readinessClaimIssues, readinessIssueFilter, readinessIssueSearch])

  const filteredScrubWarningClaims = useMemo(() =>
    scrubWarningClaims.filter((issue) => readinessIssueMatchesSearch(issue, scrubWarningSearch)),
  [scrubWarningClaims, scrubWarningSearch])

  const readinessNavigation = useMemo(() => {
    const issues = filteredReadinessClaimIssues.length ? filteredReadinessClaimIssues : readinessClaimIssues
    const activeKey = normalizeLookupText(readinessActiveClaimId)
    const activeIndex = issues.findIndex((issue) => getReadinessIssueKey(issue) === activeKey)
    return {
      issues,
      activeIndex,
      previous: activeIndex > 0 ? issues[activeIndex - 1] : null,
      next: activeIndex >= 0 && activeIndex < issues.length - 1 ? issues[activeIndex + 1] : null,
    }
  }, [filteredReadinessClaimIssues, readinessActiveClaimId, readinessClaimIssues])
  const activeReadinessCorrection = useMemo(() => {
    if (!editingClaim || !readinessActiveClaimId) return null
    const issue = readinessNavigation.activeIndex >= 0
      ? readinessNavigation.issues[readinessNavigation.activeIndex]
      : readinessClaimIssues.find((item) => getReadinessIssueKey(item) === readinessActiveClaimId)
    if (!issue) return null
    const issueList = Array.isArray(issue.issues) && issue.issues.length
      ? issue.issues
      : ['Review this claim and complete the missing export requirements.']
    const patientName = issue.patientName || [issue.surname, issue.other_names].filter(Boolean).join(' ') || 'Unknown patient'
    return {
      claimNumber: issue.claim_number || issue.claimNumber || editingClaim.claim_number || 'Unnumbered claim',
      patientName,
      member: issue.member_no || issue.memberNo || issue.hin || '-',
      folder: issue.folder_no || issue.folderNo || '-',
      issues: issueList,
      position: readinessNavigation.activeIndex >= 0 ? readinessNavigation.activeIndex + 1 : null,
      total: readinessNavigation.issues.length || readinessClaimIssues.length,
    }
  }, [editingClaim, readinessActiveClaimId, readinessClaimIssues, readinessNavigation])

  const buildCurrentExportOptions = () => {
    const periodOptions = exportMode === 'custom'
      ? { mode: 'custom', fromDate: exportFromDate, toDate: exportToDate }
      : exportMode === 'partial'
        ? { mode: 'partial', toDate: exportToDate }
        : { mode: 'month', yearMonth: exportMonth }
    const submitDirectApi = directNhiaApiAvailable && exportRoute === 'direct_api'
    const selectedFormat = submitDirectApi ? 'json' : exportFormat
    return {
      periodOptions,
      submitDirectApi,
      selectedFormat,
      requestOptions: {
        ...periodOptions,
        ...getDirectNhiaOptions(),
        directSubmit: submitDirectApi,
        format: selectedFormat,
        directPayloadFormat: submitDirectApi ? 'json' : selectedFormat,
      },
    }
  }

  const getExportIssueReviewKey = (requestOptions = {}) => JSON.stringify({
    mode: requestOptions.mode || '',
    fromDate: requestOptions.fromDate || '',
    toDate: requestOptions.toDate || '',
    yearMonth: requestOptions.yearMonth || '',
    format: requestOptions.format || '',
    directSubmit: Boolean(requestOptions.directSubmit),
    organizationType,
  })

  const handleContinueExportAfterIssueReview = () => {
    const { requestOptions } = buildCurrentExportOptions()
    exportIssueReviewAckRef.current = getExportIssueReviewKey(requestOptions)
    setShowReadinessClaimReview(false)
    setShowExportModal(true)
    window.setTimeout(() => { void handleExport() }, 0)
  }

  const getExportProgressLabel = (progress = {}) => {
    const stage = normalizeText(progress.stage)
    if (!stage) return ''
    if (progress.total && Number.isFinite(Number(progress.current))) {
      return `${stage}: ${progress.current} of ${progress.total}`
    }
    return stage
  }

  const getDurationRepairRowKey = (row) => row.medicineId || `${row.claimId}:${row.medicineIndex}`
  const durationRepairEvaluatedRows = (durationRepairReview?.rows || []).map((row) => {
    const key = getDurationRepairRowKey(row)
    const enteredValue = normalizeText(durationRepairValues[key] ?? row.proposedValue)
    const canonicalManualValue = row.status === 'manual'
      ? normalizeNhisManualDurationCorrection(enteredValue)
      : null
    const manualReady = row.status === 'manual' && Boolean(canonicalManualValue)
    return { ...row, key, enteredValue, canonicalManualValue, manualReady }
  })
  const durationRepairUnresolvedCount = durationRepairEvaluatedRows.filter((row) => (
    row.status === 'manual' && !row.manualReady
  )).length
  const durationRepairCorrectionsReadyCount = durationRepairEvaluatedRows.filter((row) => (
    row.status === 'automatic' || row.manualReady
  )).length
  const durationRepairVisibleRows = durationRepairEvaluatedRows.filter((row) => {
    if (durationRepairFilter === 'valid') return row.status === 'valid'
    if (durationRepairFilter === 'automatic') return row.status === 'automatic' || row.manualReady
    if (durationRepairFilter === 'manual') return row.status === 'manual' && !row.manualReady
    return true
  })

  const focusDurationRepairRows = (focusFirstUnresolved = false) => {
    window.setTimeout(() => {
      durationRepairTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      if (focusFirstUnresolved) {
        durationRepairTableRef.current
          ?.querySelector('[data-duration-unresolved="true"]')
          ?.focus()
      }
    }, 0)
  }

  const selectDurationRepairFilter = (filter) => {
    setDurationRepairFilter(filter)
    focusDurationRepairRows(filter === 'manual')
  }

  const requestDurationRepairReview = (preparedReadiness, resumeTarget = { type: 'batch' }) => {
    const review = preparedReadiness?.durationRepairReview
      || buildNhisDurationRepairReview(preparedReadiness?.claims || [])
    if (!review.repairRows.length) return false
    const initialValues = {}
    review.repairRows.forEach((row) => {
      initialValues[row.medicineId || `${row.claimId}:${row.medicineIndex}`] = row.proposedValue || ''
    })
    durationRepairResumeTargetRef.current = resumeTarget
    setDurationRepairReview(review)
    setDurationRepairValues(initialValues)
    setDurationRepairFilter(review.manualReview ? 'manual' : 'automatic')
    setShowExportModal(false)
    if (review.manualReview) focusDurationRepairRows(true)
    notify(
      `${review.repairRows.length} medicine duration${review.repairRows.length === 1 ? '' : 's'} must be reviewed before export.`,
      review.manualReview ? 'error' : 'warning'
    )
    return true
  }

  const handleApplyDurationRepairs = async () => {
    if (!durationRepairReview) return
    const repairs = durationRepairReview.repairRows.map((row) => {
      const key = row.medicineId || `${row.claimId}:${row.medicineIndex}`
      const enteredValue = normalizeText(durationRepairValues[key])
      return {
        ...row,
        newValue: row.status === 'manual'
          ? normalizeNhisManualDurationCorrection(enteredValue)
          : enteredValue,
        repairType: row.status === 'automatic' ? 'automatic' : 'manual',
      }
    })
    const invalidRows = repairs.filter((repair) => (
      !repair.medicineId || !repair.newValue
    ))
    if (invalidRows.length) {
      setDurationRepairFilter('manual')
      focusDurationRepairRows(true)
      notify(
        `${invalidRows.length} duration${invalidRows.length === 1 ? '' : 's'} still need a positive whole number followed by day or days.`,
        'error'
      )
      return
    }

    try {
      setDurationRepairSaving(true)
      const repaired = await applyNhisDurationRepairs(repairs)
      preparedReadinessCacheRef.current = null
      setDurationRepairReview(null)
      setDurationRepairValues({})
      setDurationRepairFilter('all')
      await refreshClaimsOverview()
      notify(
        `${repaired.length} medicine duration${repaired.length === 1 ? '' : 's'} repaired and audited. Rescanning before export.`,
        'success'
      )
      const resumeTarget = durationRepairResumeTargetRef.current
      window.setTimeout(() => {
        if (resumeTarget?.type === 'single' && resumeTarget.claim) {
          void handleExportSingleClaim(resumeTarget.claim)
        } else {
          setShowExportModal(true)
          void handleExport()
        }
      }, 0)
    } catch (err) {
      notify(getNhisRequestErrorMessage(err, 'Duration repair failed.', 'No medicine durations were changed.'), 'error')
    } finally {
      setDurationRepairSaving(false)
    }
  }

  const applyExportReadinessError = (err, fallbackPrefix = 'Claim scrub failed.', options = {}) => {
    const { preserveFilter = false } = options
    if (isNhisDuplicateClaimsError(err)) {
      setReadinessClaimIssues([])
      setShowReadinessClaimReview(false)
      setDuplicateClaimGroups(err.duplicateGroups || [])
      setDuplicateExportIssues(err.exportBlockingIssues || [])
      setDuplicateClaimSearch('')
      setShowDuplicateClaimReview(true)
      notify(
        `${err.duplicateGroups?.length || 1} duplicate claim group${err.duplicateGroups?.length === 1 ? '' : 's'} found${err.exportBlockingIssues?.length ? ' with other export blockers' : ''}. Review and correct them before exporting.`,
        'error'
      )
      return true
    }
    if (isNhisReadinessClaimsError(err)) {
      setDuplicateClaimGroups([])
      setDuplicateExportIssues([])
      setShowDuplicateClaimReview(false)
      setReadinessClaimIssues(err.readinessIssues || [])
      if (!preserveFilter) setReadinessIssueFilter('all')
      setShowReadinessClaimReview(true)
      notify(
        `${err.readinessIssues?.length || 1} incomplete claim${err.readinessIssues?.length === 1 ? '' : 's'} found. Review and correct them before exporting.`,
        'error'
      )
      return true
    }
    notify(getNhisRequestErrorMessage(err, fallbackPrefix, 'Claims were not submitted/exported.'), 'error')
    return false
  }

  const handleCheckExportReadiness = async ({
    keepModalOpen = false,
    preserveFilter = false,
    showExportModalOnReady = false,
  } = {}) => {
    const { requestOptions, periodOptions, selectedFormat, submitDirectApi } = buildCurrentExportOptions()
    try {
      setReadinessChecking(true)
      setDuplicateClaimGroups([])
      setDuplicateExportIssues([])
      setShowDuplicateClaimReview(false)
      // checkNhisExportReadiness is the single source of truth for which claims
      // block export — it already validates every claim in the period (any
      // status), not just served/submitted ones. Its readinessIssues feed the
      // review modal below via applyExportReadinessError on failure.
      const preparedReadiness = await prepareNhisClaimsExport(requestOptions)
      if (requestDurationRepairReview(preparedReadiness, { type: 'batch' })) return
      const result = await checkNhisExportReadiness({ ...requestOptions, preparedReadiness })
      await tryLogAuditEvent({
        eventType: 'nhis_claim.scrub_batch',
        entityType: 'nhis_claims',
        entityId: null,
        action: 'scrub_all_claims',
        details: {
          result: 'passed',
          count: result.count,
          period: periodOptions,
          format: selectedFormat,
          direct_submit: submitDirectApi,
          user_id: user?.id || '',
          role,
        },
      })
      setReadinessClaimIssues([])
      if (!preserveFilter) setReadinessIssueFilter('all')
      setShowReadinessClaimReview(false)
      notify(
        showExportModalOnReady
          ? `All clear. ${result.count} claim${result.count === 1 ? '' : 's'} ready for export.`
          : `${result.count} claim${result.count === 1 ? '' : 's'} ready for export.`,
        'success'
      )
      if (showExportModalOnReady) setShowExportModal(true)
      if (!keepModalOpen) setShowExportModal(false)
    } catch (err) {
      await tryLogAuditEvent({
        eventType: 'nhis_claim.scrub_batch',
        entityType: 'nhis_claims',
        entityId: null,
        action: 'scrub_all_claims',
        details: {
          result: 'failed',
          period: periodOptions,
          format: selectedFormat,
          direct_submit: submitDirectApi,
          duplicate_summary: isNhisDuplicateClaimsError(err) ? getDuplicateScrubAuditSummary(err.duplicateGroups || []) : null,
          readiness_summary: isNhisReadinessClaimsError(err) ? getScrubIssueAuditSummary(err.readinessIssues || []) : null,
          export_blocker_count: Array.isArray(err.exportBlockingIssues) ? err.exportBlockingIssues.length : 0,
          message: err.message || '',
          user_id: user?.id || '',
          role,
        },
      })
      applyExportReadinessError(err, 'Claim scrub failed.', { preserveFilter })
    } finally {
      setReadinessChecking(false)
    }
  }

  const handleScrubClaim = async (claim) => {
    // The claim's data may change from here — any cached readiness from a
    // prior export check is no longer trustworthy.
    preparedReadinessCacheRef.current = null
    exportIssueReviewAckRef.current = ''
    await tryLogAuditEvent({
      eventType: 'nhis_claim.scrub_claim',
      entityType: 'nhis_claims',
      entityId: claim?.id || '',
      action: 'open_claim_scrub',
      details: {
        claim_number: claim?.claim_number || claim?.claimNumber || '',
        status: claim?.status || '',
        user_id: user?.id || '',
        role,
      },
    })
    return openEditClaim(claim)
  }

  const openReadinessIssueForEdit = async (issue) => {
    // Same reasoning as handleScrubClaim above.
    preparedReadinessCacheRef.current = null
    exportIssueReviewAckRef.current = ''
    const claimForAction = { ...issue, _summaryOnly: true }
    setReadinessActiveClaimId(getReadinessIssueKey(issue))
    setShowReadinessClaimReview(false)
    setShowExportModal(false)
    const opened = await openEditClaim(claimForAction)
    if (!opened) returnToReadinessClaimReview()
    return opened
  }

  const handleExport = async (warningOverrideReason = '') => {
    // Synchronous ref check, before any awaited work — the approval action
    // can only ever invoke the export pipeline once at a time.
    if (exportInFlightRef.current) {
      notify('Export is already running. Please wait for it to finish.', 'info')
      return
    }
    const exportRunId = crypto.randomUUID()
    const overrideReason = normalizeText(warningOverrideReason)
    let lastStage = 'starting export'
    try {
      exportInFlightRef.current = true
      setExporting(true)
      setExportStartedAt(Date.now())
      setExportProgress('Preparing export')
      setDuplicateClaimGroups([])
      setDuplicateExportIssues([])
      setShowDuplicateClaimReview(false)
      setReadinessClaimIssues([])
      setReadinessFixedCount(0)
      setShowReadinessClaimReview(false)
      const { submitDirectApi, selectedFormat, requestOptions } = buildCurrentExportOptions()
      const cacheFingerprint = JSON.stringify({ requestOptions, selectedFormat, submitDirectApi })
      const periodLabel = exportMode === 'custom'
        ? `${exportFromDate} to ${exportToDate}`
        : exportMode === 'partial'
          ? `${exportToDate.slice(0, 7)}-01 to ${exportToDate}`
          : exportMonth
      const progressOptions = {
        ...requestOptions,
        exportRunId,
        onProgress: (progress) => {
          lastStage = getExportProgressLabel(progress) || lastStage
          setExportProgress(lastStage)
        },
        onTiming: (entry) => {
          if (entry?.durationMs >= 1000 && typeof console !== 'undefined') {
            console.info(`[NHIS export timing] [${exportRunId}]`, entry)
          }
        },
      }

      // Reuse the readiness computed by the check that just showed the scrub
      // warning dialog, instead of recomputing claims/blockers/warnings a
      // second time for the same click-through. Only trusted when the export
      // options are unchanged and an override reason is actually present —
      // i.e. this really is the immediate follow-up to that specific check.
      const cached = preparedReadinessCacheRef.current
      const canReuseCache = Boolean(overrideReason) && cached && cached.fingerprint === cacheFingerprint
      let preparedReadiness
      if (canReuseCache) {
        preparedReadiness = cached.preparedReadiness
      } else {
        preparedReadiness = await prepareNhisClaimsExport(progressOptions)
        if (requestDurationRepairReview(preparedReadiness, { type: 'batch' })) return
        await checkNhisExportReadiness({ ...progressOptions, preparedReadiness })
      }
      const warningClaims = preparedReadiness.warningClaims || []
      if (warningClaims.length && !overrideReason) {
        exportResumeTargetRef.current = { type: 'batch' }
        preparedReadinessCacheRef.current = { fingerprint: cacheFingerprint, preparedReadiness }
        setScrubWarningClaims(warningClaims)
        setScrubWarningOverrideReason('')
        setScrubWarningSearch('')
        setShowScrubWarningOverride(true)
        notify(
          `${warningClaims.length} claim${warningClaims.length === 1 ? '' : 's'} have scrub warnings. Enter an override reason before exporting.`,
          'warning'
        )
        return
      }
      // Consumed — never reused beyond this single approval.
      preparedReadinessCacheRef.current = null
      if (warningClaims.length && overrideReason) {
        await tryLogAuditEvent({
          eventType: 'nhis_claim.scrub_warning_override',
          entityType: 'nhis_claims',
          entityId: null,
          action: 'override_warnings_for_export',
          details: {
            reason: overrideReason,
            warning_summary: getScrubIssueAuditSummary(warningClaims),
            period: requestOptions.mode === 'custom'
              ? { mode: 'custom', fromDate: requestOptions.fromDate, toDate: requestOptions.toDate }
              : requestOptions.mode === 'partial'
                ? { mode: 'partial', toDate: requestOptions.toDate }
                : { mode: 'month', yearMonth: requestOptions.yearMonth },
            format: selectedFormat,
            direct_submit: submitDirectApi,
            user_id: user?.id || '',
            role,
            export_run_id: exportRunId,
          },
        })
      }
      const exportResult = await exportNhisClaimsFile({ ...progressOptions, preparedReadiness })
      const count = typeof exportResult === 'number' ? exportResult : exportResult?.count || 0
      setShowScrubWarningOverride(false)
      setScrubWarningClaims([])
      setScrubWarningOverrideReason('')
      setScrubWarningSearch('')
      setShowExportModal(false)
      await refreshClaimsOverview()
      notify(
        exportResult?.queued
          ? `${count} claims queued for CLAIM-it bridge submission for ${periodLabel}. They will retry automatically.`
          : submitDirectApi
            ? `${count} claims submitted through the Direct API for ${periodLabel}. Served claims marked as Submitted.`
          : `${count} claims exported as ${selectedFormat.toUpperCase()} for ${periodLabel}. Manual CLAIM-it import required.`,
        'success'
      )
    } catch (err) {
      preparedReadinessCacheRef.current = null
      const isStructuredReadinessError = isNhisDuplicateClaimsError(err) || isNhisReadinessClaimsError(err)
      applyExportReadinessError(
        err,
        isStructuredReadinessError ? 'Export failed.' : `Export failed while ${lastStage.toLowerCase()}.`
      )
    } finally {
      exportIssueReviewAckRef.current = ''
      exportInFlightRef.current = false
      setExporting(false)
      setExportProgress('')
      setExportStartedAt(null)
    }
  }

  // Exports one claim through the exact same readiness/blocking/warning
  // pipeline as handleExport above (via prepareNhisSingleClaimExport, which
  // feeds getNhisExportClaimsAndBlockers an explicit one-claim list instead
  // of a date period) — no export rule differs between this and a batch
  // export. Shares exportInFlightRef/preparedReadinessCacheRef with the
  // batch flow so the two can never run concurrently or clobber each other's
  // cached readiness.
  const handleExportSingleClaim = async (claim, warningOverrideReason = '') => {
    if (exportInFlightRef.current) {
      notify('Export is already running. Please wait for it to finish.', 'info')
      return
    }
    const exportRunId = crypto.randomUUID()
    const overrideReason = normalizeText(warningOverrideReason)
    const requestOptions = { ...getDirectNhiaOptions(), format: 'cxf' }
    const cacheFingerprint = JSON.stringify({ singleClaimId: claim.id, requestOptions })
    let lastStage = 'starting export'
    try {
      exportInFlightRef.current = true
      setClaimActionLoading({ claimId: claim.id, action: 'export' })
      setExporting(true)
      setExportStartedAt(Date.now())
      setExportProgress('Preparing export')
      setDuplicateClaimGroups([])
      setDuplicateExportIssues([])
      setShowDuplicateClaimReview(false)
      setReadinessClaimIssues([])
      setReadinessFixedCount(0)
      setShowReadinessClaimReview(false)
      const progressOptions = {
        ...requestOptions,
        exportRunId,
        onProgress: (progress) => {
          lastStage = getExportProgressLabel(progress) || lastStage
          setExportProgress(lastStage)
        },
        onTiming: (entry) => {
          if (entry?.durationMs >= 1000 && typeof console !== 'undefined') {
            console.info(`[NHIS export timing] [${exportRunId}]`, entry)
          }
        },
      }

      const cached = preparedReadinessCacheRef.current
      const canReuseCache = Boolean(overrideReason) && cached && cached.fingerprint === cacheFingerprint
      let preparedReadiness
      if (canReuseCache) {
        preparedReadiness = cached.preparedReadiness
      } else {
        preparedReadiness = await prepareNhisSingleClaimExport(claim.id, progressOptions)
        if (requestDurationRepairReview(preparedReadiness, { type: 'single', claim })) return
        await checkNhisExportReadiness({ ...progressOptions, preparedReadiness })
      }
      const warningClaims = preparedReadiness.warningClaims || []
      if (warningClaims.length && !overrideReason) {
        exportResumeTargetRef.current = { type: 'single', claim }
        preparedReadinessCacheRef.current = { fingerprint: cacheFingerprint, preparedReadiness }
        setScrubWarningClaims(warningClaims)
        setScrubWarningOverrideReason('')
        setScrubWarningSearch('')
        setShowScrubWarningOverride(true)
        notify(
          `${warningClaims.length} claim${warningClaims.length === 1 ? '' : 's'} have scrub warnings. Enter an override reason before exporting.`,
          'warning'
        )
        return
      }
      preparedReadinessCacheRef.current = null
      if (warningClaims.length && overrideReason) {
        await tryLogAuditEvent({
          eventType: 'nhis_claim.scrub_warning_override',
          entityType: 'nhis_claims',
          entityId: claim.id,
          action: 'override_warnings_for_export',
          details: {
            reason: overrideReason,
            warning_summary: getScrubIssueAuditSummary(warningClaims),
            claim_number: claim.claim_number || claim.claimNumber || '',
            format: 'cxf',
            user_id: user?.id || '',
            role,
            export_run_id: exportRunId,
          },
        })
      }
      const exportResult = await exportNhisClaimsFile({ ...progressOptions, preparedReadiness })
      const count = typeof exportResult === 'number' ? exportResult : exportResult?.count || 0
      setShowScrubWarningOverride(false)
      setScrubWarningClaims([])
      setScrubWarningOverrideReason('')
      setScrubWarningSearch('')
      await refreshClaimsOverview()
      notify(
        count
          ? `Claim ${claim.claim_number || claim.claimNumber || ''} exported as CXF. Manual CLAIM-it import required.`
          : 'Export completed.',
        'success'
      )
    } catch (err) {
      preparedReadinessCacheRef.current = null
      const isStructuredReadinessError = isNhisDuplicateClaimsError(err) || isNhisReadinessClaimsError(err)
      applyExportReadinessError(
        err,
        isStructuredReadinessError ? 'Export failed.' : `Export failed while ${lastStage.toLowerCase()}.`
      )
    } finally {
      exportIssueReviewAckRef.current = ''
      exportInFlightRef.current = false
      setClaimActionLoading(null)
      setExporting(false)
      setExportProgress('')
      setExportStartedAt(null)
    }
  }

  // ─────────────────────────────────────────────────────────────
  const exportPeriodReady = exportMode === 'custom'
    ? Boolean(exportFromDate && exportToDate && exportFromDate <= exportToDate)
    : exportMode === 'partial'
      ? Boolean(exportToDate)
      : Boolean(exportMonth)

  return (
    <div className="nhis-page">
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">NHIS</h1>
          <p className="page-subtitle">{nhisPageSubtitle}</p>
        </div>
        <div className="header-actions">
          {canViewReports && (
            <Link className="btn btn-secondary" to="/reports">
              <FileText size={16} /> NHIS Reports
            </Link>
          )}
          {(pageTab === 'claims' || pageTab === 'patients') && canServeNhisMedicines && (
            <>
              {pageTab === 'claims' && canWrite && (
                <button className="btn btn-secondary" onClick={() => setShowExportModal(true)}>
                  <Download size={16} /> {directNhiaApiAvailable ? 'Transfer Claims' : 'Export CXF'}
                </button>
              )}
              {canWrite && (
                <button className="btn btn-primary" onClick={openNewClaimModal}>
                  <Plus size={16} /> New Claim
                </button>
              )}
            </>
          )}
          {pageTab === 'catalog' && canWrite && (
            <>
              <button className="btn btn-secondary" onClick={handleDownloadTemplate}>
                <FileSpreadsheet size={16} /> Template
              </button>
              <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()}>
                <Upload size={16} /> Import Excel
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                style={{ display: 'none' }}
                onChange={handleFileSelect}
              />
              <button className="btn btn-primary" onClick={openAddDrug}>
                <Plus size={16} /> Add Drug
              </button>
            </>
          )}
          {pageTab === 'rules' && canWrite && isHospital && (
            <>
              <button className="btn btn-secondary" onClick={handleDownloadRuleTemplate}>
                <FileSpreadsheet size={16} /> Template
              </button>
              <button className="btn btn-secondary" onClick={() => ruleFileInputRef.current?.click()}>
                <Upload size={16} /> Import Rules
              </button>
              <input
                ref={ruleFileInputRef}
                type="file"
                accept=".xlsx"
                style={{ display: 'none' }}
                onChange={handleRuleFileSelect}
              />
            </>
          )}
        </div>
      </div>

      {error && <div className="nhis-alert" role="alert">{error}</div>}
      {catalogSeeding && (
        <div className="nhis-alert" role="status">
          Loading default NHIS medicines for this facility...
        </div>
      )}

      {/* Page sub-tabs */}
      <div className="nhis-page-tabs">
        <button
          className={`nhis-page-tab ${pageTab === 'claims' ? 'active' : ''}`}
          onClick={() => setPageTab('claims')}
        >
          <HeartPulse size={16} /> Claims
        </button>
        <button
          className={`nhis-page-tab ${pageTab === 'patients' ? 'active' : ''}`}
          onClick={() => setPageTab('patients')}
        >
          <Users size={16} /> NHIS Patients
        </button>
        <button
          className={`nhis-page-tab ${pageTab === 'prescribers' ? 'active' : ''}`}
          onClick={() => setPageTab('prescribers')}
        >
          <Stethoscope size={16} /> Prescribers
        </button>
        <button
          className={`nhis-page-tab ${pageTab === 'facilities' ? 'active' : ''}`}
          onClick={() => setPageTab('facilities')}
        >
          <Building2 size={16} /> Prescribing Facilities
        </button>
        <button
          className={`nhis-page-tab ${pageTab === 'catalog' ? 'active' : ''}`}
          onClick={() => setPageTab('catalog')}
        >
          <FileSpreadsheet size={16} /> Drug Catalog
        </button>
        <button
          className={`nhis-page-tab ${pageTab === 'gdrg' ? 'active' : ''}`}
          onClick={() => setPageTab('gdrg')}
        >
          <FileSpreadsheet size={16} /> G-DRG Catalog
        </button>
        <button
          className={`nhis-page-tab ${pageTab === 'review' ? 'active' : ''}`}
          onClick={() => setPageTab('review')}
        >
          <CheckCircle2 size={16} /> Config Review
        </button>
        {isHospital && (
          <button
            className={`nhis-page-tab ${pageTab === 'rules' ? 'active' : ''}`}
            onClick={() => setPageTab('rules')}
          >
            <CheckCircle2 size={16} /> Clinical Rules
          </button>
        )}
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
            <div className="stat-box approved">
              <span className="stat-label">Claims Value</span>
              <span className="stat-value">{fmtCurrency(stats.totalClaimValue)}</span>
            </div>
            <div className="stat-box approved">
              <span className="stat-label">Paid Value</span>
              <span className="stat-value">{fmtCurrency(stats.totalPaid)}</span>
            </div>
            <div className="stat-box pending">
              <span className="stat-label">Pending Serving</span>
              <span className="stat-value">{stats.pending_serving || 0}</span>
            </div>
            <div className="stat-box pending">
              <span className="stat-label">For Review</span>
              <span className="stat-value">{stats.returned_for_review || 0}</span>
            </div>
            <div className="stat-box pending">
              <span className="stat-label">Claim Ready</span>
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
              {CLAIM_STATUS_TABS
                .filter((tab) => !isMedicineCounterAssistant || tab !== 'draft')
                .map((tab) => (
                <button
                  key={tab}
                  className={`tab-btn ${claimTab === tab ? 'active' : ''}`}
                  onClick={() => setStatusTab(tab)}
                >
                  {getClaimStatusLabel(tab)}
                  {tab !== 'all' && stats[tab] > 0 && (
                    <span className="tab-count">{stats[tab]}</span>
                  )}
                </button>
                ))}
            </div>
            <div className="nhis-date-filter">
              <select
                value={claimDateFilter}
                onChange={(event) => {
                  setClaimsPage(1)
                  setClaimIssueFilter('all')
                  setClaimDateFilter(event.target.value)
                }}
                aria-label="Filter claims by date"
              >
                <option value="month">Current month</option>
                <option value="previous_month">Previous month</option>
                <option value="open">All open claims</option>
                <option value="all">All dates</option>
                <option value="today">Today</option>
                <option value="week">This week</option>
                <option value="custom">Custom date range</option>
              </select>
              {claimDateFilter === 'custom' && (
                <>
                  <input
                    type="date"
                    value={claimFromDate}
                    onChange={(event) => {
                      setClaimsPage(1)
                      setClaimIssueFilter('all')
                      setClaimFromDate(event.target.value)
                    }}
                    aria-label="Claims from date"
                  />
                  <input
                    type="date"
                    value={claimToDate}
                    onChange={(event) => {
                      setClaimsPage(1)
                      setClaimIssueFilter('all')
                      setClaimToDate(event.target.value)
                    }}
                    aria-label="Claims to date"
                  />
                </>
              )}
            </div>
            <div className="search-box">
              <Search size={16} className="search-icon" />
              <input
                className="search-input"
                placeholder="Search by name, member no, claim #..."
                value={claimSearch}
                onChange={(e) => {
                  setClaimsPage(1)
                  setClaimSearch(e.target.value)
                }}
              />
            </div>
            <div className="claim-issue-filter-tabs" aria-label="Filter claims by issue">
              {CLAIM_ISSUE_FILTERS.map((filter) => {
                const count = filter.id === 'all'
                  ? claimsTotal
                  : filter.id === 'any'
                    ? claimIssueCounts.all || 0
                    : claimIssueCounts[filter.id] || 0
                return (
                  <button
                    key={filter.id}
                    type="button"
                    className={claimIssueFilter === filter.id ? 'active' : ''}
                    disabled={filter.id !== 'all' && count === 0}
                    onClick={() => {
                      setClaimsPage(1)
                      setClaimIssueFilter(filter.id)
                    }}
                  >
                    {filter.label} <span>{claimIssueCountsLoading ? '...' : count}</span>
                  </button>
                )
              })}
              <button
                type="button"
                className="claim-issue-filter-action"
                disabled={openingFirstClaimIssue || activeClaimIssueCount === 0}
                onClick={() => { void openFirstClaimIssue() }}
              >
                <Pencil size={13} />
                {openingFirstClaimIssue
                  ? 'Opening issue...'
                  : `Open first ${claimIssueFilter === 'all' ? 'issue' : activeClaimIssueFilter?.label?.toLowerCase() || 'issue'}`}
              </button>
            </div>
          </div>

          {(loading || claimsPageLoading || claimIssueCountsLoading || nhiaSettingsLoading || facilitySettingsLoading) && (
            <div className="nhis-loading-strip" role="status" aria-live="polite">
              {loading && <span>Loading NHIS workspace...</span>}
              {claimsPageLoading && <span>Refreshing claims...</span>}
              {claimIssueCountsLoading && <span>Checking claim issues...</span>}
              {nhiaSettingsLoading && <span>Loading NHIA facility settings...</span>}
              {facilitySettingsLoading && <span>Loading facility profile...</span>}
            </div>
          )}

          <div className={`nhis-readiness-summary ${claimIssueCounts.all > 0 ? 'has-issues' : 'is-ready'}`}>
            <div className="nhis-readiness-summary-main">
              <div>
                <span className="nhis-readiness-kicker">NHIS Claims Scrubber</span>
                <strong>
                  {claimIssueCountsLoading
                    ? 'Checking claim issues...'
                    : claimIssueCounts.all > 0
                      ? `${claimIssueCounts.all} claim issue${claimIssueCounts.all === 1 ? '' : 's'} need attention`
                      : 'No claim issues found in this view'}
                </strong>
                <small>
                  {claimViewReadinessLabel} · {claimsTotal} claim{claimsTotal === 1 ? '' : 's'} in the current filters.
                  {' '}Run the final claims scrub before downloading the CLAIM-it file.
                </small>
              </div>
              <div className="nhis-readiness-summary-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={openingFirstClaimIssue || claimIssueCounts.all === 0}
                  onClick={() => { void reviewClaimIssueFilter('any') }}
                >
                  <Pencil size={14} /> Review first issue
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={readinessChecking || !exportPeriodReady}
                  onClick={() => setShowExportModal(true)}
                >
                  <CheckCircle2 size={14} /> Final export check
                </button>
              </div>
            </div>
            <div className="nhis-readiness-summary-grid">
              {claimViewReadinessItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`nhis-readiness-summary-card nhis-readiness-summary-card--${item.tone}`}
                  disabled={claimIssueCountsLoading || item.count === 0 || openingFirstClaimIssue}
                  onClick={() => { void reviewClaimIssueFilter(item.key) }}
                >
                  <span>{item.label}</span>
                  <strong>{claimIssueCountsLoading ? '...' : item.count}</strong>
                </button>
              ))}
              <button
                type="button"
                className={`nhis-readiness-summary-card nhis-readiness-summary-card--${duplicateClaimGroups.length > 0 ? 'danger' : 'neutral'}`}
                disabled={readinessChecking}
                onClick={() => { void handleCheckExportReadiness({ showExportModalOnReady: true }) }}
              >
                <span>Duplicate scan</span>
                <strong>{readinessChecking ? '...' : duplicateClaimGroups.length > 0 ? duplicateClaimGroups.length : 'Check'}</strong>
              </button>
            </div>
          </div>

          {carriedOverStats.count > 0 && claimDateFilter !== 'open' && (
            <div className="nhis-carried-over-card">
              <div>
                <strong>{carriedOverStats.count} carried-over open claim{carriedOverStats.count === 1 ? '' : 's'}</strong>
                <span>
                  Oldest from {formatClaimMonthLabel(carriedOverStats.oldestDate)}
                  {Number.isFinite(carriedOverStats.oldestAgeDays) ? `, pending ${carriedOverStats.oldestAgeDays} day${carriedOverStats.oldestAgeDays === 1 ? '' : 's'}` : ''}
                  {' '}· {fmtCurrency(carriedOverStats.totalAmount)}
                </span>
              </div>
              <button type="button" onClick={() => setClaimDateFilter('open')}>
                View all open claims
              </button>
            </div>
          )}

          {renderClaimsPagination('top')}

          {/* Claims table */}
          <div className="nhis-table-wrap" ref={claimsTableRef}>
            {loading || claimsPageLoading ? (
              <div className="nhis-empty">{claimsPageLoading ? 'Loading claims page...' : 'Loading claims...'}</div>
            ) : filteredClaims.length === 0 ? (
              <div className="nhis-empty">
                {visibleNhisPatients.length > 0 ? (
                  <>
                    <HeartPulse size={40} />
                    <p>No claims found, but NHIS patients are available.</p>
                    <div className="nhis-patient-fallback">
                      <div className="nhis-patient-fallback__header">
                        <strong>Known NHIS patients</strong>
                        <span>{visibleNhisPatients.length} shown</span>
                      </div>
                      <table className="nhis-table">
                        <thead>
                          <tr>
                            <th>Patient</th>
                            <th>Member No / HIN</th>
                            <th>Details</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleNhisPatients.map((patient) => (
                            <tr key={patientSearchKey(patient)}>
                              <td>
                                <div className="patient-name">{formatPatientLookupName(patient)}</div>
                                {getPatientPhone(patient) && <div className="patient-meta">{getPatientPhone(patient)}</div>}
                                {getPatientAddress(patient) && <div className="patient-meta">{getPatientAddress(patient)}</div>}
                              </td>
                              <td>
                                {getPatientMemberNumber(patient) && (
                                  <div>{getPatientMemberNumber(patient)}</div>
                                )}
                                {getPatientHin(patient) && <div className="patient-meta">HIN: {getPatientHin(patient)}</div>}
                              </td>
                              <td>
                                {getPatientFolderNo(patient) && <div>Folder: {getPatientFolderNo(patient)}</div>}
                                {getPatientGender(patient) && <div className="patient-meta">Gender: {getPatientGender(patient)}</div>}
                                {getPatientDateOfBirth(patient) && <div className="patient-meta">DOB: {formatAppDate(getPatientDateOfBirth(patient))}</div>}
                                {getPatientInsuranceProvider(patient) && <div className="patient-meta">{getPatientInsuranceProvider(patient)}</div>}
                                {!getPatientFolderNo(patient) &&
                                  !getPatientGender(patient) &&
                                  !getPatientDateOfBirth(patient) &&
                                  !getPatientInsuranceProvider(patient) && (
                                    <span className="patient-meta">-</span>
                                  )}
                              </td>
                              <td>
                                {canWrite && (
                                  <button
                                    type="button"
                                    className="btn btn-primary btn-sm"
                                    onClick={() => openNewClaimForPatient(patient)}
                                  >
                                    <Plus size={14} /> New Claim
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <>
                    <HeartPulse size={40} />
                    <p>No claims found.</p>
                  </>
                )}
                {canWrite && (
                  <button className="btn btn-primary" onClick={openNewClaimModal}>
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
                    <th>Service Date / Time</th>
                    <th>Medicines</th>
                    <th>Rx File</th>
                    <th>Total</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredClaims.map((c) => {
                    const issueBadges = getNhisClaimIssueBadges(c)
                    return (
                    <tr key={c.id}>
                      <td className="claim-number">{c.claim_number}</td>
                      <td>
                        <div className="patient-name">{c.surname} {c.other_names || ''}</div>
                        {c.folder_no && <div className="patient-meta">Folder: {c.folder_no}</div>}
                        {issueBadges.length > 0 && (
                          <div className="claim-issue-badges">
                            {issueBadges.map((badge) => (
                              <span key={badge.key} className={`claim-issue-badge claim-issue-badge--${badge.tone}`}>
                                {badge.label}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        {c.member_no && <div>{c.member_no}</div>}
                        {c.hin       && <div className="patient-meta">HIN: {c.hin}</div>}
                      </td>
                      <td>
                        {formatNhisServiceDateTime(c)}
                        {OPEN_CLAIM_STATUSES.has(c.status) && getClaimServiceDateKey(c) < monthStartIsoDate() && (
                          <span className="nhis-carry-badge">
                            Carried over from {formatClaimMonthLabel(getClaimServiceDateKey(c))}
                            {Number.isFinite(getClaimAgeDays(getClaimServiceDateKey(c))) ? ` · ${getClaimAgeDays(getClaimServiceDateKey(c))}d` : ''}
                          </span>
                        )}
                      </td>
                      <td>
                        {c.nhis_claim_medicines?.length || 0}
                        {['pending_serving', 'serving_in_progress', 'returned_for_review'].includes(c.status) &&
                          getNhisIncompleteIntakeItems({
                            claim: c,
                            medicines: c.nhis_claim_medicines || [],
                          }).length > 0 && (
                            <span className="nhis-incomplete-intake-badge">Incomplete Intake</span>
                          )}
                      </td>
                      <td>
                        {(c.prescription_file_path || c.prescription_file_url) ? (
                          <button
                            type="button"
                            className="action-btn action-btn--view"
                            title="Open prescription file"
                            onClick={() => openPrescriptionPdf(c)}
                          >
                            <FileText size={14} />
                          </button>
                        ) : (
                          <span className="patient-meta">-</span>
                        )}
                      </td>
                      <td>{fmtCurrency(c.total_amount)}</td>
                      <td>
                        <StatusBadge
                          status={c.status}
                          incomplete={c.status === 'served' && isIncompletePharmacyClaim(c)}
                        />
                      </td>
                      <td className="nhis-actions">
                        <button
                          className="action-btn action-btn--view"
                          title="View"
                          disabled={isClaimBusy(c.id)}
                          onClick={() => { void openViewClaim(c) }}
                        >
                          {isClaimActionBusy(c.id, 'view') ? <Clock size={14} /> : <Eye size={14} />}
                        </button>
                        <button
                          className="action-btn action-btn--view"
                          title="Scrub Claim"
                          disabled={isClaimBusy(c.id)}
                          onClick={() => { void handleScrubClaim(c) }}
                        >
                          {isClaimActionBusy(c.id, 'edit') ? <Clock size={14} /> : <HeartPulse size={14} />}
                        </button>
                        <button
                          className="action-btn action-btn--view"
                          title="Export claim (CXF)"
                          disabled={isClaimBusy(c.id)}
                          onClick={() => { void handleExportSingleClaim(c) }}
                        >
                          {isClaimActionBusy(c.id, 'export') ? <Clock size={14} /> : <Download size={14} />}
                        </button>
                        {canServeNhisMedicines && (
                          isMedicineCounterAssistant
                            ? canMcaOpenNhisClaimForServing(c)
                            : (['pending_serving', 'returned_for_review', 'served'].includes(c.status) ||
                              (canEditNhisClaimAnytime && canCorrectNhisClaimStatus(c.status)))
                        ) && (
                          <button
                            className="action-btn action-btn--edit"
                            title={isMedicineCounterAssistant ? 'Serve medicines' : canEditNhisClaimAnytime ? 'Edit claim' : 'Edit before submission/export'}
                            disabled={isClaimBusy(c.id)}
                            onClick={() => { void openEditClaim(c) }}
                          >
                            {isClaimActionBusy(c.id, 'edit') ? <Clock size={14} /> : <Pencil size={14} />}
                          </button>
                        )}
                        {canReopenMca && c.status === 'served' && !isNhisClaimDirectlyServed(c) && !isMcaEditWindowOpen(c) && (
                          <button
                            className="action-btn action-btn--edit"
                            title="Re-open dispensary correction window (12 hours)"
                            disabled={isClaimBusy(c.id)}
                            onClick={() => handleReopenMcaEdit(c)}
                          >
                            <Clock size={14} />
                          </button>
                        )}
                        {c.status === 'served' && canWrite && (
                          <button
                            className="action-btn action-btn--submit"
                            title={
                              isIncompletePharmacyClaim(c)
                                ? 'Attach the prescription before submitting this pharmacy claim'
                                : directNhiaApiAvailable ? 'Submit directly to NHIA' : 'Mark as Submitted'
                            }
                            disabled={isClaimBusy(c.id) || isIncompletePharmacyClaim(c)}
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
                              disabled={isClaimBusy(c.id)}
                              onClick={() => handleStatusUpdate(c, 'paid')}
                            >
                              <Banknote size={14} />
                            </button>
                            <button
                              className="action-btn action-btn--cancel"
                              title="Reject"
                              disabled={isClaimBusy(c.id)}
                              onClick={() => { setRejectTarget(c); setRejectReason('') }}
                            >
                              <XCircle size={14} />
                            </button>
                          </>
                        )}
                        {canDeleteNhisClaims && (
                          <button
                            className="action-btn action-btn--cancel"
                            title="Delete claim"
                            disabled={isClaimBusy(c.id)}
                            onClick={() => handleDeleteClaim(c)}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
          {renderClaimsPagination('bottom')}
          {!loading && filteredClaims.length > 0 && visibleNhisPatients.length > 0 && (
            <div className="nhis-known-patients-summary">
              <span>{visibleNhisPatients.length} known NHIS patient{visibleNhisPatients.length === 1 ? '' : 's'} available</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPageTab('patients')}>
                Open Patients
              </button>
            </div>
          )}
        </>
      )}

      {/* ── CATALOG TAB ───────────────────────────────────────────── */}
      {pageTab === 'patients' && (
        <>
          <div className="nhis-controls">
            <div className="search-box">
              <Search size={16} className="search-icon" />
              <input
                className="search-input"
                placeholder="Search NHIS patients by name, member no, HIN, folder, phone..."
                value={nhisPatientSearch}
                onChange={(event) => setNhisPatientSearch(event.target.value)}
              />
            </div>
            <span className="catalog-count">{filteredNhisPatients.length} NHIS patients</span>
          </div>

          <div className="nhis-table-wrap">
            {loading ? (
              <div className="nhis-empty">Loading NHIS patients...</div>
            ) : filteredNhisPatients.length === 0 ? (
              <div className="nhis-empty">
                <Users size={40} />
                <p>No NHIS patients found.</p>
                {canWrite && (
                  <button className="btn btn-primary" onClick={openNewClaimModal}>
                    <Plus size={16} /> New Claim
                  </button>
                )}
              </div>
            ) : (
              <table className="nhis-table">
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Member No / HIN</th>
                    <th>Details</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredNhisPatients.map((patient) => (
                    <tr key={patientSearchKey(patient)}>
                      <td>
                        <div className="patient-name">{formatPatientLookupName(patient)}</div>
                        {getPatientPhone(patient) && <div className="patient-meta">{getPatientPhone(patient)}</div>}
                        {getPatientAddress(patient) && <div className="patient-meta">{getPatientAddress(patient)}</div>}
                      </td>
                      <td>
                        {getPatientMemberNumber(patient) && (
                          <div>{getPatientMemberNumber(patient)}</div>
                        )}
                        {getPatientHin(patient) && <div className="patient-meta">HIN: {getPatientHin(patient)}</div>}
                      </td>
                      <td>
                        {getPatientFolderNo(patient) && <div>Folder: {getPatientFolderNo(patient)}</div>}
                        {getPatientGender(patient) && <div className="patient-meta">Gender: {getPatientGender(patient)}</div>}
                        {getPatientDateOfBirth(patient) && <div className="patient-meta">DOB: {formatAppDate(getPatientDateOfBirth(patient))}</div>}
                        {getPatientInsuranceProvider(patient) && <div className="patient-meta">{getPatientInsuranceProvider(patient)}</div>}
                        {!getPatientFolderNo(patient) &&
                          !getPatientGender(patient) &&
                          !getPatientDateOfBirth(patient) &&
                          !getPatientInsuranceProvider(patient) && (
                            <span className="patient-meta">-</span>
                          )}
                      </td>
                      <td>
                        {canWrite ? (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => openNewClaimForPatient(patient)}
                          >
                            <Plus size={14} /> New Claim
                          </button>
                        ) : (
                          <span className="patient-meta">-</span>
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

      {pageTab === 'prescribers' && (
        <>
          <div className="nhis-controls">
            <div className="search-box">
              <Search size={16} className="search-icon" />
              <input
                className="search-input"
                placeholder="Search prescribers by name, license, type, specialty..."
                value={prescriberSearch}
                onChange={(event) => setPrescriberSearch(event.target.value)}
              />
            </div>
            <span className="catalog-count">{filteredPrescribers.length} prescribers</span>
            <button type="button" className="btn btn-secondary" onClick={loadPrescribingRecords} disabled={prescribingRecordsLoading}>
              Refresh
            </button>
          </div>

          {canWrite && (
            <form className="nhis-card nhis-record-form" onSubmit={handleCreatePrescriber}>
              <div className="form-row">
                <div className="form-group">
                  <label>Full Name *</label>
                  <input className="form-input" value={prescriberForm.fullName} onChange={(event) => setPrescriberForm((p) => ({ ...p, fullName: event.target.value }))} required />
                </div>
                <div className="form-group">
                  <label>Professional Type</label>
                  <select className="form-input" value={prescriberForm.professionalType} onChange={(event) => setPrescriberForm((p) => ({ ...p, professionalType: event.target.value }))}>
                    {NHIS_PRESCRIBER_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>License / ID</label>
                  <input className="form-input" value={prescriberForm.licenseNumber} onChange={(event) => setPrescriberForm((p) => ({ ...p, licenseNumber: event.target.value }))} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Primary Facility</label>
                  <select className="form-input" value={prescriberForm.primaryFacilityId} onChange={(event) => setPrescriberForm((p) => ({ ...p, primaryFacilityId: event.target.value }))}>
                    <option value="">Not linked</option>
                    {claimFacilityOptions.map((facility) => (
                      <option key={facility.id} value={facility.id}>{getNhisPrescribingFacilityDisplayName(facility)}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Phone</label>
                  <input className="form-input" value={prescriberForm.phone} onChange={(event) => setPrescriberForm((p) => ({ ...p, phone: event.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Specialty</label>
                  <input className="form-input" value={prescriberForm.specialty} onChange={(event) => setPrescriberForm((p) => ({ ...p, specialty: event.target.value }))} />
                </div>
              </div>
              <div className="modal-actions">
                <button type="submit" className="btn btn-primary" disabled={prescriberSubmitting}>
                  <Plus size={16} /> {prescriberSubmitting ? 'Saving...' : 'Add Prescriber'}
                </button>
              </div>
            </form>
          )}

          <div className="nhis-table-wrap">
            {prescribingRecordsLoading ? (
              <div className="nhis-empty">Loading prescribers...</div>
            ) : filteredPrescribers.length === 0 ? (
              <div className="nhis-empty"><Stethoscope size={40} /><p>No prescribers registered. Add the doctor or authorized clinician who issued the prescription.</p></div>
            ) : (
              <table className="nhis-table">
                <thead>
                  <tr>
                    <th>Prescriber</th>
                    <th>Type</th>
                    <th>Primary Facility</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPrescribers.map((prescriber) => {
                    const facility = prescribingFacilities.find((row) => row.id === prescriber.primary_facility_id)
                    return (
                      <tr key={prescriber.id}>
                        <td>
                          <div className="patient-name">{prescriber.full_name}</div>
                          {prescriber.license_number && <div className="patient-meta">License: {prescriber.license_number}</div>}
                          {prescriber.phone && <div className="patient-meta">{prescriber.phone}</div>}
                        </td>
                        <td>{prescriber.professional_type || '-'}</td>
                        <td>{facility ? getNhisPrescribingFacilityDisplayName(facility) : '-'}</td>
                        <td><StatusBadge status={prescriber.status || 'active'} /></td>
                        <td>
                          {canWrite && normalizeText(prescriber.status).toLowerCase() !== 'inactive' ? (
                            <button type="button" className="btn btn-danger btn-sm" onClick={() => handleDeactivatePrescriber(prescriber)}>
                              <Trash2 size={14} /> Deactivate
                            </button>
                          ) : '-'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {pageTab === 'facilities' && (
        <>
          <div className="nhis-controls">
            <div className="search-box">
              <Search size={16} className="search-icon" />
              <input
                className="search-input"
                placeholder="Search facilities by name, code, region, district..."
                value={facilitySearch}
                onChange={(event) => setFacilitySearch(event.target.value)}
              />
            </div>
            <span className="catalog-count">{filteredPrescribingFacilities.length} facilities</span>
            <button type="button" className="btn btn-secondary" onClick={loadPrescribingRecords} disabled={prescribingRecordsLoading}>
              Refresh
            </button>
          </div>

          {canWrite && (
            <form className="nhis-card nhis-record-form" onSubmit={handleCreatePrescribingFacility}>
              <div className="form-row">
                <div className="form-group">
                  <label>Originating Facility Name *</label>
                  <input className="form-input" value={facilityForm.facilityName} onChange={(event) => setFacilityForm((p) => ({ ...p, facilityName: event.target.value }))} required />
                </div>
                <div className="form-group">
                  <label>Facility Type</label>
                  <select className="form-input" value={facilityForm.facilityType} onChange={(event) => setFacilityForm((p) => ({ ...p, facilityType: event.target.value }))}>
                    {NHIS_PRESCRIBING_FACILITY_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>NHIA Facility Code</label>
                  <input className="form-input" value={facilityForm.nhiaFacilityCode} onChange={(event) => setFacilityForm((p) => ({ ...p, nhiaFacilityCode: event.target.value }))} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Provider Number</label>
                  <input className="form-input" value={facilityForm.providerNumber} onChange={(event) => setFacilityForm((p) => ({ ...p, providerNumber: event.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Region</label>
                  <input className="form-input" value={facilityForm.region} onChange={(event) => setFacilityForm((p) => ({ ...p, region: event.target.value }))} />
                </div>
                <div className="form-group">
                  <label>District</label>
                  <input className="form-input" value={facilityForm.district} onChange={(event) => setFacilityForm((p) => ({ ...p, district: event.target.value }))} />
                </div>
              </div>
              <div className="modal-actions">
                <button type="submit" className="btn btn-primary" disabled={facilitySubmitting}>
                  <Plus size={16} /> {facilitySubmitting ? 'Saving...' : 'Add Facility'}
                </button>
              </div>
            </form>
          )}

          <div className="nhis-table-wrap">
            {prescribingRecordsLoading ? (
              <div className="nhis-empty">Loading prescribing facilities...</div>
            ) : filteredPrescribingFacilities.length === 0 ? (
              <div className="nhis-empty"><Building2 size={40} /><p>No prescribing facilities registered. Add the external hospital, clinic, or facility where the prescription originated.</p></div>
            ) : (
              <table className="nhis-table">
                <thead>
                  <tr>
                    <th>Facility</th>
                    <th>Type</th>
                    <th>Location</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPrescribingFacilities.map((facility) => (
                    <tr key={facility.id}>
                      <td>
                        <div className="patient-name">{facility.facility_name}</div>
                        {facility.nhia_facility_code && <div className="patient-meta">NHIA: {facility.nhia_facility_code}</div>}
                        {facility.provider_number && <div className="patient-meta">Provider: {facility.provider_number}</div>}
                      </td>
                      <td>{facility.facility_type || '-'}</td>
                      <td>{[facility.town, facility.district, facility.region].filter(Boolean).join(', ') || '-'}</td>
                      <td><StatusBadge status={facility.status || 'active'} /></td>
                      <td>
                        {canWrite && normalizeText(facility.status).toLowerCase() !== 'inactive' ? (
                          <button type="button" className="btn btn-danger btn-sm" onClick={() => handleDeactivatePrescribingFacility(facility)}>
                            <Trash2 size={14} /> Deactivate
                          </button>
                        ) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {pageTab === 'review' && (
        <div className="nhis-review">
          <div className="nhis-stats">
            <div className={`stat-box ${configReview.summary.configIssues ? 'rejected' : 'approved'}`}>
              <span className="stat-label">Config Issues</span>
              <span className="stat-value">{configReview.summary.configIssues}</span>
            </div>
            <div className={`stat-box ${configReview.summary.medicinesBlocked ? 'rejected' : 'approved'}`}>
              <span className="stat-label">Blocked Medicines</span>
              <span className="stat-value">{configReview.summary.medicinesBlocked}</span>
            </div>
            <div className={`stat-box ${configReview.summary.medicinesNeedsConfig ? 'pending' : 'approved'}`}>
              <span className="stat-label">Need Medicine Config</span>
              <span className="stat-value">{configReview.summary.medicinesNeedsConfig}</span>
            </div>
            <div className={`stat-box ${configReview.summary.claimsBlocked ? 'rejected' : 'approved'}`}>
              <span className="stat-label">Claims Blocked</span>
              <span className="stat-value">{configReview.summary.claimsBlocked}</span>
            </div>
          </div>

          <section className="nhis-review-section">
            <div className="nhis-review-heading">
              <h3>Facility and NHIA setup</h3>
              <StatusBadge status={configReview.apiIssues.length ? 'rejected' : 'paid'} />
            </div>
            <div className="nhis-review-grid">
              <div><strong>Pharmacy level:</strong> {facilityPharmacyLevel || 'Not configured'}</div>
              <div><strong>NHIA provider class:</strong> {providerClassLevel || 'Not configured'}</div>
              <div><strong>Direct API:</strong> {resolvedNhiaSettings?.directApiEnabled ? 'Enabled' : 'Off'}</div>
              <div><strong>Export fallback:</strong> {(resolvedNhiaSettings?.exportFormat || exportFormat || 'cxf').toUpperCase()}</div>
            </div>
            {(configReview.apiIssues.length || configReview.apiWarnings.length) ? (
              <div className="nhis-review-issues">
                {configReview.apiIssues.map((issue) => <div key={issue} className="issue issue--block">{issue}</div>)}
                {configReview.apiWarnings.map((warning) => <div key={warning} className="issue issue--warn">{warning}</div>)}
              </div>
            ) : (
              <div className="nhis-review-ok">Facility and API/export settings look ready.</div>
            )}
          </section>

          <section className="nhis-review-section">
            <div className="nhis-review-heading">
              <h3>Medicine configuration</h3>
              <span>{configReview.summary.medicinesTotal} reviewed</span>
            </div>
            <div className="nhis-table-wrap">
              {configReview.medicineRows.length === 0 ? (
                <div className="nhis-empty">No NHIS medicines or listed inventory medicines found.</div>
              ) : (
                <table className="nhis-table">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Code</th>
                      <th>Medicine</th>
                      <th>Access</th>
                      <th>Required Facility</th>
                      <th>NHIS Level</th>
                      <th>Status</th>
                      <th>Issue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {configReview.medicineRows
                      .filter((row) => row.issues.length || row.warnings.length)
                      .slice(0, 80)
                      .map((row) => (
                        <tr key={row.id}>
                          <td>{row.source}</td>
                          <td className="drug-code-cell">{row.code || '-'}</td>
                          <td>{row.name || '-'}</td>
                          <td>{row.accessLevel || 'Level not configured'}</td>
                          <td>{row.requiredLevel || '-'}</td>
                          <td>{row.prescribingLevel || '-'}</td>
                          <td><StatusBadge status={row.issues.length ? 'rejected' : 'served'} /></td>
                          <td>{[...row.issues, ...row.warnings].join(' ')}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
            {configReview.medicineRows.some((row) => row.issues.length || row.warnings.length) ? null : (
              <div className="nhis-review-ok">All reviewed medicines have the needed access configuration.</div>
            )}
          </section>

          <section className="nhis-review-section">
            <div className="nhis-review-heading">
              <h3>Claim scrub</h3>
              <span>{claims.length} claims reviewed</span>
            </div>
            <div className="nhis-table-wrap">
              {configReview.claimRows.filter((row) => row.blockers.length || row.warnings.length).length === 0 ? (
                <div className="nhis-review-ok">No claim scrub issues found.</div>
              ) : (
                <table className="nhis-table">
                  <thead>
                    <tr>
                      <th>Claim #</th>
                      <th>Patient</th>
                      <th>Status</th>
                      <th>Blockers</th>
                      <th>Warnings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {configReview.claimRows
                      .filter((row) => row.blockers.length || row.warnings.length)
                      .slice(0, 80)
                      .map((row) => (
                        <tr key={row.id}>
                          <td className="claim-number">{row.claimNumber || '-'}</td>
                          <td>{row.patient || '-'}</td>
                          <td><StatusBadge status={row.status} /></td>
                          <td>{row.blockers.slice(0, 3).join(' ') || '-'}</td>
                          <td>{row.warnings.slice(0, 3).join(' ') || '-'}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      )}

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
      {pageTab === 'gdrg' && (
        <>
          {usingTemporaryUniversalTariff && (
            <div className="nhis-incomplete-intake-alert" role="status">
              <strong>Temporary master tariff</strong>
              <span>
                The verified FEB 2023 Private Primary Care Hospital schedule is being used
                temporarily for this hospital configuration. Provider-level, service and
                clinical restrictions still apply. Replace it when NHIA publishes the
                matching current tariff.
              </span>
            </div>
          )}
          <div className="nhis-controls">
            <div className="search-box">
              <Search size={16} className="search-icon" />
              <input
                className="search-input"
                placeholder="Search by G-DRG code, description, MDC, facility group..."
                value={tariffCatalogSearch}
                onChange={(e) => setTariffCatalogSearch(e.target.value)}
              />
            </div>
            <span className="catalog-count">{filteredTariffCatalog.length} G-DRG tariffs</span>
          </div>

          <div className="nhis-table-wrap">
            {loading ? (
              <div className="nhis-empty">Loading G-DRG catalog...</div>
            ) : filteredTariffCatalog.length === 0 ? (
              <div className="nhis-empty">
                <FileSpreadsheet size={40} />
                <p>No G-DRG tariffs found for the configured tariff set.</p>
              </div>
            ) : (
              <table className="nhis-table">
                <thead>
                  <tr>
                    <th>G-DRG</th>
                    <th>Description</th>
                    <th>MDC</th>
                    <th>Age Band</th>
                    <th>Facility Group</th>
                    <th>Catering</th>
                    <th>Tariff</th>
                    {canWrite && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredTariffCatalog.map((item) => (
                    <tr key={item.id}>
                      <td className="drug-code-cell">{item.gdrg_code}</td>
                      <td>{item.description}</td>
                      <td>{item.mdc || '-'}</td>
                      <td>{item.age_band || '-'}</td>
                      <td>{item.facility_group || '-'}</td>
                      <td>{item.catering_option || '-'}</td>
                      <td>{fmtCurrency(item.tariff_amount)}</td>
                      {canWrite && (
                        <td className="nhis-actions">
                          <button className="action-btn action-btn--view" onClick={() => openEditTariff(item)} title="Edit G-DRG tariff">
                            <Pencil size={14} />
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

      {pageTab === 'rules' && isHospital && (
        <div className="nhis-table-wrap">
          {loading ? (
            <div className="nhis-empty">Loading clinical rules...</div>
          ) : clinicalRules.length === 0 ? (
            <div className="nhis-empty">
              <CheckCircle2 size={40} />
              <p>No clinical rules found. Import a template to start blocking diagnosis-treatment mismatches.</p>
            </div>
          ) : (
            <table className="nhis-table">
              <thead>
                <tr>
                  <th>Diagnosis</th>
                  <th>Diagnosis Keywords</th>
                  <th>Allowed Drug Codes</th>
                  <th>Allowed Drug Keywords</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {clinicalRules.map((rule, index) => (
                  <tr key={rule.id || `${rule.label}-${index}`}>
                    <td>{rule.label}</td>
                    <td>{(rule.diagnosis || []).join(', ') || '—'}</td>
                    <td>{(rule.drugCodes || []).join(', ') || '—'}</td>
                    <td>{(rule.treatments || []).join(', ') || '—'}</td>
                    <td><StatusBadge status={rule.severity || 'block'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {showNewClaimModal && (
        <div className="modal-overlay">
          <div className="modal-panel modal-panel--nhis-claim">
            <div className="modal-header">
              <h2>{editingClaim ? `Edit NHIS Claim ${editingClaim.claim_number}` : 'Add New NHIS Claim'}</h2>
              <button className="modal-close" onClick={closeClaimModal}><X size={18} /></button>
            </div>

            {claimError && <div className="nhis-alert nhis-alert--modal" role="alert">{claimError}</div>}
            {incompleteIntakeItems.length > 0 && (
              <div className="nhis-incomplete-intake-alert" role="status">
                <strong>Incomplete Intake</strong>
                <span>
                  Missing {incompleteIntakeItems.join(' and ')}. Details can be saved without sending,
                  or the incomplete claim can be sent to the dispensary. It cannot be finalized or
                  submitted until required information is completed.
                </span>
              </div>
            )}
            {activeReadinessCorrection && (
              <div className="nhis-correction-context" role="status">
                <div className="nhis-correction-context__header">
                  <div>
                    <span>Correction from scrub review</span>
                    <strong>{activeReadinessCorrection.claimNumber}</strong>
                  </div>
                  {activeReadinessCorrection.position && activeReadinessCorrection.total > 1 && (
                    <small>
                      Issue {activeReadinessCorrection.position} of {activeReadinessCorrection.total}
                    </small>
                  )}
                </div>
                <div className="nhis-correction-context__meta">
                  <span>{activeReadinessCorrection.patientName}</span>
                  <span>Member/HIN: {activeReadinessCorrection.member}</span>
                  <span>Folder: {activeReadinessCorrection.folder}</span>
                </div>
                <ul className="nhis-correction-context__issues">
                  {activeReadinessCorrection.issues.slice(0, 6).map((text, index) => {
                    const severity = getReadinessIssueSeverity(text)
                    return (
                      <li key={`${activeReadinessCorrection.claimNumber}-${index}`}>
                        <span className={`readiness-issue-chip readiness-issue-chip--${severity}`}>
                          {severity === 'error' ? 'Error' : severity === 'warning' ? 'Warning' : 'Info'}
                        </span>
                        <span>{text}</span>
                      </li>
                    )
                  })}
                </ul>
                {activeReadinessCorrection.issues.length > 6 && (
                  <small>{activeReadinessCorrection.issues.length - 6} more issue{activeReadinessCorrection.issues.length - 6 === 1 ? '' : 's'} in the scrub review.</small>
                )}
              </div>
            )}

            <div className="nhis-claim-body">
              {/* Left column */}
              <fieldset className="nhis-claim-left nhis-claim-left-fieldset" disabled={!canEditNhisPatientDetails}>

                {/* Patient search */}
                <section className="nhis-section">
                  <h3 className="nhis-section-title">Member Details</h3>
                  <div className="form-group">
                    <label>Search existing patient (by name / member no / Ghana Card)</label>
                    <div className="patient-search-wrap">
                      <input
                        className="form-input"
                        placeholder="Type to search patients..."
                        value={patientSearch}
                        onChange={handlePatientSearchChange}
                      />
                      {!selectedClaimPatient && filteredPatients.length > 0 && (
                        <div className="patient-dropdown">
                          {filteredPatients.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              className="patient-dropdown-item"
                              onClick={() => selectPatient(p)}
                            >
                              <span className="pd-name">{formatPatientLookupName(p)}</span>
                              {getPatientMemberNumber(p) && (
                                <span className="pd-meta">Member: {getPatientMemberNumber(p)}</span>
                              )}
                              {getPatientHin(p) && <span className="pd-meta">HIN: {getPatientHin(p)}</span>}
                              {getPatientFolderNo(p) && <span className="pd-meta">Folder: {getPatientFolderNo(p)}</span>}
                              {getPatientPhone(p) && <span className="pd-meta">{getPatientPhone(p)}</span>}
                              {p.sourceClaimNumber && <span className="pd-meta">Previous claim: {p.sourceClaimNumber}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                      {!selectedClaimPatient && patientSearching && (
                        <div className="patient-search-status">Searching patients...</div>
                      )}
                      {!selectedClaimPatient && patientSearchError && !patientSearching && (
                        <div className="patient-search-status patient-search-status--error">
                          {patientSearchError}
                        </div>
                      )}
                      {selectedClaimPatient && (
                        <>
                          <div className="selected-patient-card">
                            <div>
                              <strong>{formatPatientLookupName(selectedClaimPatient)}</strong>
                              <div className="selected-patient-meta">
                                {[
                                  getPatientMemberNumber(selectedClaimPatient)
                                    ? `Member: ${getPatientMemberNumber(selectedClaimPatient)}`
                                    : '',
                                  getPatientHin(selectedClaimPatient) ? `HIN: ${getPatientHin(selectedClaimPatient)}` : '',
                                  getPatientFolderNo(selectedClaimPatient) ? `Folder: ${getPatientFolderNo(selectedClaimPatient)}` : '',
                                  getPatientPhone(selectedClaimPatient) || '',
                                  selectedClaimPatient.sourceClaimNumber ? `Previous claim: ${selectedClaimPatient.sourceClaimNumber}` : '',
                                ].filter(Boolean).join(' | ')}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="selected-patient-change"
                              onClick={clearSelectedPatient}
                            >
                              Change
                            </button>
                          </div>
                          <div className={`nhis-active-meds-panel ${
                            patientActiveMedicationState.alerts.length ? 'nhis-active-meds-panel--warning' : ''
                          }`}>
                            <div className="nhis-active-meds-panel__header">
                              <div>
                                <strong>Active Medicines</strong>
                                <span>
                                  {patientActiveMedicationState.loading
                                    ? 'Checking cross-facility history...'
                                    : patientActiveMedicationState.alerts.length
                                      ? `${patientActiveMedicationState.alerts.length} active medicine record${patientActiveMedicationState.alerts.length === 1 ? '' : 's'} found`
                                      : patientActiveMedicationState.checked
                                        ? 'No active medicine coverage found'
                                        : 'Check this patient before dispensing'}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="selected-patient-change"
                                disabled={patientActiveMedicationState.loading}
                                onClick={() => runPatientActiveMedicationCheck({ silent: false })}
                              >
                                <HeartPulse size={14} />
                                Check
                              </button>
                            </div>
                            {!patientActiveMedicationState.available && (
                              <div className="nhis-active-meds-message">
                                {getActiveMedicationUnavailableMessage(patientActiveMedicationState.reason)}
                              </div>
                            )}
                            {patientActiveMedicationState.error && (
                              <div className="nhis-active-meds-message">
                                {getActiveMedicationUnavailableMessage()}
                              </div>
                            )}
                            {patientActiveMedicationState.alerts.length > 0 && (
                              <div className="nhis-active-meds-list">
                                {patientActiveMedicationState.alerts.slice(0, 5).map((alert, index) => {
                                  const previousDate = normalizeText(alert.previous_dispensed_date || alert.previousDispensedDate)
                                  const coverageEnd = normalizeText(alert.coverage_end_date || alert.coverageEndDate)
                                  const quantity = alert.previous_quantity_supplied ?? alert.previousQuantitySupplied
                                  const dose = normalizeText(alert.previous_dose || alert.previousDose)
                                  const frequency = normalizeText(alert.previous_frequency || alert.previousFrequency)
                                  const administrationsPerDay = alert.calculated_administrations_per_day ?? alert.calculatedAdministrationsPerDay
                                  const treatmentDays = alert.calculated_treatment_days ?? alert.calculatedTreatmentDays
                                  const sourceLabel = normalizeText(alert.source_label || alert.sourceLabel)
                                  const previousClaim = normalizeText(alert.previous_claim_reference || alert.previousClaimReference)
                                  const dateQualityWarning = normalizeText(alert.date_quality_warning || alert.dateQualityWarning)
                                  return (
                                    <div className="nhis-active-meds-item" key={`${alert.medicine_code || alert.medicineCode || index}-${previousDate}-${coverageEnd}`}>
                                      <strong>{alert.medicine_description || alert.medicineDescription || alert.medicine_code || alert.medicineCode || 'Medicine'}</strong>
                                      <div className="nhis-active-meds-grid">
                                        {previousDate && <span>Previous dispensing: {formatAppDate(previousDate)}</span>}
                                        {quantity !== null && quantity !== undefined && `${quantity}` !== '' && <span>Quantity supplied: {quantity}</span>}
                                        {dose && <span>Dose: {dose}</span>}
                                        {frequency && <span>Frequency: {frequency}</span>}
                                        {administrationsPerDay && <span>Administrations/day: {administrationsPerDay}</span>}
                                        {treatmentDays && <span>Treatment days: {treatmentDays}</span>}
                                        {coverageEnd && <span>Expected completion: {formatAppDate(coverageEnd)}</span>}
                                        <span>Remaining: {Number(alert.remaining_days || alert.remainingDays || 0)} day(s)</span>
                                        {sourceLabel && <span>Source: {sourceLabel}</span>}
                                        {dateQualityWarning && <span>Dispensing date requires review.</span>}
                                        {previousClaim && <span>Reference: {previousClaim}</span>}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label>NHIS Member No / Ghana Card *</label>
                      <input className="form-input" value={claimForm.memberNo}
                        required
                        placeholder="12345678 or GHA-XXXXXXXXX-X"
                        disabled={lookingUpMember}
                        onBlur={(e) => {
                          const normalized = normalizeNhiaMemberNumber(e.target.value)
                          setClaimForm((p) => ({
                            ...p,
                            memberNo: normalized,
                            hin: normalizeNhiaMemberNumber(p.hin) === normalizeNhiaMemberNumber(p.memberNo)
                              ? ''
                              : p.hin,
                          }))
                          // Only trigger lookup when value actually changed
                          if (normalized && normalized !== lastLookedUpMemberRef.current) {
                            handleMemberLookup(normalized, claimForm.cardType || getNhiaLookupCardType(normalized))
                          }
                        }}
                        onChange={(e) => setClaimForm((p) => ({
                          ...p,
                          memberNo: e.target.value,
                          hin: normalizeNhiaMemberNumber(p.hin) === normalizeNhiaMemberNumber(p.memberNo)
                            ? ''
                            : p.hin,
                        }))} />
                      {lookingUpMember && (
                        <div className="patient-meta">Verifying member with NHIA...</div>
                      )}
                    </div>
                    <div className="form-group">
                      <label>Card type</label>
                      <select
                        className="form-input"
                        value={claimForm.cardType || getNhiaLookupCardType(claimForm.memberNo)}
                        onChange={(e) => setClaimForm((p) => ({ ...p, cardType: e.target.value }))}
                      >
                        <option value="NHISCARD">NHIS card</option>
                        <option value="GHANACARD">Ghana Card</option>
                      </select>
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
                      <label>Folder No *</label>
                      <input className="form-input" value={claimForm.folderNo}
                        required
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
                      <input
                        type="text"
                        className="form-input"
                        value={formatDateOfBirthInputValue(claimForm.dateOfBirth)}
                        inputMode="numeric"
                        placeholder="dd/mm/yyyy"
                        pattern="\\d{1,2}/\\d{1,2}/\\d{4}"
                        title="Enter date of birth as day/month/year, for example 18/06/2026"
                        onChange={(e) => {
                          const value = e.target.value
                          setClaimForm((p) => ({
                            ...p,
                            dateOfBirth: normalizeDateOfBirthValue(value) || value,
                          }))
                        }}
                        onBlur={(e) => {
                          const value = e.target.value.trim()
                          if (!value) {
                            setClaimForm((p) => ({ ...p, dateOfBirth: '' }))
                            return
                          }
                          const normalized = normalizeDateOfBirthValue(value)
                          if (!normalized) {
                            notify('Date of birth must be day/month/year, for example 18/06/2026.', 'warning')
                            return
                          }
                          setClaimForm((p) => ({ ...p, dateOfBirth: normalized }))
                        }}
                      />
                    </div>
                  </div>

                  {isHospital && (
                    <div className="form-row">
                      <div className="form-group">
                        <label>Patient Address</label>
                        <input className="form-input" value={claimForm.patientAddress}
                          onChange={(e) => setClaimForm((p) => ({ ...p, patientAddress: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>Child Weight (kg)</label>
                        <input type="number" min="0" step="0.1" className="form-input" value={claimForm.childWeightKg}
                          onChange={(e) => setClaimForm((p) => ({ ...p, childWeightKg: e.target.value }))} />
                      </div>
                    </div>
                  )}

                  <div className="form-row">
                    <div className="form-group">
                      <label>CCC / CC Code{claimControlMode === 'manual' ? ' *' : ''}</label>
                      <div className="nhis-code-field">
                        <input className="form-input" value={claimForm.cccNo}
                          required={claimControlMode === 'manual'}
                          disabled={claimControlMode === 'manual' && !canManuallyEditCcCode}
                          inputMode="numeric"
                          maxLength={5}
                          pattern={claimControlMode === 'manual' ? '[0-9]{5}' : '[0-9]{0,5}'}
                          placeholder={claimControlMode === 'manual' ? '12345' : 'Pending NHIA CCC verification'}
                          title="Enter the 5-digit CCC/CC code"
                          onChange={(e) => setClaimForm((p) => ({
                            ...p,
                            cccNo: normalizeNhisCcCode(e.target.value).slice(0, 5),
                          }))} />
                        {claimControlMode !== 'manual' && canGenerateNhiaCcCode && (
                          <button
                            type="button"
                            className="btn btn-secondary nhis-code-generate"
                            disabled={generatingCcCode}
                            onClick={handleGenerateCcCode}
                          >
                            {generatingCcCode ? 'Validating...' : 'Generate/Validate CC Code via NHIA'}
                          </button>
                        )}
                      </div>
                      {claimControlMode === 'manual' && !canManuallyEditCcCode && (
                        <div className="patient-meta">Manual CC/CCC entry is restricted to admin users.</div>
                      )}
                      {claimControlMode !== 'manual' && !canGenerateNhiaCcCode && (
                        <div className="patient-meta">
                          {integrationMode === 'claimit_export'
                            ? 'CLAIM-it export mode does not perform live NHIA CCC generation.'
                            : 'Live NHIA CCC generation is not configured in Settings.'}
                        </div>
                      )}
                      {claimControlMode !== 'manual' && canGenerateNhiaCcCode && !claimForm.cccNo && (
                        <div className="patient-meta">Pending NHIA CCC verification</div>
                      )}
                    </div>
                    {isHospital && (
                      <div className="form-group">
                        <label>Diagnoses *</label>
                        <DiagnosisSelector
                          id="claim-diagnoses"
                          value={claimForm.diagnosis}
                          details={claimForm.diagnosisDetails}
                          onChange={(diagnosis, diagnosisDetails) =>
                            setClaimForm((p) => ({ ...p, diagnosis, diagnosisDetails }))
                          }
                        />
                      </div>
                    )}
                  </div>
                </section>

                <section className="nhis-section">
                  <h3 className="nhis-section-title">NeHFAMS / OTAC Attendance Verification</h3>
                  <div className="patient-meta">
                    Record the attendance details from otac.nhia.gov.gh. This is manual capture only until NHIA provides official OTAC API credentials/endpoints.
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Attendance Date</label>
                      <input
                        type="date"
                        className="form-input"
                        value={claimForm.nhiaAttendanceDate}
                        onChange={(e) => setClaimForm((p) => ({ ...p, nhiaAttendanceDate: e.target.value }))}
                      />
                    </div>
                    <div className="form-group">
                      <label>AuthID</label>
                      <input
                        className="form-input"
                        value={claimForm.authId}
                        placeholder="NeHFAMS AuthID"
                        onChange={(e) => setClaimForm((p) => ({ ...p, authId: e.target.value }))}
                      />
                    </div>
                    <div className="form-group">
                      <label>Auth Type</label>
                      <select
                        className="form-input"
                        value={claimForm.authType || 'NHIS'}
                        onChange={(e) => setClaimForm((p) => ({ ...p, authType: e.target.value }))}
                      >
                        <option value="NHIS">NHIS</option>
                        <option value="OTAC">OTAC</option>
                        <option value="OTP">OTP</option>
                        <option value="MANUAL">Manual</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>OTAC / OTP Code</label>
                      <input
                        className="form-input"
                        value={claimForm.otacCode}
                        placeholder="Code from NeHFAMS, if shown"
                        onChange={(e) => setClaimForm((p) => ({ ...p, otacCode: e.target.value }))}
                      />
                    </div>
                    <div className="form-group">
                      <label>New CCC</label>
                      <select
                        className="form-input"
                        value={claimForm.newCcc}
                        onChange={(e) => setClaimForm((p) => ({ ...p, newCcc: e.target.value }))}
                      >
                        <option value="">Not stated</option>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Verification Status</label>
                      <select
                        className="form-input"
                        value={claimForm.attendanceVerificationStatus}
                        onChange={(e) => setClaimForm((p) => ({ ...p, attendanceVerificationStatus: e.target.value }))}
                      >
                        <option value="">Not recorded</option>
                        <option value="confirmed">Confirmed</option>
                        <option value="pending">Pending</option>
                        <option value="failed">Failed</option>
                      </select>
                    </div>
                  </div>
                </section>

                {/* Dates of service */}
                <section className="nhis-section">
                  <h3 className="nhis-section-title">Date of Service</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Date</label>
                      <input type="date" className="form-input" value={claimForm.serviceDate}
                        onChange={(e) => setClaimForm((p) => ({ ...p, serviceDate: e.target.value }))} />
                    </div>
                  </div>
                </section>

                {isHospital && (
                  <section className="nhis-section">
                    <h3 className="nhis-section-title">Encounter Outcome</h3>
                    <div className="form-row">
                      <div className="form-group">
                        <label>Outcome</label>
                        <select
                          className="form-input"
                          value={claimForm.encounterOutcome}
                          onChange={(e) => setClaimForm((p) => ({ ...p, encounterOutcome: e.target.value }))}
                        >
                          {HOSPITAL_ENCOUNTER_OUTCOME_OPTIONS.map((option) => (
                            <option key={option.value || 'blank'} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="form-group">
                        <label>No medicine reason</label>
                        <select
                          className="form-input"
                          value={claimForm.noMedicineReason}
                          onChange={(e) => setClaimForm((p) => ({ ...p, noMedicineReason: e.target.value }))}
                        >
                          {HOSPITAL_NO_MEDICINE_REASON_OPTIONS.map((option) => (
                            <option key={option.value || 'blank'} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="form-group">
                        <label>No laboratory reason</label>
                        <select
                          className="form-input"
                          value={claimForm.noLabReason}
                          onChange={(e) => setClaimForm((p) => ({ ...p, noLabReason: e.target.value }))}
                        >
                          {HOSPITAL_NO_LAB_REASON_OPTIONS.map((option) => (
                            <option key={option.value || 'blank'} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="form-group">
                        <label>No procedure reason</label>
                        <select
                          className="form-input"
                          value={claimForm.noProcedureReason}
                          onChange={(e) => setClaimForm((p) => ({ ...p, noProcedureReason: e.target.value }))}
                        >
                          {HOSPITAL_NO_PROCEDURE_REASON_OPTIONS.map((option) => (
                            <option key={option.value || 'blank'} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {claimForm.encounterOutcome === 'external_prescription' && (
                      <div className="form-row">
                        <div className="form-group">
                          <label>External prescription status</label>
                          <input
                            className="form-input"
                            value={claimForm.externalPrescriptionStatus}
                            placeholder="Issued to patient / sent to external pharmacy"
                            onChange={(e) => setClaimForm((p) => ({ ...p, externalPrescriptionStatus: e.target.value }))}
                          />
                        </div>
                      </div>
                    )}
                  </section>
                )}

                {/* Referral */}
                <section className="nhis-section">
                  <h3 className="nhis-section-title">Prescription Source</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Saved Facility</label>
                      <select
                        className="form-input"
                        value={claimForm.prescribingFacilityId}
                        onChange={(event) => handleSelectPrescribingFacility(event.target.value)}
                      >
                        <option value="">Select saved facility</option>
                        {claimFacilityOptions.map((facility) => (
                          <option key={facility.id} value={facility.id}>
                            {getNhisPrescribingFacilityDisplayName(facility)}
                            {facility.nhia_facility_code ? ` - ${facility.nhia_facility_code}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Prescribing Facility *</label>
                      <CompactSuggestionInput
                        value={claimForm.referringFacility}
                        required
                        ariaLabel="Prescribing facility"
                        onValueChange={handlePrescribingFacilityTextChange}
                        options={claimFacilityOptions.map((facility) => {
                          const name = getNhisPrescribingFacilityDisplayName(facility)
                          const code = normalizeText(facility.nhia_facility_code ?? facility.nhiaFacilityCode)
                          return {
                            value: name,
                            label: name,
                            description: code ? `${code} - ${facility.facility_type || 'Saved facility'}` : facility.facility_type || 'Saved facility',
                          }
                        })}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Referral Code / CCC</label>
                      <input className="form-input" value={claimForm.referralCode}
                        onChange={(e) => setClaimForm((p) => ({ ...p, referralCode: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>Prescription Date</label>
                      <input
                        className="form-input"
                        type="date"
                        value={claimForm.prescriptionDate}
                        onChange={(e) => setClaimForm((p) => ({ ...p, prescriptionDate: e.target.value }))}
                      />
                    </div>
                  </div>
                </section>

                {/* Authorization */}
                <section className="nhis-section">
                  <h3 className="nhis-section-title">Prescription Authorization</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Saved Prescriber</label>
                      <select
                        className="form-input"
                        value={claimForm.prescriberId}
                        onChange={(event) => handleSelectPrescriber(event.target.value)}
                      >
                        <option value="">Select saved prescriber</option>
                        {claimPrescriberOptions.map((prescriber) => (
                          <option key={prescriber.id} value={prescriber.id}>
                            {getNhisPrescriberDisplayName(prescriber)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Prescriber Name / ID *</label>
                      <CompactSuggestionInput
                        value={claimForm.physicianName}
                        ariaLabel="Prescriber name or ID"
                        onValueChange={handlePrescriberTextChange}
                        options={claimPrescriberOptions.map((prescriber) => ({
                          value: getNhisPrescriberDisplayName(prescriber),
                          label: getNhisPrescriberDisplayName(prescriber),
                          description: prescriber.primary_facility_id
                              ? getNhisPrescribingFacilityDisplayName(prescribingFacilities.find((row) => row.id === prescriber.primary_facility_id) || {})
                              : prescriber.professional_type || 'Saved prescriber',
                        }))}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Pre-authorization Code(s)</label>
                      <input className="form-input" value={claimForm.preAuthCodes}
                        onChange={(e) => setClaimForm((p) => ({ ...p, preAuthCodes: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>Prescription Reference</label>
                      <input
                        className="form-input"
                        value={claimForm.prescriptionReference}
                        onChange={(e) => setClaimForm((p) => ({ ...p, prescriptionReference: e.target.value }))}
                        placeholder="Prescription number, if shown"
                      />
                      {(claimForm.prescriptionEntryUserName || claimForm.prescriptionEnteredAt) && (
                        <small className="prescription-audit-note">
                          Entered by {claimForm.prescriptionEntryUserName || 'Recorded user'}
                          {claimForm.prescriptionEnteredAt ? ` on ${formatAppDateTime(claimForm.prescriptionEnteredAt)}` : ''}.
                        </small>
                      )}
                      {(claimForm.prescriptionUpdateUserName || claimForm.prescriptionUpdatedAt) && (
                        <small className="prescription-audit-note">
                          Last updated by {claimForm.prescriptionUpdateUserName || 'Recorded user'}
                          {claimForm.prescriptionUpdatedAt ? ` on ${formatAppDateTime(claimForm.prescriptionUpdatedAt)}` : ''}.
                        </small>
                      )}
                    </div>
                  </div>
                </section>

                <section className="nhis-section">
                  <h3 className="nhis-section-title">Scanned Prescription</h3>
                  <label className="prescription-upload-box">
                    <Paperclip size={18} />
                    <span>{claimForm.prescriptionFileName || 'Attach prescription file'}</span>
                    <small>PDF, JPEG, or PNG, max 3 MB</small>
                    <input
                      type="file"
                      accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
                      onChange={handlePrescriptionPdfSelect}
                    />
                  </label>
                  {claimForm.prescriptionFileName && (
                    <div className="prescription-file-chip">
                      <FileText size={15} />
                      <span>{claimForm.prescriptionFileName}</span>
                      {claimForm.prescriptionFileSize && (
                        <small>{fmtFileSize(claimForm.prescriptionFileSize)}</small>
                      )}
                      <button type="button" className="action-btn action-btn--cancel" onClick={clearPrescriptionPdf}>
                        <X size={12} />
                      </button>
                    </div>
                  )}
                  {(claimForm.prescriptionFileName ||
                    claimForm.prescriptionFilePath ||
                    claimForm.prescriptionFileUrl ||
                    prescriptionPdfFile) && (
                    <div className="form-row" style={{ marginTop: '0.75rem' }}>
                      <div className="form-group">
                        <label>Attachment Type *</label>
                        <select
                          className="form-input"
                          value={claimForm.prescriptionDocumentType}
                          disabled={!canWrite || isMedicineCounterAssistant}
                          onChange={(event) => {
                            const documentType = event.target.value
                            setClaimForm((previous) => ({
                              ...previous,
                              prescriptionDocumentType: documentType,
                              prescriptionVerified: false,
                              prescriptionVerifiedBy: '',
                              prescriptionVerifiedAt: '',
                            }))
                          }}
                        >
                          <option value="">Select attachment type</option>
                          <option value="prescription">Prescription</option>
                          <option value="receipt">Receipt / bill</option>
                          <option value="lab_report">Lab report</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                      <div className="form-group">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={claimForm.prescriptionVerified === true}
                            disabled={
                              !canWrite ||
                              isMedicineCounterAssistant
                            }
                            onChange={(event) => {
                              const verified = event.target.checked
                              setClaimForm((previous) => ({
                                ...previous,
                                prescriptionDocumentType: verified ? 'prescription' : previous.prescriptionDocumentType,
                                prescriptionVerified: verified,
                                prescriptionVerifiedBy: verified ? user?.id || '' : '',
                                prescriptionVerifiedAt: verified ? new Date().toISOString() : '',
                              }))
                            }}
                          />
                          I verified this is the patient&apos;s prescription
                        </label>
                        <small>
                          {claimForm.prescriptionVerified
                            ? 'Verified prescription — eligible for pharmacy completion.'
                            : 'Unverified files cannot complete or submit a pharmacy claim.'}
                        </small>
                        {claimForm.prescriptionVerified && claimForm.prescriptionVerifiedAt && (
                          <small className="prescription-audit-note">
                            Verification recorded {formatAppDateTime(claimForm.prescriptionVerifiedAt)}
                            {claimForm.prescriptionVerifiedBy ? ` by ${claimForm.prescriptionVerifiedBy}` : ''}.
                          </small>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              </fieldset>

              {/* Right column — medicines */}
              <div className="nhis-claim-right">
                <div className="nhis-medicines-header">
                  <h3 className="nhis-section-title">Medicines</h3>
                  {canWrite && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        const nextEntryDate = getNhisCalendarDate()
                        setEditingMedicineIndex(null)
                        setMedicineEntryDate(nextEntryDate)
                        setMedForm(makeBlankMedicineForDate(nextEntryDate))
                        setMedCodeSearch('')
                        setMedSearchResults([])
                        setShowMedModal(true)
                      }}
                    >
                      <Plus size={14} /> Add Medicine
                    </button>
                  )}
                </div>

                {compactMedicines(claimMedicines).length === 0 ? (
                  <div className="no-medicines">No medicines added.</div>
                ) : (
                  <div className="medicines-list">
                    {compactMedicines(claimMedicines).map((m, idx) => {
                      const prescribedQty = getMedicinePrescribedQty(m)
                      const servedQty = getMedicineServedQty(m)
                      const servingStatus = normalizeMedicineServingStatus(m.servingStatus, prescribedQty, servedQty)
                      const servingStatusLabel = getMedicineServingStatusLabel(servingStatus)

                      return (
                        <div key={idx} className="medicine-card">
                        <div className="medicine-card-main">
                          <div className="medicine-card-title-row">
                            <div className="medicine-code">{m.drugCode}</div>
                            <span className={`medicine-status-pill medicine-status-pill--${servingStatus}`}>
                              {servingStatusLabel}
                            </span>
                          </div>
                          <div className="medicine-desc">{m.description}</div>
                          <div className="medicine-meta">
                            {m.dispensedQty} × {m.unit} @ {fmtCurrency(m.unitPrice)}
                            {m.category && ` | NHIS Level: ${m.category}`}
                            {` | Prescribed: ${prescribedQty} ${m.unit}`}
                            {` | Served: ${servedQty} ${m.unit}`}
                            {/* ✅ NHIS PHARMACY LEVEL PATCH START */}
                            {(m.medicineAccessLevel || facilityPharmacyLevel !== 'P1') &&
                              ` | Access: ${m.medicineAccessLevel || 'Level not configured'}`}
                            {m.requiredPharmacyLevel && ` | Facility: ${m.requiredPharmacyLevel}`}
                            {/* ✅ NHIS PHARMACY LEVEL PATCH END */}
                            {m.dose && ` | Dose: ${m.dose}`}
                            {m.frequency && ` | ${m.frequency}`}
                            {m.duration && ` for ${m.duration}`}
                          </div>
                          {isMedicineCounterAssistant && servingStatus === 'pending' && (
                            <div className="medicine-serve-hint">
                              Use Serve to mark full, partial, not available, or not served.
                            </div>
                          )}
                          {isMedicineCounterAssistant && m.reasonIfNotFullyServed && servingStatus !== 'fully_served' && (
                            <div className="medicine-serve-hint medicine-serve-hint--reason">
                              Reason: {m.reasonIfNotFullyServed}
                            </div>
                          )}
                        </div>
                        <div className="medicine-card-right">
                          <div className="medicine-total-stack">
                            {!isMedicineCounterAssistant && (
                              <div className="medicine-total medicine-total--requested">
                                <span>Requested</span>
                                <strong>{fmtCurrency(getMedicinePrescribedAmount(m))}</strong>
                              </div>
                            )}
                            <div className={`medicine-total ${!isMedicineCounterAssistant ? 'medicine-total--served' : ''}`}>
                              {!isMedicineCounterAssistant && <span>Served</span>}
                              <strong>{fmtCurrency(getMedicineServedAmount(m))}</strong>
                            </div>
                          </div>
                          <button
                            className={`action-btn action-btn--edit ${isMedicineCounterAssistant ? 'medicine-serve-btn' : ''}`}
                            type="button"
                            title={isMedicineCounterAssistant ? 'Serve or mark availability' : 'Edit medicine'}
                            onClick={() => openEditMedicine(idx)}
                          >
                            <Pencil size={12} />
                            {isMedicineCounterAssistant && <span>Serve</span>}
                          </button>
                          {canWrite && (
                            <button className="action-btn action-btn--cancel" onClick={() => removeMedicine(idx)}>
                              <X size={12} />
                            </button>
                          )}
                        </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className="nhis-internal-note">
                  <label>Optional internal note</label>
                  <textarea
                    className="form-input"
                    rows={3}
                    value={claimForm.unservedMedicinesNote}
                    onChange={(e) => setClaimForm((p) => ({
                      ...p,
                      unservedMedicinesNote: e.target.value,
                    }))}
                    placeholder="Optional note for medicines not served. Use each medicine's Serve button for the official status and reason."
                  />
                </div>

                {isHospital && (
                  <div className="nhis-services-panel">
                    <div className="nhis-medicines-header">
                      <h3 className="nhis-section-title">Tariff Services</h3>
                    </div>
                    <div className="drug-search-wrap">
                      <input
                        className="form-input"
                        placeholder="Search G-DRG, procedure, lab, OPD..."
                        value={tariffSearch}
                        onChange={(e) => setTariffSearch(e.target.value)}
                      />
                      {filteredTariffItems.length > 0 && (
                        <div className="drug-dropdown tariff-dropdown">
                          {filteredTariffItems.map((item) => (
                            <button key={item.id} className="drug-dropdown-item" type="button" onClick={() => addTariffServiceToClaim(item)}>
                              <span className="drug-name">{item.gdrg_code}</span>
                              <span className="drug-meta">
                                {item.description} - {fmtCurrency(item.tariff_amount)} - {item.facility_group}
                                {item.catering_option ? ` (${item.catering_option})` : ''}
                                {item.age_band ? ` - ${item.age_band}` : ''}
                                {item.source_page ? ` - p.${item.source_page}` : ''}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {claimServices.length === 0 ? (
                      <div className="no-medicines">No tariff services added.</div>
                    ) : (
                      <div className="medicines-list">
                        {claimServices.map((service, idx) => (
                          <div key={`${service.gdrgCode}-${idx}`} className="medicine-card">
                            <div className="medicine-card-main">
                              <div className="medicine-code">{service.gdrgCode}</div>
                              <div className="medicine-desc">{service.description}</div>
                              <div className="medicine-meta">
                                {service.mdc || 'NHIA tariff'} | {service.facilityGroup}
                                {service.cateringOption ? ` | ${service.cateringOption}` : ''}
                                {service.ageBand ? ` | ${service.ageBand}` : ''}
                                {service.sourceFile ? ` | ${service.sourceFile}${service.sourcePage ? ` p.${service.sourcePage}` : ''}` : ''}
                              </div>
                            </div>
                            <div className="medicine-card-right">
                              <input
                                className="form-input service-qty-input"
                                type="number"
                                min="1"
                                step="1"
                                value={service.quantity}
                                onChange={(e) => updateTariffServiceQuantity(idx, e.target.value)}
                                aria-label="Service quantity"
                              />
                              <div className="medicine-total">{fmtCurrency(service.totalAmount)}</div>
                              <button className="action-btn action-btn--cancel" type="button" onClick={() => removeTariffService(idx)}>
                                <X size={12} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="medicines-total">
                  {showRequestedClaimTotal ? (
                    <>
                      <div>
                        <strong>Requested Total:</strong> {fmtCurrency(requestedClaimTotal)}
                      </div>
                      <span>Served claim value: {fmtCurrency(claimTotal)}</span>
                    </>
                  ) : (
                    <div>
                      <strong>Total:</strong> {fmtCurrency(claimTotal)}
                    </div>
                  )}
                </div>

                <div className={`nhia-readiness ${effectiveReadinessBlocked ? 'nhia-readiness--fail' : 'nhia-readiness--pass'}`}>
                  <div className="nhia-readiness-header">
                    {effectiveReadinessBlocked ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
                    <strong>
                      {isMedicineCounterAssistant
                        ? 'Medicine Save Check'
                        : isHospital ? 'NHIS Claim Scrub' : 'NHIS Pharmacy Check'}
                    </strong>
                    {!isMedicineCounterAssistant && (
                      <span className="nhia-risk-score">
                        Risk {readiness.riskScore ?? 0}% - {readiness.riskLevel || 'clean'}
                      </span>
                    )}
                  </div>
                  {isMedicineCounterAssistant ? (
                    <>
                      {mcaReadiness.canSaveMedicines ? (
                        <p>Medicine changes can be saved. Claims officer/admin must complete claim details before submission.</p>
                      ) : (
                        <div className="nhia-readiness-section">
                          <span className="nhia-readiness-label">Medicine blockers ({mcaReadiness.medicineBlockers.length})</span>
                          <ul>
                            {mcaReadiness.medicineBlockers.map((issue) => (
                              <li key={issue}>{issue}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {mcaReadiness.medicineWarnings.length > 0 && (
                        <div className="nhia-readiness-section">
                          <span className="nhia-readiness-label">Medicine warnings ({mcaReadiness.medicineWarnings.length})</span>
                          <ul className="nhia-readiness-warnings">
                            {mcaReadiness.medicineWarnings.map((issue) => (
                              <li key={issue}>{issue}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {(mcaReadiness.claimCompletionBlockers.length > 0 || mcaReadiness.claimCompletionWarnings.length > 0) && (
                        <div className="nhia-readiness-section nhia-readiness-section--info">
                          <span className="nhia-readiness-label">
                            Claim completion needed ({mcaReadiness.claimCompletionBlockers.length + mcaReadiness.claimCompletionWarnings.length})
                          </span>
                          <p>These do not stop dispensary medicine saving. Claims officer/admin must complete them before correction, export, or submission.</p>
                          <ul className="nhia-readiness-info-list">
                            {[...mcaReadiness.claimCompletionBlockers, ...mcaReadiness.claimCompletionWarnings].map((issue) => (
                              <li key={issue}>{issue}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  ) : effectiveReadinessPassed ? (
                    <p>{isHospital ? 'Ready for NHIS claim submission.' : 'Ready for NHIS pharmacy claim submission.'}</p>
                  ) : !effectiveReadinessBlocked ? (
                    <>
                      <p>Can be saved now; claims officer must complete warnings before corrections/export.</p>
                      <div className="nhia-readiness-section">
                        <span className="nhia-readiness-label">Warnings ({readiness.warnings.length})</span>
                        <ul className="nhia-readiness-warnings">
                          {readiness.warnings.map((issue) => (
                            <li key={issue}>{issue}</li>
                          ))}
                        </ul>
                      </div>
                    </>
                  ) : (
                    <>
                      {readiness.blockers.length > 0 && (
                        <div className="nhia-readiness-section">
                          <span className="nhia-readiness-label">
                            Requirements before final submission ({readiness.blockers.length})
                          </span>
                          <p>These do not prevent Save Details or Send to Dispensary.</p>
                          <ul>
                            {readiness.blockers.map((issue) => (
                              <li key={issue}>{issue}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {readiness.warnings.length > 0 && (
                        <div className="nhia-readiness-section">
                          <span className="nhia-readiness-label">Warnings ({readiness.warnings.length})</span>
                          <ul className="nhia-readiness-warnings">
                            {readiness.warnings.map((issue) => (
                              <li key={issue}>{issue}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  )}
                  {readiness.information?.length > 0 && (
                    <div className="nhia-readiness-section nhia-readiness-section--info">
                      <span className="nhia-readiness-label">Documented context ({readiness.information.length})</span>
                      <ul className="nhia-readiness-info-list">
                        {readiness.information.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {editingClaim && canEditNhisClaimAnytime && (
              <section className="nhis-section nhis-correction-audit">
                <h3 className="nhis-section-title">Reason for correction (optional)</h3>
                <textarea
                  className="form-input"
                  rows={3}
                  value={correctionReason}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                  placeholder="Example: Wrong prescriber entered during initial claim capture."
                />
                {correctionHistory.length > 0 && (
                  <details>
                    <summary>Claim Correction History ({correctionHistory.length})</summary>
                    <div className="nhis-correction-history">
                      {correctionHistory.map((entry) => (
                        <div key={entry.id}>
                          <strong>{String(entry.field_name || '').replaceAll('_', ' ')}</strong>
                          <span>{JSON.stringify(entry.previous_value)} → {JSON.stringify(entry.new_value)}</span>
                          <small>{entry.actor_role} ({entry.actor_user_id}) · {formatAppDateTime(entry.created_at)} · {entry.reason}</small>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </section>
            )}

            <div className="modal-footer">
              <div className="claim-footer-total">
                {showRequestedClaimTotal ? (
                  <>
                    <span>Requested Total</span>
                    <strong>{fmtCurrency(requestedClaimTotal)}</strong>
                    <small>Served claim value: {fmtCurrency(claimTotal)}</small>
                  </>
                ) : (
                  <>
                    <span>Claim Total</span>
                    <strong>{fmtCurrency(claimTotal)}</strong>
                  </>
                )}
              </div>
              {editingClaim && readinessActiveClaimId && readinessNavigation.issues.length > 1 && (
                <div className="readiness-queue-nav">
                  <span>
                    Issue {readinessNavigation.activeIndex >= 0 ? readinessNavigation.activeIndex + 1 : '-'} of {readinessNavigation.issues.length}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={claimSubmitting || !readinessNavigation.previous}
                    title="Move to the previous issue in this correction queue"
                    onClick={() => { void openReadinessIssueForEdit(readinessNavigation.previous) }}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={claimSubmitting || !readinessNavigation.next}
                    title="Move to the next issue in this correction queue"
                    onClick={() => { void openReadinessIssueForEdit(readinessNavigation.next) }}
                  >
                    Next
                  </button>
                </div>
              )}
              <button className="btn btn-secondary" onClick={closeClaimModal}>
                Cancel
              </button>
              {!isMedicineCounterAssistant &&
                (!editingClaim || normalizeText(editingClaim.status).toLowerCase() === 'draft') && (
                  <button
                    className="btn btn-secondary"
                    disabled={claimSubmitting || !canSaveCommunityPharmacyClaim}
                    onClick={(event) => handleSubmitClaim(event, 'save_details')}
                  >
                    {claimSubmitting && claimSubmitIntent === 'save_details'
                      ? 'Saving Details...'
                      : 'Save Details'}
                  </button>
                )}
              {canServeClaimDirectly && (
                <button
                  className="btn btn-secondary"
                  disabled={
                    claimSubmitting ||
                    compactMedicines(claimMedicines).length === 0 ||
                    shouldUseBranchServer()
                  }
                  title={
                    shouldUseBranchServer()
                      ? 'Direct serving requires an online cloud connection.'
                      : 'Mark all entered medicine quantities as served without changing inventory stock.'
                  }
                  onClick={(event) => handleSubmitClaim(event, 'serve_directly')}
                >
                  {claimSubmitting && claimSubmitIntent === 'serve_directly'
                    ? 'Serving...'
                    : 'Serve Directly'}
                </button>
              )}
              <button
                className="btn btn-primary"
                disabled={claimSubmitting || !canSaveCommunityPharmacyClaim}
                onClick={(event) => handleSubmitClaim(event, 'dispatch')}
              >
                {claimSubmitting
                  ? (
                      claimSubmitIntent === 'dispatch' && (!editingClaim || editingClaim.status === 'draft')
                        ? 'Sending...'
                        : editingClaim && canWrite && directNhiaApiAvailable
                          ? 'Submitting...'
                          : 'Saving...'
                    )
                  : editingClaim
                    ? (normalizeText(editingClaim.status).toLowerCase() === 'draft'
                        ? 'Send to Dispensary'
                        : isMedicineCounterAssistant
                        ? 'Complete Serving'
                        : canSaveIncompleteIntake && readiness.blockers.length
                          ? 'Save Intake Updates'
                          : directNhiaApiAvailable ? 'Save Corrections & Submit' : 'Save Corrections')
                    : 'Send to Dispensary'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          NEW MEDICINE SUB-MODAL
      ══════════════════════════════════════════════════════════════ */}
      {actionConfirmation && (
        <div
          className="modal-overlay modal-overlay--top nhis-discard-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeActionConfirmation(false)
          }}
        >
          <section
            className="modal-panel nhis-discard-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="nhis-action-confirmation-title"
          >
            <div className="nhis-discard-header">
              <div className="nhis-discard-icon" aria-hidden="true">
                <AlertTriangle size={22} />
              </div>
              <div>
                <span className="nhis-discard-eyebrow">
                  {actionConfirmation.eyebrow || 'Review action'}
                </span>
                <h2 id="nhis-action-confirmation-title">{actionConfirmation.title}</h2>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => closeActionConfirmation(false)}
                aria-label={actionConfirmation.cancelText || 'Cancel'}
              >
                <X size={18} />
              </button>
            </div>

            <div className="nhis-discard-body">
              {actionConfirmation.details?.length > 0 && (
                <div className="nhis-discard-details">
                  {actionConfirmation.details
                    .filter((detail) => detail && String(detail.value || '').trim())
                    .map((detail) => (
                      <div key={`${detail.label}-${detail.value}`}>
                        <span>{detail.label}</span>
                        <strong>{detail.value}</strong>
                      </div>
                    ))}
                </div>
              )}
              {actionConfirmation.warning && (
                <p className="nhis-discard-warning">{actionConfirmation.warning}</p>
              )}
            </div>

            <div className="modal-footer nhis-discard-footer">
              <button type="button" className="btn btn-secondary" onClick={() => closeActionConfirmation(false)}>
                {actionConfirmation.cancelText || 'Cancel'}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => closeActionConfirmation(true)}>
                {actionConfirmation.confirmText || 'Continue'}
              </button>
            </div>
          </section>
        </div>
      )}

      {discardConfirmation && (
        <div
          className="modal-overlay modal-overlay--top nhis-discard-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) setDiscardConfirmation(null)
          }}
        >
          <section
            className="modal-panel nhis-discard-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="nhis-discard-title"
          >
            <div className="nhis-discard-header">
              <div className="nhis-discard-icon" aria-hidden="true">
                <AlertTriangle size={22} />
              </div>
              <div>
                <span className="nhis-discard-eyebrow">Unsaved changes</span>
                <h2 id="nhis-discard-title">{discardConfirmation.title}</h2>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setDiscardConfirmation(null)}
                aria-label="Keep editing"
              >
                <X size={18} />
              </button>
            </div>

            <div className="nhis-discard-body">
              {discardConfirmation.details?.length > 0 && (
                <div className="nhis-discard-details">
                  {discardConfirmation.details
                    .filter((detail) => detail?.value)
                    .map((detail) => (
                      <div key={detail.label}>
                        <span>{detail.label}</span>
                        <strong>{detail.value}</strong>
                      </div>
                    ))}
                </div>
              )}
              {discardConfirmation.warning && (
                <p className="nhis-discard-warning">{discardConfirmation.warning}</p>
              )}
            </div>

            <div className="modal-footer nhis-discard-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setDiscardConfirmation(null)}>
                {discardConfirmation.cancelText || 'Keep editing'}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  const onConfirm = discardConfirmation.onConfirm
                  setDiscardConfirmation(null)
                  onConfirm?.()
                }}
              >
                {discardConfirmation.confirmText || 'Discard'}
              </button>
            </div>
          </section>
        </div>
      )}

      {claimActionReview && (
        <div
          className="modal-overlay modal-overlay--top"
          onClick={(event) => event.target === event.currentTarget && setClaimActionReview(null)}
        >
          <section
            className="modal-panel nhis-action-review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="nhis-action-review-title"
          >
            <div className="modal-header">
              <div>
                <span className="nhis-action-review-eyebrow">Final review</span>
                <h2 id="nhis-action-review-title">
                  {claimActionReview.intent === 'serve_directly'
                    ? 'Serve this claim directly?'
                    : 'Send this claim to the dispensary?'}
                </h2>
              </div>
              <button type="button" className="modal-close" onClick={() => setClaimActionReview(null)} aria-label="Close review">
                <X size={18} />
              </button>
            </div>

            <div className="nhis-action-review-body">
              <div className="nhis-action-review-summary">
                <div><span>Patient</span><strong>{[claimForm.surname, claimForm.otherNames].filter(Boolean).join(' ') || 'Not entered'}</strong></div>
                <div><span>Member number</span><strong>{claimForm.memberNumber || claimForm.hin || 'Not entered'}</strong></div>
                <div><span>Requested total</span><strong>{fmtCurrency(requestedClaimTotal)}</strong></div>
                <div>
                  <span>Prescription</span>
                  <strong className={prescriptionAttachmentReview.readyClass}>
                    {prescriptionAttachmentReview.label}
                  </strong>
                </div>
              </div>

              <div className="nhis-action-review-section">
                <div className="nhis-action-review-section-heading">
                  <h3>Medicines</h3>
                  <span>{compactMedicines(claimMedicines).length}</span>
                </div>
                <div className="nhis-action-review-medicines">
                  {compactMedicines(claimMedicines).map((medicine, index) => (
                    <div className="nhis-action-review-medicine" key={`${medicine.drugCode || medicine.description}-${index}`}>
                      <div>
                        <strong>{medicine.description || medicine.drugCode || `Medicine ${index + 1}`}</strong>
                        <small>{medicine.drugCode || 'No medicine code'}</small>
                      </div>
                      <span>
                        {getMedicinePrescribedQty(medicine)} {medicine.unit || 'unit'}
                        {claimActionReview.intent === 'serve_directly' ? ' to be served' : ' requested'}
                      </span>
                    </div>
                  ))}
                  {compactMedicines(claimMedicines).length === 0 && (
                    <p className="nhis-action-review-empty">No medicines have been entered.</p>
                  )}
                </div>
              </div>

              {readiness.blockers.length > 0 && (
                <div className="nhis-action-review-issues" role="status">
                  <strong>{readiness.blockers.length} readiness issue{readiness.blockers.length === 1 ? '' : 's'}</strong>
                  <ul>
                    {readiness.blockers.slice(0, 6).map((blocker) => <li key={blocker}>{blocker}</li>)}
                  </ul>
                </div>
              )}

              {claimActionReview.duplicateWarnings?.length > 0 && (
                <div className="nhis-action-review-issues" role="alert">
                  <strong>Possible duplicate detected</strong>
                  <ul>
                    {claimActionReview.duplicateWarnings.slice(0, 6).map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                </div>
              )}

              <div className="nhis-action-review-impact">
                <strong>What happens next</strong>
                <p>
                  {claimActionReview.intent === 'serve_directly'
                    ? 'All entered quantities will be recorded as served. Dispensary review is bypassed and HealthFlow inventory stock is not added or deducted. Final NHIS submission remains blocked until mandatory information is complete.'
                    : 'The dispensary receives this same claim record. Missing details may be added later, but the claim cannot be finalized or submitted until it is complete.'}
                </p>
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setClaimActionReview(null)}>Go Back</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const intent = claimActionReview.intent
                  const medicinesToSave = intent === 'serve_directly'
                    ? markNhisMedicinesServedDirectly(claimMedicines, {
                        actorId: user?.id || '',
                      })
                    : null
                  setClaimActionReview(null)
                  if (medicinesToSave) setClaimMedicines(medicinesToSave)
                  handleSubmitClaim({ preventDefault() {} }, intent, true, medicinesToSave)
                }}
              >
                {claimActionReview.intent === 'serve_directly' ? 'Confirm & Serve Directly' : 'Confirm & Send'}
              </button>
            </div>
          </section>
        </div>
      )}

      {showMedModal && (
        <div
          className="modal-overlay modal-overlay--top"
        >
          <div className="modal-panel modal-panel--medicine">
            <div className="modal-header">
              <h2>
                {isMedicineCounterAssistant
                  ? 'Serve Medicine'
                  : editingMedicineIndex === null ? 'New Medicine' : 'Edit Medicine'}
              </h2>
              <button
                className="modal-close"
                onClick={() => closeMedicineModal()}
              >
                <X size={18} />
              </button>
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
                      disabled={isMedicineCounterAssistant}
                      onChange={(e) => {
                        setMedCodeSearch(e.target.value)
                        setMedForm((p) => ({ ...p, drugCode: e.target.value.toUpperCase(), nhisDrugId: '' }))
                      }}
                    />
                    {medSearchResults.length > 0 ? (
                      <div className="drug-dropdown">
                        {medSearchResults.map((d) => (
                          <button key={d.id} className="drug-dropdown-item" onClick={() => selectMedFromDropdown(d)}>
                            <span className="drug-name">{d.code}</span>
                            <span className="drug-meta">{d.description}</span>
                          </button>
                        ))}
                      </div>
                    ) : hasMedicineSearchTerm && !medSearching && (
                      <div className="drug-dropdown drug-dropdown--empty">
                        <span>
                          {nhisDrugs.length === 0
                            ? 'NHIS medicine catalog is still loading or empty.'
                            : 'No matching NHIS medicine found.'}
                        </span>
                      </div>
                    )}
                  </div>
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={medSearching || isMedicineCounterAssistant}
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
                  disabled={isMedicineCounterAssistant}
                  onChange={(e) => setMedForm((p) => ({ ...p, description: e.target.value }))}
                />
                {medForm.unitPrice && (
                  <span className="unit-price-hint">Unit Price: {fmtCurrency(medForm.unitPrice)}</span>
                )}
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>{isMedicineCounterAssistant ? 'Served Qty / Unit *' : 'Prescribed Qty / Unit *'}</label>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    className="form-input"
                    value={medForm.dispensedQty}
                    placeholder="0"
                    onChange={(e) => setMedForm((p) => ({ ...p, dispensedQty: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label>Unit</label>
                  <input
                    className="form-input"
                    value={medForm.unit}
                    disabled={isMedicineCounterAssistant}
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
                  disabled={!isMedicineCounterAssistant && editingMedicineIndex !== null}
                  onChange={(e) => {
                    setMedicineEntryDate(e.target.value)
                    setMedForm((p) => ({ ...p, dispensaryDate: e.target.value }))
                  }}
                />
              </div>

              {isMedicineCounterAssistant && (
                <>
                  <div className="nhis-serving-guide">
                    Choose how this prescribed medicine was handled. Use Not Available or Not Served with a reason when nothing was supplied.
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Serving result</label>
                      <select
                        className="form-input"
                        value={medForm.servingStatus}
                        onChange={(e) => setMedForm((p) => ({ ...p, servingStatus: e.target.value }))}
                      >
                        {MEDICINE_SERVING_STATUSES.map((status) => (
                          <option key={status.value} value={status.value}>{status.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Reason for partial / not served</label>
                      <select
                        className="form-input"
                        value={medForm.reasonIfNotFullyServed}
                        onChange={(e) => setMedForm((p) => ({ ...p, reasonIfNotFullyServed: e.target.value }))}
                      >
                        <option value="">Select reason</option>
                        {MEDICINE_NOT_FULLY_SERVED_REASONS.map((reason) => (
                          <option key={reason} value={reason}>{reason}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="nhis-serving-note">
                    Prescribed quantity: {medForm.prescribedQty || 0} {medForm.unit || 'unit'}
                  </div>
                </>
              )}

              {canCorrectDirectServedMedicine && editingMedicineIndex !== null && (
                <div className="nhis-direct-serving-correction">
                  <div>
                    <strong>Direct-service correction</strong>
                    <span>
                      Served {medForm.servedQty || 0} of {medForm.dispensedQty || 0} {medForm.unit || 'unit'}.
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={!(Number(medForm.dispensedQty) > 0)}
                    onClick={() => {
                      const corrected = markNhisMedicineFullyServed({
                        ...medForm,
                        prescribedQty: medForm.dispensedQty,
                      })
                      setMedForm((current) => ({
                        ...current,
                        servedQty: String(corrected.servedQty),
                        servingStatus: corrected.servingStatus,
                        reasonIfNotFullyServed: '',
                      }))
                    }}
                  >
                    Set Fully Served
                  </button>
                </div>
              )}

              <div className="nhis-section-divider">Prescription</div>

              <div className="form-row form-row--3">
                <div className="form-group">
                  <label>Dose</label>
                  <input
                    className="form-input"
                    placeholder="e.g. 1 tablet"
                    value={medForm.dose}
                    disabled={isMedicineCounterAssistant}
                    onChange={(e) => setMedForm((p) => ({ ...p, dose: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label>Frequency</label>
                  <CompactSuggestionInput
                    value={medForm.frequency}
                    disabled={isMedicineCounterAssistant}
                    onValueChange={(value) => setMedForm((p) => ({ ...p, frequency: value }))}
                    options={FREQUENCY_OPTIONS}
                    placeholder="Select or type frequency"
                    ariaLabel="Medicine frequency"
                    placement="top"
                  />
                </div>
                <div className="form-group">
                  <label>Duration</label>
                  <CompactSuggestionInput
                    value={medForm.duration}
                    disabled={isMedicineCounterAssistant}
                    onValueChange={(value) => setMedForm((p) => ({ ...p, duration: value }))}
                    options={DURATION_OPTIONS}
                    placeholder="Select or type number of days"
                    ariaLabel="Medicine duration"
                    placement="top"
                  />
                </div>
              </div>

            </div>

            <div className="modal-footer">
              <div className="medicine-footer-total">
                <span>{isMedicineCounterAssistant ? 'Served Line Total' : 'Prescribed Value'}</span>
                <strong>
                  {fmtCurrency(
                    (Number(medForm.unitPrice) || 0) * (Number(medForm.dispensedQty) || 0)
                  )}
                </strong>
              </div>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setMedForm(makeBlankMedicineForDate(medicineEntryDate))
                  setMedCodeSearch('')
                  setMedSearchResults([])
                  setEditingMedicineIndex(null)
                }}
              >
                Clear
              </button>
              <button className="btn btn-secondary" onClick={() => closeMedicineModal()}>
                Done
              </button>
              <button className="btn btn-primary" onClick={addMedicineToList}>
                {editingMedicineIndex === null ? '+ Add' : 'Save Medicine'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          VIEW CLAIM MODAL
      ══════════════════════════════════════════════════════════════ */}
      {returnAlert && (
        <div className="modal-overlay modal-overlay--top">
          <div className="modal-panel nhis-return-alert-modal">
            <div className="modal-header">
              <div>
                <h2>Patient Return Alert</h2>
                <p>{returnAlert.previousVisitMessage || `This patient was here less than ${returnAlertSettings.windowHours} hours ago.`}</p>
              </div>
              <button className="modal-close" type="button" onClick={closeReturnAlert}><X size={18} /></button>
            </div>

            <div className="nhis-return-alert-grid">
              <div className="nhis-return-alert-panel">
                <h3>Previous visit</h3>
                <dl>
                  <div><dt>Date/time</dt><dd>{formatAppDateTime(returnAlert.previousVisitAt)}</dd></div>
                  <div><dt>Facility branch</dt><dd>{getReturnAlertBranchLabel(returnAlert.previousClaim)}</dd></div>
                  <div><dt>{returnAlert.previousUserLabel || 'Served by'}</dt><dd>{getReturnAlertUserLabel(returnAlert.previousClaim)}</dd></div>
                  <div><dt>Claim status</dt><dd>{getClaimStatusLabel(returnAlert.previousClaim?.status)}</dd></div>
                  <div><dt>Matched by</dt><dd>{returnAlert.matchType}</dd></div>
                  <div><dt>Time difference</dt><dd>{returnAlert.hoursSincePrevious} hours</dd></div>
                </dl>
                <h4>{returnAlert.previousMedicineHeading || 'Medicines served'}</h4>
                {returnAlert.previousMedicines.length ? (
                  <ul className="nhis-return-alert-medicines">
                    {returnAlert.previousMedicines.map((medicine, index) => (
                      <li key={`${medicine.code || medicine.name}-${index}`}>
                        <span>{medicine.name}</span>
                        <strong>
                          {returnAlert.previousVisitIsPendingServing
                            ? `Prescribed ${medicine.prescribedQuantity || medicine.quantity || 0}`
                            : `Served ${medicine.servedQuantity || medicine.quantity || 0}`}
                        </strong>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="patient-meta">{returnAlert.previousMedicineEmptyMessage || 'No medicines recorded on previous visit.'}</p>
                )}
              </div>

              <div className="nhis-return-alert-panel">
                <h3>Current visit</h3>
                <dl>
                  <div><dt>Date/time</dt><dd>{formatAppDateTime(returnAlert.currentVisitAt)}</dd></div>
                  <div><dt>Medication status</dt><dd>{returnAlert.sameMedicationRepeated ? 'Same medication repeated' : 'Different medication or none selected'}</dd></div>
                </dl>
                {returnAlert.sameMedicationRepeated && (
                  <div className="nhis-return-alert-warning">
                    Same medicine appears in the previous visit. The duplicate dispensing alert may also apply.
                  </div>
                )}
                <label className="form-group">
                  <span>Reason for continuing</span>
                  <select
                    value={returnAlertReason}
                    onChange={(event) => setReturnAlertReason(event.target.value)}
                    disabled={!returnAlertSettings.requireReason}
                  >
                    {NHIS_RETURN_ALERT_REASONS.map((reason) => (
                      <option key={reason} value={reason}>{reason}</option>
                    ))}
                  </select>
                </label>
                {returnAlertReason === 'Other' && (
                  <label className="form-group">
                    <span>Other reason</span>
                    <textarea
                      value={returnAlertOtherReason}
                      onChange={(event) => setReturnAlertOtherReason(event.target.value)}
                      rows={3}
                      placeholder="Enter reason"
                    />
                  </label>
                )}
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn btn-secondary" type="button" onClick={closeReturnAlert}>Cancel</button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={continueReturnAlert}
                disabled={!canContinueNhisReturnAlert(role, returnAlertSettings)}
              >
                Continue after verification
              </button>
            </div>
          </div>
        </div>
      )}

      {reopenDispensaryClaim && (
        <div className="modal-overlay modal-overlay--top" onClick={(e) => e.target === e.currentTarget && closeReopenDispensaryModal()}>
          <div className="modal-panel modal-panel--export">
            <div className="modal-header">
              <div>
                <h2>Re-open dispensary correction</h2>
                <p className="modal-subtitle">
                  Claim {reopenDispensaryClaim.claim_number || 'selected claim'} will be re-opened for 12 hours.
                </p>
              </div>
              <button className="modal-close" onClick={closeReopenDispensaryModal}><X size={18} /></button>
            </div>
            <div className="export-body">
              <div className="export-info">
                Enter the reason before allowing the dispensary to correct served quantities.
              </div>
              <label className="form-group">
                <span>Reason *</span>
                <textarea
                  className="form-input"
                  rows={4}
                  value={reopenDispensaryReason}
                  onChange={(event) => setReopenDispensaryReason(event.target.value)}
                  placeholder="Example: Claims officer requested quantity correction before export."
                  autoFocus
                />
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" type="button" onClick={closeReopenDispensaryModal}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={isClaimBusy(reopenDispensaryClaim.id)}
                onClick={() => { void confirmReopenMcaEdit() }}
              >
                Re-open
              </button>
            </div>
          </div>
        </div>
      )}

      {viewClaim && (
        <div className="modal-overlay modal-overlay--top" onClick={(e) => e.target === e.currentTarget && closeViewClaim()}>
          <div className="modal-panel modal-panel--view-claim">
            <div className="modal-header">
              <div>
                <h2>{viewClaim.claim_number} <StatusBadge status={viewClaim.status} /></h2>
                {(duplicateClaimGroups.length > 0 || readinessClaimIssues.length > 0) && (
                  <p className="modal-subtitle">
                    Review mode: use the back button below to return to the issue list.
                  </p>
                )}
              </div>
              <button className="modal-close" onClick={closeViewClaim}><X size={18} /></button>
            </div>
            <div className="view-claim-grid">
              <div><strong>Patient:</strong> {viewClaim.surname} {viewClaim.other_names || ''}</div>
              <div><strong>Member No:</strong> {viewClaim.member_no || '—'}</div>
              <div><strong>HIN:</strong> {viewClaim.hin || '—'}</div>
              <div><strong>Folder No:</strong> {viewClaim.folder_no || '—'}</div>
              <div><strong>Gender:</strong> {viewClaim.gender || '—'}</div>
              <div><strong>DOB:</strong> {viewClaim.date_of_birth ? formatAppDate(viewClaim.date_of_birth) : '—'}</div>
              {isHospital && <div><strong>Address:</strong> {viewClaim.patient_address || '—'}</div>}
              {isHospital && <div><strong>Child Weight:</strong> {viewClaim.child_weight_kg ? `${viewClaim.child_weight_kg} kg` : '—'}</div>}
              <div><strong>CCC / CC Code:</strong> {viewClaim.ccc_no || '—'}</div>
              {isHospital && <div><strong>Diagnoses:</strong> {viewClaim.diagnosis || '—'}</div>}
              <div><strong>Date/time of Service:</strong> {formatNhisServiceDateTime(viewClaim)}</div>
              <div><strong>Prescribing Facility:</strong> {viewClaim.referring_facility || '—'}</div>
              <div><strong>Referral Code:</strong> {viewClaim.referral_code || '—'}</div>
              <div><strong>Prescriber:</strong> {viewClaim.physician_name || '—'}</div>
              <div><strong>Prescription Reference:</strong> {viewClaim.prescription_reference || '—'}</div>
              <div><strong>Prescription Entered By:</strong> {viewClaim.prescription_entry_user_name || viewClaim.prescription_entered_by || '—'}</div>
              <div><strong>Prescription Entered At:</strong> {viewClaim.prescription_entered_at ? formatAppDateTime(viewClaim.prescription_entered_at) : '—'}</div>
              <div><strong>Prescription Last Updated By:</strong> {viewClaim.prescription_update_user_name || viewClaim.prescription_updated_by || '—'}</div>
              <div><strong>Prescription Last Updated At:</strong> {viewClaim.prescription_updated_at ? formatAppDateTime(viewClaim.prescription_updated_at) : '—'}</div>
              <div><strong>Pre-auth Codes:</strong> {viewClaim.pre_auth_codes || '—'}</div>
              <div><strong>Served Directly By:</strong> {viewClaim.direct_served_by_name || viewClaim.direct_served_by || '-'}</div>
              <div><strong>Served Directly At:</strong> {viewClaim.direct_served_at ? formatAppDateTime(viewClaim.direct_served_at) : '-'}</div>
              <div><strong>Medicines Not Served:</strong> {viewClaim.unserved_medicines_note || '-'}</div>
              <div>
                <strong>Prescription File:</strong>{' '}
                {(viewClaim.prescription_file_path || viewClaim.prescription_file_url) ? (
                  <button type="button" className="inline-file-button" onClick={() => openPrescriptionPdf(viewClaim)}>
                    <FileText size={14} /> {viewClaim.prescription_file_name || 'Open prescription'}
                  </button>
                ) : (
                  '—'
                )}
              </div>
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
                  <th>Served By</th>
                  <th>Served At</th>
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
                    <td>{m.served_by_mca_name || m.served_by_mca || viewClaim.direct_served_by_name || '-'}</td>
                    <td>{m.served_at ? formatAppDateTime(m.served_at) : '-'}</td>
                    <td>{m.dose || '—'}</td>
                    <td>{m.frequency || '—'}</td>
                    <td>{m.duration || '—'}</td>
                  </tr>
                ))}
                {(viewClaim.nhis_claim_services || []).map((service) => (
                  <tr key={service.id}>
                    <td className="drug-code-cell">{service.gdrg_code || '—'}</td>
                    <td>{service.description}</td>
                    <td>{service.quantity}</td>
                    <td>service</td>
                    <td>{fmtCurrency(service.unit_price)}</td>
                    <td>{fmtCurrency(service.total_amount)}</td>
                    <td colSpan={5}>
                      {service.mdc || 'NHIA tariff'} {service.facility_group ? `- ${service.facility_group}` : ''}
                      {service.catering_option ? ` | ${service.catering_option}` : ''}
                      {service.age_band ? ` | ${service.age_band}` : ''}
                      {service.source_file ? ` | ${service.source_file}${service.source_page ? ` p.${service.source_page}` : ''}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} className="total-label">Claim Total</td>
                  <td colSpan={6} className="total-value">{fmtCurrency(viewClaim.total_amount)}</td>
                </tr>
              </tfoot>
            </table>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={closeViewClaim}>
                {duplicateClaimGroups.length > 0
                  ? 'Back to duplicates'
                  : readinessClaimIssues.length > 0
                    ? 'Back to scrub issues'
                    : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          ADD / EDIT DRUG MODAL
      ══════════════════════════════════════════════════════════════ */}
      {editingTariff && (
        <div className="modal-overlay">
          <div className="modal-panel modal-panel--drug">
            <div className="modal-header">
              <h2>Edit G-DRG Tariff</h2>
              <button className="modal-close" onClick={closeTariffModal}><X size={18} /></button>
            </div>
            <form className="drug-form" onSubmit={handleSaveTariff}>
              <div className="form-row">
                <div className="form-group">
                  <label>G-DRG Code</label>
                  <input className="form-input" value={tariffForm.gdrgCode} readOnly />
                </div>
                <div className="form-group">
                  <label>Tariff Version</label>
                  <input className="form-input" value={tariffForm.tariffVersion} readOnly />
                </div>
              </div>
              <div className="form-group">
                <label>Description *</label>
                <input className="form-input" required value={tariffForm.description}
                  onChange={(e) => setTariffForm((p) => ({ ...p, description: e.target.value }))} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>MDC</label>
                  <input className="form-input" value={tariffForm.mdc}
                    onChange={(e) => setTariffForm((p) => ({ ...p, mdc: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Age Band</label>
                  <input className="form-input" value={tariffForm.ageBand}
                    onChange={(e) => setTariffForm((p) => ({ ...p, ageBand: e.target.value }))} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Facility Group</label>
                  <input className="form-input" value={tariffForm.facilityGroup}
                    onChange={(e) => setTariffForm((p) => ({ ...p, facilityGroup: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Catering Option</label>
                  <input className="form-input" value={tariffForm.cateringOption}
                    onChange={(e) => setTariffForm((p) => ({ ...p, cateringOption: e.target.value }))} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Tariff Amount (GHS) *</label>
                  <input type="number" min="0" step="0.01" className="form-input" required
                    value={tariffForm.tariffAmount}
                    onChange={(e) => setTariffForm((p) => ({ ...p, tariffAmount: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Currency</label>
                  <input className="form-input" value={tariffForm.currency}
                    onChange={(e) => setTariffForm((p) => ({ ...p, currency: e.target.value.toUpperCase() }))} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Source File</label>
                  <input className="form-input" value={tariffForm.sourceFile}
                    onChange={(e) => setTariffForm((p) => ({ ...p, sourceFile: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Source Page</label>
                  <input type="number" min="0" step="1" className="form-input" value={tariffForm.sourcePage}
                    onChange={(e) => setTariffForm((p) => ({ ...p, sourcePage: e.target.value }))} />
                </div>
              </div>
              <div className="modal-footer" style={{ padding: '0', marginTop: '1rem' }}>
                <button type="button" className="btn btn-secondary" onClick={closeTariffModal}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={tariffSubmitting}>
                  {tariffSubmitting ? 'Saving...' : 'Update G-DRG'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showDrugCatalogModal && (
        <div className="modal-overlay">
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
                  <label>Level of Prescribing *</label>
                  <select className="form-input" required value={drugForm.category}
                    onChange={(e) => setDrugForm((p) => ({ ...p, category: e.target.value }))}>
                    <option value="">Select level</option>
                    {['A', 'M', 'B1', 'B2', 'C', 'D', 'SM'].map((level) => (
                      <option key={level} value={level}>{level}</option>
                    ))}
                  </select>
                </div>
              </div>
              {/* ✅ NHIS PHARMACY LEVEL PATCH START */}
              <div className="form-row">
                <div className="form-group">
                  <label>Medicine access level</label>
                  <select
                    className="form-input"
                    value={drugForm.medicineAccessLevel}
                    onChange={(e) => setDrugForm((p) => ({ ...p, medicineAccessLevel: e.target.value }))}
                  >
                    <option value="">Level not configured</option>
                    {MEDICINE_ACCESS_LEVELS.map((level) => (
                      <option key={level.value} value={level.value}>{level.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Required pharmacy/facility level</label>
                  <select
                    className="form-input"
                    value={drugForm.requiredPharmacyLevel}
                    onChange={(e) => setDrugForm((p) => ({ ...p, requiredPharmacyLevel: e.target.value }))}
                  >
                    <option value="">Any configured level</option>
                    {PHARMACY_LEVELS.map((level) => (
                      <option key={level.value} value={level.value}>{level.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              {/* ✅ NHIS PHARMACY LEVEL PATCH END */}
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
        <div className="modal-overlay">
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
      {showRuleImportModal && (
        <div className="modal-overlay">
          <div className="modal-panel modal-panel--import">
            <div className="modal-header">
              <h2>Clinical Rule Preview — {ruleImportRows.length} rules</h2>
              <button className="modal-close" onClick={() => setShowRuleImportModal(false)}><X size={18} /></button>
            </div>
            {ruleImportErrors.length > 0 && (
              <div className="nhis-alert">
                {ruleImportErrors.slice(0, 5).map((e, i) => <div key={i}>{e}</div>)}
                {ruleImportErrors.length > 5 && <div>...and {ruleImportErrors.length - 5} more warnings</div>}
              </div>
            )}
            <div className="import-table-wrap">
              <table className="nhis-table">
                <thead>
                  <tr>
                    <th>Diagnosis</th>
                    <th>Diagnosis Keywords</th>
                    <th>Drug Codes</th>
                    <th>Drug Keywords</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {ruleImportRows.slice(0, 50).map((rule, i) => (
                    <tr key={i}>
                      <td>{rule.diagnosis_label}</td>
                      <td>{(rule.diagnosis_keywords || []).join(', ')}</td>
                      <td>{(rule.allowed_drug_codes || []).join(', ') || '—'}</td>
                      <td>{(rule.allowed_drug_keywords || []).join(', ') || '—'}</td>
                      <td><StatusBadge status={rule.severity || 'block'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ruleImportRows.length > 50 && (
                <div className="import-more">...and {ruleImportRows.length - 50} more rows</div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowRuleImportModal(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={ruleImporting || !ruleImportRows.length} onClick={handleConfirmRuleImport}>
                {ruleImporting ? 'Importing...' : `Import ${ruleImportRows.length} Rules`}
              </button>
            </div>
          </div>
        </div>
      )}

      {showReadinessClaimReview && readinessClaimIssues.length > 0 && (
        <div className="modal-overlay modal-overlay--top" onClick={(e) => e.target === e.currentTarget && closeReadinessClaimReview()}>
          <div className="modal-panel modal-panel--duplicates">
            <div className="modal-header">
              <h2>Claims Scrub Issues Found</h2>
              <button className="modal-close" onClick={closeReadinessClaimReview}><X size={18} /></button>
            </div>
              <div className="duplicate-claims-body">
                <div className="nhis-alert">
                  HealthFlow found {readinessClaimIssues.length} claim{readinessClaimIssues.length === 1 ? '' : 's'} in this period with scrub issues.
                  {readinessExportBlockingCount > 0 && (
                    <> {readinessExportBlockingCount} exportable claim{readinessExportBlockingCount === 1 ? '' : 's'} must be corrected before export.</>
                  )}
                  {readinessNotIncludedCount > 0 && (
                    <> {readinessNotIncludedCount} open claim{readinessNotIncludedCount === 1 ? ' is' : 's are'} listed for correction but {readinessNotIncludedCount === 1 ? 'is' : 'are'} not included in this CXF until served/submitted.</>
                  )}
                </div>
                <div className="readiness-review-toolbar">
                  <div className="readiness-progress">
                    <strong>{readinessClaimIssues.length}</strong> shown
                    {readinessExportBlockingCount > 0 && (
                      <span>{readinessExportBlockingCount} blocking export</span>
                    )}
                    {readinessNotIncludedCount > 0 && (
                      <span>{readinessNotIncludedCount} not included yet</span>
                    )}
                    {readinessFixedCount > 0 && <span>{readinessFixedCount} fixed in this session</span>}
                  </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={readinessChecking || !exportPeriodReady}
                  onClick={() => { void handleCheckExportReadiness({ keepModalOpen: true }) }}
                >
                  <Search size={14} /> {readinessChecking ? 'Scrubbing...' : 'Scrub Remaining Claims'}
                </button>
              </div>
              <div className="nhis-export-period-note">
                Served/submitted claims must be corrected before export. Draft, pending serving, and returned claims are shown for correction, but they are not included in the CXF until their status becomes served/submitted.
              </div>
              <div className="readiness-filter-tabs" aria-label="Filter incomplete claims">
                {READINESS_FILTERS.map((filter) => {
                  const count = readinessIssueCounts[filter.id] || 0
                  return (
                    <button
                      key={filter.id}
                      type="button"
                      className={readinessIssueFilter === filter.id ? 'active' : ''}
                      disabled={count === 0 && filter.id !== 'all'}
                      onClick={() => setReadinessIssueFilter(filter.id)}
                    >
                      {filter.label} <span>{count}</span>
                    </button>
                  )
                })}
              </div>
              {readinessIssueFilter === 'attachment' && (
                <div className="nhis-export-period-note">
                  Attachment view shows claims that need a scanned prescription, attachment type, or prescription verification.
                </div>
              )}
              <div className="readiness-search-control">
                <Search size={15} />
                <input
                  type="search"
                  value={readinessIssueSearch}
                  onChange={(event) => setReadinessIssueSearch(event.target.value)}
                  placeholder="Search by claim, patient, member/HIN, folder, CCC, or issue..."
                  aria-label="Search scrub issue claims"
                />
              </div>
              <div className="duplicate-claim-table-wrap">
                <table className="nhis-table duplicate-claim-table readiness-claim-table">
                  <thead>
                    <tr>
                      <th>Claim</th>
                      <th>Patient</th>
                      <th>Service Date</th>
                      <th>Issues to Fix</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReadinessClaimIssues.map((issue, index) => {
                      const claimForAction = { ...issue, _summaryOnly: true }
                      const patientName = issue.patientName || [issue.surname, issue.other_names].filter(Boolean).join(' ') || 'Unknown'
                      const issueList = Array.isArray(issue.issues) ? issue.issues : []
                      const issueCategories = getReadinessIssueCategories(issue)
                      return (
                        <tr key={issue.id || issue.claim_number || index}>
                          <td>{issue.claim_number || 'Unnumbered'}</td>
                          <td>
                            {patientName}
                            <small>Folder: {issue.folder_no || '-'}</small>
                            <small>Member/HIN: {issue.member_no || issue.hin || '-'}</small>
                          </td>
                          <td>{formatNhisServiceDateTime(issue)}</td>
                          <td>
                            <div className="readiness-issue-category-list" aria-label="Issue categories">
                              {issueCategories.map((category) => (
                                <span
                                  key={`${issue.id || issue.claim_number || index}-${category}`}
                                  className={`readiness-issue-category readiness-issue-category--${category}`}
                                >
                                  {READINESS_CATEGORY_LABELS[category] || category}
                                </span>
                              ))}
                            </div>
                            <ul className="readiness-issue-list">
                              {(issueList.length ? issueList : ['Claim is incomplete for export.']).map((text, itemIndex) => {
                                const severity = getReadinessIssueSeverity(text)
                                return (
                                  <li key={`${issue.id || index}-issue-${itemIndex}`}>
                                    <span className={`readiness-issue-chip readiness-issue-chip--${severity}`}>
                                      {severity === 'error' ? 'Error' : severity === 'warning' ? 'Warning' : 'Info'}
                                    </span>
                                    <span className="readiness-issue-type">{getReadinessIssueLabel(text)}</span>
                                    <span>{text}</span>
                                  </li>
                                )
                              })}
                            </ul>
                          </td>
                          <td>
                            <StatusBadge status={issue.status || 'served'} />
                            {isReadinessIssueNotIncluded(issue) && (
                              <small className="readiness-export-note">Not included in CXF yet</small>
                            )}
                          </td>
                          <td>
                            <div className="readiness-claim-actions">
                              <button
                                type="button"
                                className="action-btn action-btn--view readiness-action-btn"
                                title="View claim"
                                aria-label={`View claim ${issue.claim_number || patientName}`}
                                onClick={() => {
                                  setShowExportModal(false)
                                  setShowReadinessClaimReview(false)
                                  void openViewClaim(claimForAction).then((opened) => {
                                    if (!opened) returnToReadinessClaimReview()
                                  })
                                }}
                              >
                                <Eye size={14} />
                              </button>
                              <button
                                type="button"
                                className="action-btn action-btn--edit readiness-action-btn"
                                title="Correct issue"
                                aria-label={`Correct issue for ${issue.claim_number || patientName}`}
                                onClick={() => {
                                  void openReadinessIssueForEdit(issue)
                                }}
                              >
                                <Pencil size={14} />
                              </button>
                              {canReopenMca && issue.status === 'served' && !isNhisClaimDirectlyServed(issue) && !isMcaEditWindowOpen(issue) && (
                                <button
                                  type="button"
                                  className="action-btn action-btn--edit readiness-action-btn"
                                  title="Re-open dispensary correction window (12 hours)"
                                  aria-label={`Re-open dispensary correction window for ${issue.claim_number || patientName}`}
                                  disabled={isClaimBusy(issue.id)}
                                  onClick={() => handleReopenMcaEdit(issue)}
                                >
                                  <Clock size={14} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {filteredReadinessClaimIssues.length === 0 && (
                <div className="readiness-empty">
                  No claims match this filter{readinessIssueSearch ? ' and search.' : '.'}
                </div>
              )}
            </div>
            <div className="modal-footer">
              {readinessExportBlockingCount === 0 && readinessNotIncludedCount > 0 && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={exporting || readinessChecking}
                  onClick={handleContinueExportAfterIssueReview}
                >
                  Continue Export
                </button>
              )}
              <button className="btn btn-secondary" onClick={closeReadinessClaimReview}>Close</button>
            </div>
          </div>
        </div>
      )}

      {showDuplicateClaimReview && duplicateClaimGroups.length > 0 && (
        <div className="modal-overlay modal-overlay--top" onClick={(e) => e.target === e.currentTarget && closeDuplicateClaimReview()}>
          <div className="modal-panel modal-panel--duplicates">
            <div className="modal-header">
              <h2>Duplicate Claims Found</h2>
              <button className="modal-close" onClick={closeDuplicateClaimReview}><X size={18} /></button>
            </div>
            <div className="duplicate-claims-body">
              <div className="nhis-alert">
                HealthFlow found {duplicateClaimGroups.length} duplicate group{duplicateClaimGroups.length === 1 ? '' : 's'} in this export batch.
                {duplicateExportIssues.length > 0
                  ? ' Other export blockers were also found; fix all issues before exporting.'
                  : ' Correct or remove one claim from each group before exporting.'}
              </div>
              <div className="nhis-export-period-note">
                Export period uses service/submission month. Entered Date and Last Edited only show when the claim was created or corrected.
              </div>
              <div className="readiness-search-control">
                <Search size={15} />
                <input
                  type="search"
                  value={duplicateClaimSearch}
                  onChange={(event) => setDuplicateClaimSearch(event.target.value)}
                  placeholder="Search duplicate groups by claim, patient, member/HIN, folder, CCC, date, or status..."
                  aria-label="Search duplicate claim groups"
                />
              </div>
              {duplicateExportIssues.length > 0 && (
                <div className="nhis-export-blocker-summary" role="alert">
                  <h3>Other Export Blockers</h3>
                  <ul>
                    {duplicateExportIssues.map((issue, index) => (
                      <li key={`${issue.type || 'issue'}-${index}`}>
                        <strong>{issue.title || 'Export blocker'}:</strong> {issue.message}
                        {Array.isArray(issue.claims) && issue.claims.length > 0 && (
                          <small>
                            Examples: {issue.claims.map((claim) =>
                              claim.claim_number || claim.patientName || 'Unnumbered claim'
                            ).join(', ')}
                            {issue.total > issue.claims.length ? `, plus ${issue.total - issue.claims.length} more` : ''}
                          </small>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {filteredDuplicateClaimGroups.map((group, groupIndex) => {
                const groupClaims = group.claims || []
                const likelyOriginalClaimId = getLikelyOriginalClaimId(groupClaims)
                return (
                  <section className="duplicate-claim-group" key={group.key || groupIndex}>
                    <div className="duplicate-claim-group-header">
                      <div>
                        <h3>{group.patientName || 'Patient duplicate group'}</h3>
                        <p>
                          Member/HIN: {group.member || 'Not recorded'} · Service date: {group.serviceDate || 'Not recorded'} · Total: GHS {Number(group.totalAmount || 0).toFixed(2)}
                        </p>
                      </div>
                      <span>{groupClaims.length} claims</span>
                    </div>
                    <div className="duplicate-claim-table-wrap">
                      <table className="nhis-table duplicate-claim-table">
                        <thead>
                          <tr>
                            <th>Claim</th>
                            <th>Patient</th>
                            <th>Service Date (Export Period)</th>
                            <th>Entered Date</th>
                            <th>Last Edited</th>
                            <th>Recommendation</th>
                            <th>Status</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {groupClaims.map((claim) => {
                            const claimForAction = { ...claim, _summaryOnly: true }
                            const isLikelyOriginal = claim.id && claim.id === likelyOriginalClaimId
                            return (
                              <tr key={claim.id || claim.claim_number}>
                                <td>{claim.claim_number || 'Unnumbered'}</td>
                                <td>
                                  {[claim.surname, claim.other_names].filter(Boolean).join(' ') || 'Unknown'}
                                  <small>Folder: {claim.folder_no || '—'}</small>
                                </td>
                                <td>{formatNhisServiceDateTime(claim)}</td>
                                <td>{getClaimCreatedTimestamp(claim) ? formatAppDateTime(getClaimCreatedTimestamp(claim)) : '—'}</td>
                                <td>{getClaimUpdatedTimestamp(claim) ? formatAppDateTime(getClaimUpdatedTimestamp(claim)) : '—'}</td>
                                <td>
                                  <span className={`duplicate-recommendation ${isLikelyOriginal ? 'duplicate-recommendation--keep' : 'duplicate-recommendation--remove'}`}>
                                    {isLikelyOriginal ? 'Likely original' : 'Likely duplicate'}
                                  </span>
                                </td>
                                <td><StatusBadge status={claim.status || 'served'} /></td>
                                <td>
                                  <div className="duplicate-claim-actions">
                                    <button
                                      type="button"
                                      className="duplicate-keep-button"
                                      disabled={!canDeleteNhisClaims || Boolean(updatingStatus)}
                                      title={canDeleteNhisClaims ? 'Keep this claim and move the others to Recycle Bin' : 'Only an administrator can resolve duplicates'}
                                      onClick={() => {
                                        void handleKeepDuplicateClaim(group, claimForAction)
                                      }}
                                    >
                                      <CheckCircle2 size={14} /> Keep this
                                    </button>
                                    <button
                                      type="button"
                                      className="duplicate-recycle-button"
                                      disabled={!canDeleteNhisClaims || Boolean(updatingStatus) || groupClaims.length <= 1}
                                      title={canDeleteNhisClaims ? 'Delete only this duplicate claim by moving it to the Recycle Bin' : 'Only an administrator can resolve duplicates'}
                                      onClick={() => {
                                        void handleRecycleDuplicateClaim(group, claimForAction)
                                      }}
                                    >
                                      <Trash2 size={14} /> Delete duplicate
                                    </button>
                                    <button
                                      type="button"
                                      className="action-btn action-btn--view readiness-action-btn"
                                      title="View claim"
                                      onClick={() => {
                                        setShowDuplicateClaimReview(false)
                                        void openViewClaim(claimForAction).then((opened) => {
                                          if (!opened) returnToDuplicateClaimReview()
                                        })
                                      }}
                                    >
                                      <Eye size={14} />
                                      <span>View</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="action-btn action-btn--edit readiness-action-btn"
                                      title="Edit claim"
                                      onClick={() => {
                                        setShowDuplicateClaimReview(false)
                                        setShowExportModal(false)
                                        void openEditClaim(claimForAction).then((opened) => {
                                          if (!opened) returnToDuplicateClaimReview()
                                        })
                                      }}
                                    >
                                      <Pencil size={14} />
                                      <span>Edit</span>
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )
              })}
              {filteredDuplicateClaimGroups.length === 0 && (
                <div className="readiness-empty">
                  No duplicate groups match this search.
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={closeDuplicateClaimReview}>Close</button>
            </div>
          </div>
        </div>
      )}

      {showScrubWarningOverride && scrubWarningClaims.length > 0 && (
        <div className="modal-overlay modal-overlay--top">
          <div className="modal-panel modal-panel--duplicates">
            <div className="modal-header">
              <h2>Scrub Warnings Need Review</h2>
              <button
                className="modal-close"
                onClick={() => {
                  setShowScrubWarningOverride(false)
                  setScrubWarningSearch('')
                  preparedReadinessCacheRef.current = null
                }}
              >
                <X size={18} />
              </button>
            </div>
            <div className="duplicate-claims-body">
              <div className="nhis-alert">
                HealthFlow found {scrubWarningClaims.length} claim{scrubWarningClaims.length === 1 ? '' : 's'} with warnings. These are not hard errors, but a claims officer/admin must record why export should continue.
              </div>
              <div className="readiness-search-control">
                <Search size={15} />
                <input
                  type="search"
                  value={scrubWarningSearch}
                  onChange={(event) => setScrubWarningSearch(event.target.value)}
                  placeholder="Search warning claims by claim, patient, member/HIN, folder, or warning..."
                  aria-label="Search scrub warning claims"
                />
              </div>
              <div className="duplicate-claim-table-wrap">
                <table className="nhis-table duplicate-claim-table readiness-claim-table">
                  <thead>
                    <tr>
                      <th>Claim</th>
                      <th>Patient</th>
                      <th>Warnings</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredScrubWarningClaims.slice(0, 25).map((issue, index) => {
                      const patientName = issue.patientName || [issue.surname, issue.other_names].filter(Boolean).join(' ') || 'Unknown'
                      return (
                        <tr key={issue.id || issue.claim_number || index}>
                          <td>{issue.claim_number || 'Unnumbered'}</td>
                          <td>
                            {patientName}
                            <small>Member/HIN: {issue.member_no || issue.hin || '-'}</small>
                          </td>
                          <td>
                            <ul className="readiness-issue-list">
                              {(issue.issues || []).slice(0, 3).map((text, itemIndex) => (
                                <li key={`${issue.id || index}-warning-${itemIndex}`}>{text}</li>
                              ))}
                            </ul>
                            {(issue.issues || []).length > 3 && <small>{issue.issues.length - 3} more warning{issue.issues.length - 3 === 1 ? '' : 's'}</small>}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="action-btn action-btn--edit readiness-action-btn"
                              title="Review warning"
                              aria-label={`Review warning for ${issue.claim_number || patientName}`}
                              onClick={() => { void handleScrubClaim({ ...issue, _summaryOnly: true }) }}
                            >
                              <HeartPulse size={14} />
                              <span>Review warning</span>
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {filteredScrubWarningClaims.length === 0 && (
                <div className="readiness-empty">
                  No warning claims match this search.
                </div>
              )}
              {filteredScrubWarningClaims.length > 25 && (
                <div className="nhis-export-period-note">
                  Showing first 25 matching warning claims. The override reason applies to all {scrubWarningClaims.length} warning claim{scrubWarningClaims.length === 1 ? '' : 's'}.
                </div>
              )}
              <div className="form-group">
                <label>Override reason</label>
                <textarea
                  className="form-input"
                  rows={3}
                  value={scrubWarningOverrideReason}
                  onChange={(event) => setScrubWarningOverrideReason(event.target.value)}
                  placeholder="Example: Warnings reviewed against prescription and clinical notes; proceed with export."
                />
              </div>
              {exporting && (
                <div className="nhis-export-period-note" role="status" aria-live="polite">
                  {exportProgress || 'Preparing export'}
                  {exportElapsedSeconds > 0 ? ` — ${exportElapsedSeconds}s elapsed` : ''}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                disabled={exporting}
                onClick={() => {
                  setShowScrubWarningOverride(false)
                  setScrubWarningSearch('')
                  preparedReadinessCacheRef.current = null
                }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={exporting || !normalizeText(scrubWarningOverrideReason)}
                onClick={() => {
                  const resumeTarget = exportResumeTargetRef.current
                  if (resumeTarget?.type === 'single' && resumeTarget.claim) {
                    void handleExportSingleClaim(resumeTarget.claim, scrubWarningOverrideReason)
                  } else {
                    void handleExport(scrubWarningOverrideReason)
                  }
                }}
              >
                {exporting ? (exportProgress || 'Exporting...') : 'Approve Warnings & Export'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showExportModal && (
        <div className="modal-overlay">
          <div className="modal-panel modal-panel--export">
            <div className="modal-header">
              <h2>{directNhiaApiAvailable ? 'NHIS Claim Transfer' : 'Claims Batch Export'}</h2>
              <button className="modal-close" onClick={() => setShowExportModal(false)}><X size={18} /></button>
            </div>
            <div className="export-body">
              <p className="export-info">
                {directNhiaApiAvailable && exportRoute === 'direct_api' ? (
                  <>
                    Submit Direct API is selected. Claims in the selected period will be sent through the configured direct submission integration.
                    Successfully sent <strong>Served</strong> claims will be marked as <strong>Submitted</strong>.
                  </>
                ) : (
                  <>
                    Export CXF is selected. Direct CLAIM-it CXF import is not allowed by the API; manual CLAIM-it import is required.
                    Downloaded claims remain <strong>Served</strong> so they can be corrected or exported again if CLAIM-it rejects the file.
                  </>
                )}
              </p>
              {directNhiaApiAvailable && (
                <div className="form-group">
                  <label>Submission Route</label>
                  <select
                    className="form-input"
                    value={exportRoute}
                    onChange={(e) => setExportRoute(e.target.value)}
                  >
                    <option value="cxf_export">Export CXF - Manual CLAIM-it Import Required</option>
                    <option value="direct_api">Submit Direct API</option>
                  </select>
                </div>
              )}
              {(!directNhiaApiAvailable || exportRoute !== 'direct_api') && (
                <div className="form-group">
                  <label>Export File Type</label>
                  <select
                    className="form-input"
                    value={exportFormat}
                    onChange={(e) => setExportFormat(e.target.value)}
                  >
                    <option value="cxf">Export CXF (.cxf)</option>
                    <option value="xml">XML file (.xml)</option>
                    <option value="json">JSON for CLAIM-it</option>
                    <option value="csv">CSV review file</option>
                  </select>
                </div>
              )}
              <div className="form-group">
                <label>Export Period</label>
                <select
                  className="form-input"
                  value={exportMode}
                  onChange={(e) => setExportMode(e.target.value)}
                  >
                    <option value="partial">Month-to-date partial batch</option>
                    <option value="month">Monthly batch</option>
                    <option value="custom">Custom date range</option>
                  </select>
                </div>
              {exportMode === 'month' ? (
                <div className="form-group">
                  <label>Select Month</label>
                  <input
                    type="month"
                    className="form-input"
                    value={exportMonth}
                    onChange={(e) => setExportMonth(e.target.value)}
                  />
                </div>
              ) : exportMode === 'partial' ? (
                <div className="form-group">
                  <label>Up To Date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={exportToDate}
                    onChange={(e) => setExportToDate(e.target.value)}
                  />
                  <small>Matches CLAIM-it partial export: first day of this month through the selected date.</small>
                </div>
              ) : (
                <div className="form-row">
                  <div className="form-group">
                    <label>From Date</label>
                    <input
                      type="date"
                      className="form-input"
                      value={exportFromDate}
                      onChange={(e) => setExportFromDate(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label>To Date</label>
                    <input
                      type="date"
                      className="form-input"
                      value={exportToDate}
                      onChange={(e) => setExportToDate(e.target.value)}
                    />
                  </div>
                </div>
              )}
              {exporting && exportProgress && (
                <div className="nhis-export-period-note" role="status" aria-live="polite">
                  {exportProgress}
                  {exportElapsedSeconds > 0 ? ` — ${exportElapsedSeconds}s elapsed` : ''}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowExportModal(false)}>Cancel</button>
              <button
                className="btn btn-secondary"
                disabled={exporting || readinessChecking || !exportPeriodReady}
                onClick={() => { void handleCheckExportReadiness({ keepModalOpen: true }) }}
              >
                <CheckCircle2 size={14} /> {readinessChecking ? 'Scrubbing...' : 'Scrub All Claims'}
              </button>
              <button className="btn btn-primary" disabled={exporting || !exportPeriodReady} onClick={() => { void handleExport() }}>
                {exporting
                  ? (directNhiaApiAvailable && exportRoute === 'direct_api' ? 'Submitting...' : 'Exporting...')
                  : <><Download size={14} /> {directNhiaApiAvailable && exportRoute === 'direct_api' ? 'Submit Direct API' : 'Export CXF'}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          REJECT MODAL
      ══════════════════════════════════════════════════════════════ */}
      {durationRepairReview && (
        <div className="modal-overlay">
          <div className="modal-panel modal-panel--duration-repair">
            <div className="modal-header">
              <div>
                <h2>Pre-Export Duration Review</h2>
                <small>Corrections are saved to HealthFlow and audited before the batch is generated.</small>
              </div>
              <button
                className="modal-close"
                disabled={durationRepairSaving}
                onClick={() => {
                  setDurationRepairReview(null)
                  setDurationRepairValues({})
                  setDurationRepairFilter('all')
                }}
              ><X size={18} /></button>
            </div>
            <div className="duration-repair-body">
              <div className="duration-repair-summary">
                <div><strong>{durationRepairReview.claimsScanned}</strong><span>Claims scanned</span></div>
                <button
                  type="button"
                  className={durationRepairFilter === 'all' ? 'is-active' : ''}
                  onClick={() => selectDurationRepairFilter('all')}
                ><strong>{durationRepairReview.valuesScanned}</strong><span>Medicine durations checked</span></button>
                <button
                  type="button"
                  className={durationRepairFilter === 'valid' ? 'is-active' : ''}
                  onClick={() => selectDurationRepairFilter('valid')}
                ><strong>{durationRepairReview.alreadyValid}</strong><span>Durations already valid</span></button>
                <button
                  type="button"
                  className={durationRepairFilter === 'automatic' ? 'is-active' : ''}
                  onClick={() => selectDurationRepairFilter('automatic')}
                ><strong>{durationRepairCorrectionsReadyCount}</strong><span>Safe/corrected durations</span></button>
                <button
                  type="button"
                  className={`${durationRepairUnresolvedCount ? 'has-warning' : 'is-resolved'}${durationRepairFilter === 'manual' ? ' is-active' : ''}`}
                  onClick={() => selectDurationRepairFilter('manual')}
                ><strong>{durationRepairUnresolvedCount}</strong><span>Durations needing review</span></button>
              </div>
              <p className="duration-repair-note">
                Exact weeks use 7 days, exact months use 30 days, and bare whole numbers are treated as days only because this is the medicine duration field. Ambiguous values are never guessed.
              </p>
              {durationRepairUnresolvedCount === 0 && (
                <div className="duration-repair-ready" role="status">
                  <CheckCircle2 size={17} /> All duration issues resolved — Ready to export
                </div>
              )}
              <div className="duration-repair-filter-bar">
                <strong>
                  Showing {durationRepairVisibleRows.length.toLocaleString()} of {durationRepairReview.valuesScanned.toLocaleString()} medicine durations
                </strong>
                {durationRepairFilter !== 'all' && (
                  <button type="button" onClick={() => selectDurationRepairFilter('all')}>Show all / Clear filter</button>
                )}
              </div>
              <div className="duration-repair-table-wrap" ref={durationRepairTableRef}>
                <table className="data-table duration-repair-table">
                  <thead>
                    <tr><th>Claim</th><th>Medicine</th><th>Previous</th><th>Correct duration</th><th>Method</th></tr>
                  </thead>
                  <tbody>
                    {durationRepairVisibleRows.map((row) => {
                      const isUnresolved = row.status === 'manual' && !row.manualReady
                      const displayStatus = row.status === 'valid'
                        ? 'Valid'
                        : row.status === 'automatic'
                          ? 'Automatic'
                          : row.manualReady ? 'Ready' : 'Needs review'
                      return (
                        <tr key={row.key} className={isUnresolved ? 'duration-repair-row--unresolved' : ''}>
                          <td className="duration-repair-claim">{row.claimNumber}</td>
                          <td className="duration-repair-medicine"><strong>{row.medicineCode || '—'}</strong><small>{row.medicineName}</small></td>
                          <td>{row.originalValue || <em>Missing</em>}</td>
                          <td>
                            <input
                              className={`form-input duration-repair-input${isUnresolved && row.enteredValue ? ' is-invalid' : ''}`}
                              value={row.status === 'valid' ? row.originalValue : (durationRepairValues[row.key] || '')}
                              readOnly={row.status !== 'manual'}
                              placeholder="e.g. 90 days"
                              data-duration-unresolved={isUnresolved ? 'true' : undefined}
                              onChange={(event) => setDurationRepairValues((current) => ({
                                ...current,
                                [row.key]: event.target.value,
                              }))}
                              onBlur={() => {
                                const canonicalValue = normalizeNhisManualDurationCorrection(
                                  durationRepairValues[row.key]
                                )
                                if (canonicalValue) {
                                  setDurationRepairValues((current) => ({
                                    ...current,
                                    [row.key]: canonicalValue,
                                  }))
                                }
                              }}
                            />
                            {row.status === 'manual' && (
                              <div className="duration-repair-quick-actions" aria-label="Quick duration values">
                                {[30, 60, 90, 180].map((days) => (
                                  <button
                                    type="button"
                                    key={days}
                                    onClick={() => setDurationRepairValues((current) => ({
                                      ...current,
                                      [row.key]: `${days} days`,
                                    }))}
                                  >{days} days</button>
                                ))}
                              </div>
                            )}
                            <small className={isUnresolved ? 'duration-repair-validation-error' : ''}>
                              {isUnresolved && row.enteredValue
                                ? 'Use a positive whole number followed by day or days.'
                                : row.manualReady
                                  ? 'Valid manual correction.'
                                  : row.reason}
                            </small>
                          </td>
                          <td><span className={`duration-repair-method duration-repair-method--${isUnresolved ? 'manual' : row.status === 'manual' ? 'ready' : row.status}`}>
                            {displayStatus}
                          </span></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {durationRepairVisibleRows.length === 0 && (
                  <div className="duration-repair-empty">
                    {durationRepairFilter === 'manual'
                      ? 'No unresolved durations remain.'
                      : 'No medicine durations match this filter.'}
                  </div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                disabled={durationRepairSaving}
                onClick={() => {
                  setDurationRepairReview(null)
                  setDurationRepairValues({})
                  setDurationRepairFilter('all')
                }}
              >Cancel Export</button>
              <button
                className="btn btn-primary"
                disabled={durationRepairSaving}
                onClick={() => { void handleApplyDurationRepairs() }}
              >
                <CheckCircle2 size={14} /> {durationRepairSaving
                  ? 'Saving corrections...'
                  : durationRepairUnresolvedCount
                    ? `Resolve ${durationRepairUnresolvedCount} Duration${durationRepairUnresolvedCount === 1 ? '' : 's'} to Continue`
                    : 'Apply Corrections & Continue'}
              </button>
            </div>
          </div>
        </div>
      )}

      {rejectTarget && (
        <div className="modal-overlay">
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
