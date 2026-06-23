import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus, Search, X, Upload, Download, CheckCircle2,
  Send, Banknote, XCircle, Eye, FileSpreadsheet, HeartPulse,
  Pencil, Paperclip, FileText, Trash2, Users, Clock,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { isSupabaseConfigured } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import { formatAppDate, formatAppDateTime } from '../utils/date'
import { normalizeText } from '../utils/validation'
import {
  getAllNhisDrugs,
  getNhisDrugByCode,
  createNhisDrug,
  updateNhisDrug,
  deleteNhisDrug,
  upsertNhisDrugs,
  getAllNhisClaims,
  getNhisClaimForSubmission,
  getAllNhiaTariffItems,
  updateNhiaTariffItem,
  getNhisClaimStats,
  createNhisClaim,
  deleteNhisClaim,
  updateNhisClaim,
  updateNhisClaimStatus,
  exportNhisClaimsFile,
  submitNhisClaimDirect,
  assessNhisClaimReadiness,
  validateNhisClaimFinalReadiness,
  getAllNhisClinicalRules,
  upsertNhisClinicalRules,
  normalizeOrganizationType,
  normalizeNhisCcCode,
  normalizeNhisGender,
  uploadNhisPrescriptionPdf,
  validateNhisPrescriptionPdfFile,
  getNhisPrescriptionSignedUrl,
  generateHostedNhiaCcCode,
  getNhiaApiSettings,
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
  canMcaOpenNhisClaimForServing,
  shouldApplyMcaEditWindowToClaim,
  shouldFinalizeNhisServingReview,
  splitMcaReadinessIssues,
} from '../utils/nhisServingWorkflow'
import { getAllPatients, searchPatients } from '../services/patientService'
import { getAllDrugs } from '../services/drugService'
import { parseNhisDrugFile, generateNhisDrugTemplate } from '../services/nhisDrugImportService'
import { parseNhisClinicalRuleFile, generateNhisClinicalRuleTemplate } from '../services/nhisClinicalRuleImportService'
import { isGhanaCardNumber, normalizeNhiaMemberNumber } from '../utils/nhiaMemberNumber'
import {
  applyNhiaFacilityDefaults,
  getNhiaAccreditationExpiryDate,
  hasNhiaFacilitySettings,
} from '../utils/nhiaFacilityDefaults'
import { getErrorMessage, isNetworkRequestError } from '../utils/requestErrors'
import { getNhiaMemberFeedbackMessage } from '../utils/nhiaFeedback'
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

const CLAIM_STATUS_TABS = ['all', 'pending_serving', 'returned_for_review', 'served', 'submitted', 'paid', 'rejected']
const NHIS_CLAIMS_SCREEN_LIMIT = 500
const CLAIM_STATUS_LABELS = {
  all: 'All',
  pending_serving: 'Pending Serving',
  serving_in_progress: 'Serving',
  returned_for_review: 'For Review',
  served: 'Claim Ready',
  submitted: 'Submitted',
  paid: 'Paid',
  rejected: 'Rejected',
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
  '1 week',
  '2 weeks',
  '3 weeks',
  '1 month',
]

const BLANK_CLAIM = {
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
  claimitAttachmentFileName: '',
  claimitAttachmentFileType: '',
  claimitAttachmentMimeType: '',
  claimitAttachmentBase64: '',
  notes:             '',
  unservedMedicinesNote: '',
}

const BLANK_MEDICINE = {
  nhisDrugId:    '',
  drugCode:      '',
  description:   '',
  unit:          'unit',
  unitPrice:     '',
  prescribedQty: '0',
  servedQty:     '0',
  dispensedQty:  '0',
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
}

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

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DMY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

const toValidIsoDate = (year, month, day) => {
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return ''
  }
  return [
    parsed.getUTCFullYear(),
    String(parsed.getUTCMonth() + 1).padStart(2, '0'),
    String(parsed.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

const normalizeDateOfBirthValue = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (ISO_DATE_PATTERN.test(raw)) {
    const [year, month, day] = raw.split('-')
    return toValidIsoDate(year, month, day)
  }
  const dmy = raw.match(DMY_DATE_PATTERN)
  if (dmy) {
    const [, day, month, year] = dmy
    return toValidIsoDate(year, month, day)
  }
  if (raw.includes('/')) return ''
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return ''
  return toValidIsoDate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate())
}

const formatDateOfBirthInputValue = (value) => {
  const raw = String(value || '').trim()
  const iso = normalizeDateOfBirthValue(raw)
  if (!iso) return raw
  const [year, month, day] = iso.split('-')
  return `${day}/${month}/${year}`
}

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
  const explicitGroup =
    getSettingValue(settings, 'tariffFacilityGroup', 'tariff_facility_group') ||
    getSettingValue(settings, 'nhiaTariffFacilityGroup', 'nhia_tariff_facility_group') ||
    organization?.tariff_facility_group ||
    organization?.nhia_tariff_facility_group

  if (explicitGroup) return explicitGroup

  const providerType =
    getSettingValue(settings, 'providerTypeDescription', 'provider_type_description') ||
    organization?.provider_type_description ||
    organization?.providerTypeDescription ||
    ''
  const normalizedProvider = compactLookupText(providerType)

  if (normalizedProvider.includes('privateprimarycarehospital') ||
      (normalizedProvider.includes('private') && normalizedProvider.includes('primary') && normalizedProvider.includes('hospital'))) {
    return 'Private Primary Care Hospital'
  }

  if (normalizedProvider.includes('chag') && normalizedProvider.includes('primary') && normalizedProvider.includes('hospital')) {
    return 'CHAG Primary Care Hospital'
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

const StatusBadge = ({ status }) => (
  <span className={`nhis-badge nhis-badge--${status}`}>{getClaimStatusLabel(status)}</span>
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
    canDeleteNhisClaims,
    canViewReports,
  } = useAuth()
  const { notify } = useNotification()
  const [searchParams, setSearchParams] = useSearchParams()
  const fileInputRef = useRef(null)
  const ruleFileInputRef = useRef(null)

  const normalizedRole = String(role || '').toLowerCase()
  const isMedicineCounterAssistant = normalizedRole === 'assistant'
  const canWrite = !isMedicineCounterAssistant && (
    ['admin', 'super_admin', 'pharmacist', 'billing', 'claims_officer', 'records_officer']
      .includes(normalizedRole) ||
    Boolean(profile?.can_manage_claims)
  )
  const canServeNhisMedicines = canWrite || isMedicineCounterAssistant
  const canEditNhisPatientDetails = canWrite
  const organizationType = normalizeOrganizationType(organization?.organization_type)
  const organizationId = organization?.id || profile?.organization_id || ''
  const isHospital = organizationType === 'hospital'

  // ── page sub-tab ─────────────────────────────────────────────
  const [pageTab, setPageTab] = useState('claims') // 'claims' | 'patients' | 'catalog' | 'gdrg' | 'review' | 'rules'

  // ── data ─────────────────────────────────────────────────────
  const [claims, setClaims]       = useState([])
  const [nhisDrugs, setNhisDrugs] = useState([])
  const [nhiaTariffItems, setNhiaTariffItems] = useState([])
  const [clinicalRules, setClinicalRules] = useState([])
  const [patients, setPatients]   = useState([])
  const [inventoryDrugs, setInventoryDrugs] = useState([])
  const [stats, setStats]         = useState({
    total: 0,
    pending_serving: 0,
    returned_for_review: 0,
    served: 0,
    submitted: 0,
    paid: 0,
    rejected: 0,
    totalPaid: 0,
  })
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [catalogSeeding, setCatalogSeeding] = useState(false)

  // ── claims filter ─────────────────────────────────────────────
  const [claimTab, setClaimTab]         = useState('all')
  const [claimSearch, setClaimSearch]   = useState('')
  const [nhisPatientSearch, setNhisPatientSearch] = useState('')
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
  const [viewClaim, setViewClaim]                   = useState(null)

  // ── new claim form ────────────────────────────────────────────
  const [claimForm, setClaimForm]           = useState(BLANK_CLAIM)
  const [claimMedicines, setClaimMedicines] = useState([])
  const [claimServices, setClaimServices]   = useState([])
  const [claimSubmitting, setClaimSubmitting] = useState(false)
  const [claimError, setClaimError]           = useState('')
  const [editingClaim, setEditingClaim]       = useState(null)
  const [prescriptionPdfFile, setPrescriptionPdfFile] = useState(null)

  // ── patient lookup (for claim form) ──────────────────────────
  const [patientSearch, setPatientSearch] = useState('')
  const [patientSearchResults, setPatientSearchResults] = useState([])
  const [patientSearchError, setPatientSearchError] = useState('')
  const [patientSearching, setPatientSearching] = useState(false)
  const [selectedClaimPatient, setSelectedClaimPatient] = useState(null)

  // ── medicine sub-modal ────────────────────────────────────────
  const [medForm, setMedForm]           = useState(BLANK_MEDICINE)
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

  const canEditNhisClaimAnytime = ['admin', 'claims_officer'].includes(normalizedRole)

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
      const [claimsData, drugsData, patientsData, statsData, rulesData, tariffData, inventoryData] = await Promise.all([
        getAllNhisClaims({ limit: NHIS_CLAIMS_SCREEN_LIMIT, includeDetails: false }),
        getAllNhisDrugs(),
        getAllPatients(),
        getNhisClaimStats(),
        getAllNhisClinicalRules(),
        getAllNhiaTariffItems({
          facilityGroup: activeTariffFacilityGroup,
          cateringOption: activeTariffCateringOption,
        }),
        getAllDrugs({ includeCatalog: true, useTierAccess: true }).catch(() => []),
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

      setClaims(claimsData)
      setNhisDrugs(readyDrugsData)
      setPatients(patientsData)
      setStats(statsData)
      setClinicalRules(rulesData)
      setNhiaTariffItems(tariffData)
      setInventoryDrugs(inventoryData)
    } catch (err) {
      setError(err.message || 'Unable to load NHIS data.')
    } finally {
      setLoading(false)
    }
  }, [canWrite, notify, organization?.can_use_nhis, isHospital, activeTariffFacilityGroup, activeTariffCateringOption])

  const refreshClaimsOverview = useCallback(async () => {
    if (!isSupabaseConfigured()) {
      setError('Supabase is not configured.')
      return
    }
    try {
      setError('')
      const [claimsData, statsData] = await Promise.all([
        getAllNhisClaims({ limit: NHIS_CLAIMS_SCREEN_LIMIT, includeDetails: false }),
        getNhisClaimStats(),
      ])
      setClaims(claimsData)
      setStats(statsData)
    } catch (err) {
      setError(err.message || 'Unable to refresh NHIS claims.')
    }
  }, [])

  const hydrateClaimForAction = useCallback(async (claim) => {
    if (!claim?._summaryOnly) return claim
    const fullClaim = await getNhisClaimForSubmission(claim.id)
    const hydrated = { ...claim, ...fullClaim, _summaryOnly: false }
    setClaims((current) => current.map((row) => (row.id === hydrated.id ? hydrated : row)))
    return hydrated
  }, [])

  useEffect(() => { void loadAll() }, [loadAll])

  useEffect(() => startClaimItBridgeQueueAutoSync({
    onSynced: (result) => {
      void refreshClaimsOverview()
      notify(`${result.submitted} queued CLAIM-it claim${result.submitted === 1 ? '' : 's'} submitted.`, 'success')
    },
  }), [notify, refreshClaimsOverview])

  const refreshDirectNhiaApiStatus = useCallback(async () => {
    try {
      const settings = await getNhiaApiSettings({ organizationId })
      setDirectNhiaSettings(settings || null)
    } catch {
      setDirectNhiaSettings(null)
    }
  }, [organizationId])

  useEffect(() => { void refreshDirectNhiaApiStatus() }, [refreshDirectNhiaApiStatus])

  useEffect(() => {
    let cancelled = false
    getPharmacySettings()
      .then((settings) => {
        if (!cancelled) setFacilitySettings(settings || null)
      })
      .catch(() => {
        if (!cancelled) setFacilitySettings(null)
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
    const term = claimSearch.trim().toLowerCase()
    return claims.filter((c) => {
      if (claimTab !== 'all' && c.status !== claimTab) return false
      if (claimDateFilter === 'open') {
        if (!OPEN_CLAIM_STATUSES.has(c.status)) return false
      } else {
        const serviceDate = getClaimServiceDateKey(c)
        if (claimDateRange.from && (!serviceDate || serviceDate < claimDateRange.from)) return false
        if (claimDateRange.to && (!serviceDate || serviceDate > claimDateRange.to)) return false
      }
      if (!term) return true
      return (
        (c.surname       || '').toLowerCase().includes(term) ||
        (c.other_names   || '').toLowerCase().includes(term) ||
        (c.member_no     || '').toLowerCase().includes(term) ||
        (c.claim_number  || '').toLowerCase().includes(term) ||
        (c.hin           || '').toLowerCase().includes(term)
      )
    })
  }, [claims, claimTab, claimSearch, claimDateFilter, claimDateRange])

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
    const term = claimSearch.trim().toLowerCase()
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
  }, [allNhisPatients, claimSearch])

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
    return nhiaTariffItems
      .filter((item) => {
        if (activeTariffFacilityGroup && item.facility_group !== activeTariffFacilityGroup) return false
        if (activeTariffCateringOption && item.catering_option !== activeTariffCateringOption) return false
        return (
          lookupMatches(item.gdrg_code, term) ||
          lookupMatches(item.description, term) ||
          lookupMatches(item.mdc, term) ||
          lookupMatches(item.facility_group, term)
        )
      })
      .slice(0, 10)
  }, [nhiaTariffItems, tariffSearch, activeTariffFacilityGroup, activeTariffCateringOption])

  const filteredTariffCatalog = useMemo(() => {
    const term = tariffCatalogSearch.trim().toLowerCase()
    const rows = nhiaTariffItems.filter((item) => {
      if (activeTariffFacilityGroup && item.facility_group !== activeTariffFacilityGroup) return false
      if (activeTariffCateringOption && item.catering_option !== activeTariffCateringOption) return false
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
  }, [nhiaTariffItems, tariffCatalogSearch, activeTariffFacilityGroup, activeTariffCateringOption])

  const providerClassLevel = resolvedNhiaSettings?.providerClassLevel || resolvedNhiaSettings?.provider_class_level || ''
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
  const shouldUseOfflineNhiaUrl = shouldUseBranchServer() || isBranchNhiaConfigSource
  const effectiveMemberLookupEndpointPath = memberLookupEndpointPath ||
    (shouldUseOfflineNhiaUrl ? '/api/hmis/genCCC' : '')
  const nhiaCcCodeApiAvailable = Boolean(
    (resolvedNhiaSettings?.directApiEnabled ||
      integrationMode === 'claimit_assisted' ||
      ['claimit_bridge', 'claimit_bridge_ccc', 'direct_api'].includes(claimControlMode)) &&
      (nhiaApiBaseUrl || shouldUseOfflineNhiaUrl) &&
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
      if (!accessLevel && !requiredLevel) warnings.push('Level not configured.')
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
    const alert = buildReturnAlertForPatient(selectedPatient)
    if (alert) openReturnAlert(alert)
  }

  const handlePatientSearchChange = (event) => {
    setSelectedClaimPatient(null)
    setReturnAlertOverride(null)
    setPatientSearch(event.target.value)
  }

  const clearSelectedPatient = () => {
    setSelectedClaimPatient(null)
    setReturnAlertOverride(null)
    setPatientSearch('')
    setPatientSearchResults([])
    setPatientSearchError('')
  }

  // ── medicine code search ──────────────────────────────────────
  const openNewClaimModal = () => {
    resetClaimModal()
    setShowNewClaimModal(true)
  }

  const openNewClaimForPatient = (patient) => {
    resetClaimModal()
    selectPatient(patient)
    setShowNewClaimModal(true)
  }

  const closeClaimModal = () => {
    setShowNewClaimModal(false)
    resetClaimModal()
  }

  const openEditClaim = async (selectedClaim) => {
    const canOpenForMcaServing = isMedicineCounterAssistant && canMcaOpenNhisClaimForServing(selectedClaim.status)
    if (!canOpenForMcaServing && !canEditNhisClaimAnytime && selectedClaim.status !== 'served') {
      notify('Only served NHIS claims can be edited before submission/export.', 'warning')
      return
    }

    let claim = selectedClaim
    setClaimActionLoading({ claimId: selectedClaim.id, action: 'edit' })
    try {
      claim = await hydrateClaimForAction(selectedClaim)
    } catch (err) {
      notify(err.message || 'Unable to load the full NHIS claim details.', 'error')
      return
    } finally {
      setClaimActionLoading(null)
    }

    // MCA medication edits are limited to the 24h window (or a 12h supervisor
    // re-open). The branch server also enforces this; this is early feedback.
    if (isMedicineCounterAssistant && shouldApplyMcaEditWindowToClaim(claim.status) && !isMcaEditWindowOpen(claim)) {
      notify('The 24-hour edit window for this claim has closed. Ask an admin or claims officer to re-open it.', 'warning')
      return
    }

    setEditingClaim(claim)
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
    setMedForm(BLANK_MEDICINE)
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
      claimitAttachmentFileName: claim.claimit_attachment_file_name || '',
      claimitAttachmentFileType: claim.claimit_attachment_file_type || '',
      claimitAttachmentMimeType: claim.claimit_attachment_mime_type || '',
      claimitAttachmentBase64: claim.claimit_attachment_base64 || '',
      notes: claim.notes || '',
      unservedMedicinesNote: claim.unserved_medicines_note || '',
    })
    setPrescriptionPdfFile(null)
    setClaimMedicines(
      compactMedicines(claim.nhis_claim_medicines).map((medicine) => ({
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
  }

  const openViewClaim = async (claim) => {
    setClaimActionLoading({ claimId: claim.id, action: 'view' })
    try {
      setViewClaim(await hydrateClaimForAction(claim))
    } catch (err) {
      notify(err.message || 'Unable to load the full NHIS claim details.', 'error')
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
  const addMedicineToList = () => {
    const qty   = Number.parseFloat(medForm.dispensedQty) || 0
    const price = Number.parseFloat(medForm.unitPrice)    || 0
    const requestedServingStatus = String(medForm.servingStatus || '').toLowerCase()
    const allowsZeroServedQty = isMedicineCounterAssistant && ['not_available', 'not_served'].includes(requestedServingStatus)
    if (!(qty > 0) && !allowsZeroServedQty) {
      notify(isMedicineCounterAssistant ? 'Served quantity is required.' : 'Prescribed quantity is required.', 'warning')
      return
    }
    if (isMedicineCounterAssistant && editingMedicineIndex === null) {
      notify('MCA users can only serve medicines entered by the Claims Officer.', 'warning')
      return
    }
    const currentMedicine = editingMedicineIndex === null ? null : claimMedicines[editingMedicineIndex]
    const prescribedQty = isMedicineCounterAssistant
      ? getMedicinePrescribedQty(currentMedicine)
      : qty
    const servedQty = isMedicineCounterAssistant
      ? qty
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
      duration:      medForm.duration,
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
      const proceed = window.confirm(
        `Duplicate medicine alert:\n\n${duplicateAlerts.slice(0, 5).join('\n')}\n\nContinue adding this medicine?`
      )
      if (!proceed) {
        notify('Medicine was not added. Please verify the repeat dispensing first.', 'warning')
        return
      }
    }

    setClaimMedicines((prev) => {
      if (editingMedicineIndex === null || editingMedicineIndex < 0 || editingMedicineIndex >= prev.length) {
        return [...prev, nextMedicine]
      }

      return prev.map((medicine, index) => index === editingMedicineIndex ? nextMedicine : medicine)
    })
    setMedForm(BLANK_MEDICINE)
    setMedCodeSearch('')
    setEditingMedicineIndex(null)
    setShowMedModal(false)
  }

  const openEditMedicine = (index) => {
    const medicine = claimMedicines[index]
    if (!medicine) return

    setMedForm({
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
    setMedCodeSearch('')
    setMedSearchResults([])
    setEditingMedicineIndex(index)
    setShowMedModal(true)
  }

  const removeMedicine = (index) => {
    setClaimMedicines((prev) => prev.filter((_, i) => i !== index))
  }

  const addTariffServiceToClaim = (item) => {
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
        enforceDiagnosisTreatmentMatch: Boolean(editingClaim && isHospital),
        enforcePrescribingLevel: true,
        requirePrescriptionAttachment: false,
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
  const effectiveReadinessBlocked = isMedicineCounterAssistant
    ? mcaReadiness.medicineBlockers.length > 0
    : readinessBlocked
  const effectiveReadinessPassed = isMedicineCounterAssistant
    ? mcaReadiness.medicineBlockers.length === 0 && mcaReadiness.medicineWarnings.length === 0
    : readinessPassed
  const canSaveCommunityPharmacyClaim = isMedicineCounterAssistant
    ? mcaReadiness.canSaveMedicines
    : readiness.blockers.length === 0

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
      notify('Medicine Counter Assistants cannot generate or change NHIA CC codes.', 'error')
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
      const generateCcCode = shouldUseOfflineNhiaUrl
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
      notify(
        result.source === 'claimit_bridge'
          ? 'CCC/CC code returned by CLAIM-it.'
          : result.source === 'api'
            ? `CCC/CC code generated from NHIA API${memberDetails?.memberName ? ` — ${memberDetails.memberName}` : ''}.`
            : 'CCC/CC code generated for direct NHIA submission.',
        'success'
      )
    } catch (err) {
      notify(
        getNhiaMemberFeedbackMessage(err.message, 'Unable to generate CCC/CC code.'),
        'error'
      )
    } finally {
      setGeneratingCcCode(false)
    }
  }

  const handleSubmitClaim = async (e) => {
    e.preventDefault()
    if (!isMedicineCounterAssistant && readiness.blockers.length) {
      setClaimError(`NHIS claim readiness check failed: ${readiness.blockers.slice(0, 5).join(' ')}`)
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
      const alert = buildReturnAlertForPatient(selectedClaimPatient || claimForm, claimMedicines)
      if (alert && !isReturnAlertOverrideFor(alert)) {
        openReturnAlert(alert)
        setClaimError('Patient return alert requires verification before saving this NHIS visit.')
        return
      }
    }

    const duplicateClaimBlockers = buildNhisDuplicateClaimBlockers({
      currentClaim: claimForm,
      currentMedicines: claimMedicines,
      existingClaims: claims,
      editingClaimId: editingClaim?.id,
    })
    if (duplicateClaimBlockers.length) {
      setClaimError(`Duplicate NHIS claim blocked: ${duplicateClaimBlockers[0]}`)
      return
    }

    const duplicateWarnings = buildNhisDuplicateWarnings({
      currentClaim: claimForm,
      currentMedicines: claimMedicines,
      existingClaims: claims,
      editingClaimId: editingClaim?.id,
    })
    if (duplicateWarnings.length) {
      const proceed = window.confirm(
        `Possible duplicate claim or medicine detected:\n\n${duplicateWarnings.slice(0, 6).join('\n')}\n\nContinue anyway?`
      )
      if (!proceed) {
        setClaimError(`Possible duplicate found: ${duplicateWarnings[0]}`)
        return
      }
    }

    try {
      setClaimSubmitting(true)
      setClaimError('')
      const uploadedPrescription = prescriptionPdfFile
        ? await uploadNhisPrescriptionPdf(prescriptionPdfFile, {
            organizationId: organization?.id,
            claimId: editingClaim?.id,
            yearMonth: (claimForm.serviceDate || todayIsoDate()).slice(0, 7),
          })
        : {}
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
      if (!editingClaim) {
        payload.status = 'pending_serving'
        payload.servingStatus = 'pending'
        payload.allowIncompleteReview = true
      } else if (isMedicineCounterAssistant) {
        payload.status = 'returned_for_review'
        payload.servingStatus = getClaimServingStatus(claimMedicines)
      } else if (shouldFinalizeNhisServingReview(editingClaim.status)) {
        payload.status = 'served'
        payload.servingStatus = getClaimServingStatus(claimMedicines)
        payload.servingReviewedBy = user?.id || null
        payload.servingReviewedAt = new Date().toISOString()
      }
      const payloadHasReadablePrescriptionFile = Boolean(
        payload.prescriptionFilePath ||
        payload.prescription_file_path ||
        payload.prescriptionFileUrl ||
        payload.prescription_file_url ||
        payload.claimitAttachmentBase64 ||
        payload.claimit_attachment_base64
      )

      let successMessage = editingClaim
        ? (isMedicineCounterAssistant ? 'NHIS medicines saved for Claims Officer review.' : 'NHIS claim reviewed and marked ready.')
        : 'NHIS prescription saved and sent to dispensary for serving.'
      let savedClaimRecord = null
      const returnAlertOverrideSnapshot = returnAlertOverride
      if (editingClaim) {
        const savedClaim = await updateNhisClaim(editingClaim.id, payload, claimMedicines, {
          providerClassLevel,
          claimControlMode,
          useBranchServer: isBranchNhiaConfigSource,
          // ✅ NHIS PHARMACY LEVEL PATCH START
          pharmacyLevel: facilityPharmacyLevel,
          // ✅ NHIS PHARMACY LEVEL PATCH END
          nhisDrugCatalog: nhisDrugs,
          nhiaTariffServices: claimServices,
          tariffFacilityGroup: activeTariffFacilityGroup,
          tariffCateringOption: activeTariffCateringOption,
          medicinesOnly: isMedicineCounterAssistant,
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
        savedClaimRecord = await createNhisClaim(createPayload, claimMedicines, {
          providerClassLevel,
          claimControlMode,
          useBranchServer: isBranchNhiaConfigSource,
          // ✅ NHIS PHARMACY LEVEL PATCH START
          pharmacyLevel: facilityPharmacyLevel,
          // ✅ NHIS PHARMACY LEVEL PATCH END
          nhisDrugCatalog: nhisDrugs,
          nhiaTariffServices: claimServices,
          tariffFacilityGroup: activeTariffFacilityGroup,
          tariffCateringOption: activeTariffCateringOption,
        })
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

      setShowNewClaimModal(false)
      resetClaimModal()
      await refreshClaimsOverview()
      notify(successMessage, 'success')
    } catch (err) {
      setClaimError(getNhisRequestErrorMessage(
        err,
        'Unable to save claim.',
        editingClaim && directNhiaApiAvailable ? 'Corrections were not submitted.' : 'The claim was not saved.'
      ))
    } finally {
      setClaimSubmitting(false)
    }
  }

  const resetClaimModal = () => {
    setClaimForm(BLANK_CLAIM)
    setClaimMedicines([])
    setClaimServices([])
    setClaimError('')
    setPatientSearch('')
    setPatientSearchResults([])
    setPatientSearchError('')
    setSelectedClaimPatient(null)
    setMedForm(BLANK_MEDICINE)
    setEditingMedicineIndex(null)
    setTariffSearch('')
    setEditingClaim(null)
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
            requirePrescriptionAttachment: false,
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
    if (!window.confirm(`Permanently delete claim ${claim.claim_number}? This action cannot be undone.`)) {
      return
    }

    try {
      setUpdatingStatus(claim.id)
      await deleteNhisClaim(claim.id, { role, canDeleteNhisClaims })
      if (viewClaim?.id === claim.id) setViewClaim(null)
      if (editingClaim?.id === claim.id) closeClaimModal()
      await refreshClaimsOverview()
      notify(`Claim ${claim.claim_number} deleted.`, 'success')
    } catch (err) {
      notify(err.message || 'Unable to delete claim.', 'error')
    } finally {
      setUpdatingStatus(null)
    }
  }

  // Admin / claims officer re-opens the MCA medication edit window for 12 hours.
  const canReopenMca = canReopenMcaEditWindow(normalizedRole)
  const handleReopenMcaEdit = async (claim) => {
    if (!canReopenMca) {
      notify('Only an admin or claims officer can re-open the MCA edit window.', 'warning')
      return
    }
    const reason = window.prompt(`Re-open the MCA medication edit window for claim ${claim.claim_number} (12 hours)?\nEnter a reason:`)
    if (reason === null) return
    if (!reason.trim()) {
      notify('A reason is required to re-open the MCA edit window.', 'warning')
      return
    }
    try {
      setUpdatingStatus(claim.id)
      await reopenBranchMcaEditWindow(claim.id, reason.trim())
      await refreshClaimsOverview()
      notify(`MCA edit window re-opened for ${claim.claim_number} (12 hours).`, 'success')
    } catch (err) {
      notify(err.message || 'Unable to re-open the MCA edit window.', 'error')
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
  const handleExport = async () => {
    try {
      setExporting(true)
      const periodOptions = exportMode === 'custom'
        ? { mode: 'custom', fromDate: exportFromDate, toDate: exportToDate }
        : exportMode === 'partial'
          ? { mode: 'partial', toDate: exportToDate }
          : { mode: 'month', yearMonth: exportMonth }
      const periodLabel = exportMode === 'custom'
        ? `${exportFromDate} to ${exportToDate}`
        : exportMode === 'partial'
          ? `${exportToDate.slice(0, 7)}-01 to ${exportToDate}`
          : exportMonth
      const submitDirectApi = directNhiaApiAvailable && exportRoute === 'direct_api'
      const selectedFormat = submitDirectApi ? 'json' : exportFormat
      const exportResult = await exportNhisClaimsFile({
        ...periodOptions,
        ...getDirectNhiaOptions(),
        directSubmit: submitDirectApi,
        format: selectedFormat,
        directPayloadFormat: submitDirectApi ? 'json' : selectedFormat,
      })
      const count = typeof exportResult === 'number' ? exportResult : exportResult?.count || 0
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
      notify(getNhisRequestErrorMessage(err, 'Export failed.', 'Claims were not submitted/exported.'), 'error')
    } finally {
      setExporting(false)
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
              {CLAIM_STATUS_TABS.map((tab) => (
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
                onChange={(event) => setClaimDateFilter(event.target.value)}
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
                    onChange={(event) => setClaimFromDate(event.target.value)}
                    aria-label="Claims from date"
                  />
                  <input
                    type="date"
                    value={claimToDate}
                    onChange={(event) => setClaimToDate(event.target.value)}
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
                onChange={(e) => setClaimSearch(e.target.value)}
              />
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

          {/* Claims table */}
          <div className="nhis-table-wrap">
            {loading ? (
              <div className="nhis-empty">Loading claims...</div>
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
                      <td>
                        {formatNhisServiceDateTime(c)}
                        {OPEN_CLAIM_STATUSES.has(c.status) && getClaimServiceDateKey(c) < monthStartIsoDate() && (
                          <span className="nhis-carry-badge">
                            Carried over from {formatClaimMonthLabel(getClaimServiceDateKey(c))}
                            {Number.isFinite(getClaimAgeDays(getClaimServiceDateKey(c))) ? ` · ${getClaimAgeDays(getClaimServiceDateKey(c))}d` : ''}
                          </span>
                        )}
                      </td>
                      <td>{c.nhis_claim_medicines?.length || 0}</td>
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
                      <td><StatusBadge status={c.status} /></td>
                      <td className="nhis-actions">
                        <button
                          className="action-btn action-btn--view"
                          title="View"
                          disabled={isClaimBusy(c.id)}
                          onClick={() => { void openViewClaim(c) }}
                        >
                          {isClaimActionBusy(c.id, 'view') ? <Clock size={14} /> : <Eye size={14} />}
                        </button>
                        {canServeNhisMedicines && (
                          isMedicineCounterAssistant
                            ? canMcaOpenNhisClaimForServing(c.status)
                            : (['pending_serving', 'returned_for_review', 'served'].includes(c.status) || canEditNhisClaimAnytime)
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
                        {canReopenMca && c.status === 'served' && !isMcaEditWindowOpen(c) && (
                          <button
                            className="action-btn action-btn--edit"
                            title="Re-open MCA edit window (12 hours)"
                            disabled={isClaimBusy(c.id)}
                            onClick={() => handleReopenMcaEdit(c)}
                          >
                            <Clock size={14} />
                          </button>
                        )}
                        {c.status === 'served' && canWrite && (
                          <button
                            className="action-btn action-btn--submit"
                            title={directNhiaApiAvailable ? 'Submit directly to NHIA' : 'Mark as Submitted'}
                            disabled={isClaimBusy(c.id)}
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
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {!loading && filteredClaims.length > 0 && visibleNhisPatients.length > 0 && (
            <div className="nhis-patient-list-section">
              <div className="nhis-patient-fallback__header">
                <strong>Known NHIS patients</strong>
                <span>{visibleNhisPatients.length} shown</span>
              </div>
              <div className="nhis-patient-fallback">
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
              <h3>Claim readiness</h3>
              <span>{claims.length} claims reviewed</span>
            </div>
            <div className="nhis-table-wrap">
              {configReview.claimRows.filter((row) => row.blockers.length || row.warnings.length).length === 0 ? (
                <div className="nhis-review-ok">No claim readiness issues found.</div>
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
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && closeClaimModal()}>
          <div className="modal-panel modal-panel--nhis-claim">
            <div className="modal-header">
              <h2>{editingClaim ? `Edit NHIS Claim ${editingClaim.claim_number}` : 'Add New NHIS Claim'}</h2>
              <button className="modal-close" onClick={closeClaimModal}><X size={18} /></button>
            </div>

            {claimError && <div className="nhis-alert nhis-alert--modal" role="alert">{claimError}</div>}

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

                {/* Referral */}
                <section className="nhis-section">
                  <h3 className="nhis-section-title">Prescription Source</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Prescribing Facility *</label>
                      <input className="form-input" value={claimForm.referringFacility}
                        required
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
                  <h3 className="nhis-section-title">Prescription Authorization</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Prescriber Name / ID *</label>
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
                        setEditingMedicineIndex(null)
                        setMedForm(BLANK_MEDICINE)
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
                            {` | Access: ${m.medicineAccessLevel || 'Level not configured'}`}
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
                          <p>These do not stop MCA medicine saving. Claims officer/admin must complete them before correction, export, or submission.</p>
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
                          <span className="nhia-readiness-label">Blockers ({readiness.blockers.length})</span>
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
                </div>
              </div>
            </div>

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
              <button className="btn btn-secondary" onClick={closeClaimModal}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={claimSubmitting || !canSaveCommunityPharmacyClaim}
                onClick={handleSubmitClaim}
              >
                {claimSubmitting
                  ? (editingClaim && canWrite && directNhiaApiAvailable ? 'Submitting...' : 'Saving...')
                  : editingClaim
                    ? (isMedicineCounterAssistant
                        ? 'Complete Serving'
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
      {showMedModal && (
        <div
          className="modal-overlay modal-overlay--top"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowMedModal(false)
              setEditingMedicineIndex(null)
            }
          }}
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
                onClick={() => {
                  setShowMedModal(false)
                  setEditingMedicineIndex(null)
                }}
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
                  onChange={(e) => setMedForm((p) => ({ ...p, dispensaryDate: e.target.value }))}
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
                  <input
                    list="nhis-frequency-options"
                    className="form-input"
                    value={medForm.frequency}
                    disabled={isMedicineCounterAssistant}
                    onChange={(e) => setMedForm((p) => ({ ...p, frequency: e.target.value }))}
                    placeholder="Select or type frequency"
                  />
                  <datalist id="nhis-frequency-options">
                    {FREQUENCY_OPTIONS.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </datalist>
                </div>
                <div className="form-group">
                  <label>Duration</label>
                  <input
                    list="nhis-duration-options"
                    className="form-input"
                    value={medForm.duration}
                    disabled={isMedicineCounterAssistant}
                    onChange={(e) => setMedForm((p) => ({ ...p, duration: e.target.value }))}
                    placeholder="Select or type duration"
                  />
                  <datalist id="nhis-duration-options">
                    {DURATION_OPTIONS.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </datalist>
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
                  setMedForm(BLANK_MEDICINE)
                  setMedCodeSearch('')
                  setMedSearchResults([])
                  setEditingMedicineIndex(null)
                }}
              >
                Clear
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
        <div className="modal-overlay modal-overlay--top" onClick={(e) => e.target === e.currentTarget && closeReturnAlert()}>
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
              {isHospital && <div><strong>Address:</strong> {viewClaim.patient_address || '—'}</div>}
              {isHospital && <div><strong>Child Weight:</strong> {viewClaim.child_weight_kg ? `${viewClaim.child_weight_kg} kg` : '—'}</div>}
              <div><strong>CCC / CC Code:</strong> {viewClaim.ccc_no || '—'}</div>
              {isHospital && <div><strong>Diagnoses:</strong> {viewClaim.diagnosis || '—'}</div>}
              <div><strong>Date/time of Service:</strong> {formatNhisServiceDateTime(viewClaim)}</div>
              <div><strong>Prescribing Facility:</strong> {viewClaim.referring_facility || '—'}</div>
              <div><strong>Referral Code:</strong> {viewClaim.referral_code || '—'}</div>
              <div><strong>Prescriber:</strong> {viewClaim.physician_name || '—'}</div>
              <div><strong>Pre-auth Codes:</strong> {viewClaim.pre_auth_codes || '—'}</div>
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
                {(viewClaim.nhis_claim_services || []).map((service) => (
                  <tr key={service.id}>
                    <td className="drug-code-cell">{service.gdrg_code || '—'}</td>
                    <td>{service.description}</td>
                    <td>{service.quantity}</td>
                    <td>service</td>
                    <td>{fmtCurrency(service.unit_price)}</td>
                    <td>{fmtCurrency(service.total_amount)}</td>
                    <td colSpan={3}>
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
      {editingTariff && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && closeTariffModal()}>
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
      {showRuleImportModal && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowRuleImportModal(false)}>
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

      {showExportModal && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowExportModal(false)}>
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
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowExportModal(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={exporting || !exportPeriodReady} onClick={handleExport}>
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
