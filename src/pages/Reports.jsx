import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  Calendar,
  Download,
  FileSpreadsheet,
  FileText,
  Printer,
  RefreshCcw,
  Search,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useTenant } from '../context/TenantContext'
import { getPharmacyBrandingSettings } from '../services/settingsService'
import {
  REPORT_TABS,
  buildReportHeaderRows,
  canAccessReport,
  downloadCsv,
  exportReportPdf,
  getReportBundle,
  getReportDrugMatches,
  getReportNhisPage,
  getVisibleReportCatalog,
  normalizeReportBundle,
  printReport,
} from '../services/reportsService'
import { formatAppDateTime } from '../utils/date'
import {
  PLATFORM_GENERATED_BY,
  getFacilityLogo,
  getFacilityName,
  getReportFooter,
} from '../utils/facilityBranding'
import { logPerformance } from '../utils/performance'
import UpgradeGate from '../components/UpgradeGate'
import './Reports.css'

const today = new Date().toISOString().split('T')[0]
const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  .toISOString()
  .split('T')[0]

const FILTER_DEFAULTS = {
  startDate: firstOfMonth,
  endDate: today,
  branch: '',
  facility: '',
  department: '',
  staff: '',
  paymentType: '',
  insuranceProvider: '',
  nhisStatus: '',
  claimStatus: '',
  drugCategory: '',
  drug: '',
  patientType: '',
  prescriber: '',
  facilityBranch: '',
  nhisClaimLimit: 200,
}

const money = (value) => `GHS ${Number(value || 0).toFixed(2)}`
const text = (value, fallback = '-') => value || fallback
const rowsOf = (value) => (Array.isArray(value) ? value : [])
const getStatus = (row = {}) => row.status || row.claim_status || row.claimStatus || ''
const getClaimNumber = (row = {}) => row.claim_number || row.claimNumber || row.localSaleNumber || row.id
const getPatientName = (row = {}) =>
  row.patient_name ||
  row.patientName ||
  row.patients?.full_name ||
  [row.surname, row.other_names || row.otherNames].filter(Boolean).join(' ').trim() ||
  'Walk-in Customer'
const getServiceDate = (row = {}) =>
  row.service_date || row.serviceDate || row.service_date_from || row.serviceDateFrom || row.created_at || row.createdAt
const getBranchId = (row = {}) => row.branch_id || row.branchId || row.branch?.name || 'Main'
const getUserId = (row = {}) => row.created_by || row.createdBy || row.sold_by || row.soldBy || row.userId || row.user_id || ''
const numberValue = (value) => {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}
const getClaimAmount = (claim = {}) => numberValue(claim.total_amount ?? claim.totalAmount ?? claim.amount)
const getSaleAmount = (sale = {}) => numberValue(sale.net_amount ?? sale.netAmount ?? sale.total_amount ?? sale.totalAmount)
const getPurchaseAmount = (purchase = {}) => numberValue(purchase.total_amount ?? purchase.totalAmount ?? purchase.amount)
const normalizeStatus = (value) => String(value || 'unspecified').toLowerCase()
const compact = (values) => values.filter((value) => value !== undefined && value !== null && value !== '').join(' | ')
const uniqueCount = (values) => new Set(values.filter(Boolean).map((value) => String(value))).size
const normalizeIdentifier = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '')
const getNhisPatientReturnKey = (claim = {}) =>
  normalizeIdentifier(claim.hin) ||
  normalizeIdentifier(claim.member_no || claim.memberNo || claim.nhis_member_no || claim.nhisMemberNo) ||
  normalizeIdentifier(claim.patients?.phone || claim.phone || claim.patient_phone)
const getMedicineCode = (line = {}) => normalizeIdentifier(line.drug_code || line.drugCode || line.nhia_code || line.nhiaCode)
const getMedicineKey = (line = {}) => getMedicineCode(line) || String(getDrugName(line)).trim().toLowerCase()
const getMedicineQuantity = (line = {}) => numberValue(line.dispensed_qty ?? line.dispensedQty ?? line.quantity)

const buildBreakdownRows = (label, rows, getKey, getAmount) =>
  Object.values(
    rows.reduce((summary, row) => {
      const key = text(getKey(row), 'Unspecified')
      if (!summary[key]) summary[key] = { key, count: 0, amount: 0 }
      summary[key].count += 1
      summary[key].amount += getAmount ? numberValue(getAmount(row)) : 0
      return summary
    }, {})
  )
    .sort((left, right) => String(left.key).localeCompare(String(right.key)))
    .map((entry) => [`${label}: ${entry.key}`, entry.count, money(entry.amount)])

const getClaimError = (claim = {}) =>
  claim.error_message ||
  claim.errorMessage ||
  claim.rejection_reason ||
  claim.rejectionReason ||
  claim.response?.message ||
  claim.response?.error ||
  ''

const getSaleItems = (sales) =>
  rowsOf(sales).flatMap((sale) =>
    rowsOf(sale.sale_items || sale.items).map((item) => ({
      id: item.id || `${sale.id}-${item.drug_id || item.drugId || item.drug_name || item.drugName}`,
      saleNumber: sale.sale_number || sale.saleNumber,
      date: sale.sale_date || sale.saleDate,
      patient: sale.patients?.full_name || sale.patientName || 'Walk-in Customer',
      payment: sale.payment_method || sale.paymentMethod,
      item: item.drug_name || item.drugName || item.name || item.drugs?.name || 'Item',
      quantity: item.quantity,
      unitPrice: item.unit_price ?? item.unitPrice,
      totalPrice: item.total_price ?? item.totalPrice,
      cashier: sale.sold_by || sale.soldBy,
      branch: getBranchId(sale),
    }))
  )

const getNhisMedicineLines = (claims) =>
  rowsOf(claims).flatMap((claim) =>
    rowsOf(claim.nhis_claim_medicines || claim.items).map((item) => ({
      id: item.id || `${claim.id}-${getDrugName(item)}`,
      claimNumber: getClaimNumber(claim),
      patient: getPatientName(claim),
      serviceDate: getServiceDate(claim),
      status: getStatus(claim),
      item: getDrugName(item),
      code: item.nhia_code || item.nhiaCode || item.drug_code || item.drugCode || item.code || '',
      category: item.category || item.drug_category || item.drugCategory || '',
      prescribed: item.prescribed_quantity || item.prescribedQuantity || item.dispensed_qty || item.dispensedQty || item.quantity,
      dispensed: item.dispensed_quantity || item.dispensedQuantity || item.dispensed_qty || item.dispensedQty || item.quantity,
      quantity: item.dispensed_qty || item.dispensedQty || item.quantity,
      unitPrice: item.unit_price ?? item.unitPrice,
      totalPrice: item.total_price ?? item.totalPrice ?? item.total_amount ?? item.totalAmount,
      branch: getBranchId(claim),
      officer: getUserId(claim),
    }))
  )

const getNhisPatientReturnRows = (claims) => {
  const groups = new Map()
  rowsOf(claims).forEach((claim) => {
    const key = getNhisPatientReturnKey(claim)
    const visitDate = new Date(getServiceDate(claim) || '')
    if (!key || Number.isNaN(visitDate.getTime())) return
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ claim, visitDate })
  })

  const rows = []
  groups.forEach((visits) => {
    visits.sort((left, right) => left.visitDate - right.visitDate)
    for (let index = 1; index < visits.length; index += 1) {
      const previous = visits[index - 1]
      const current = visits[index]
      const diffMs = current.visitDate.getTime() - previous.visitDate.getTime()
      if (diffMs < 0 || diffMs > 24 * 60 * 60 * 1000) continue
      const previousMedicines = rowsOf(previous.claim.nhis_claim_medicines || previous.claim.items)
      const currentMedicines = rowsOf(current.claim.nhis_claim_medicines || current.claim.items)
      const previousKeys = new Set(previousMedicines.map(getMedicineKey).filter(Boolean))
      const repeated = currentMedicines.filter((line) => previousKeys.has(getMedicineKey(line)))
      rows.push({
        patient: getPatientName(current.claim),
        memberNo: current.claim.member_no || current.claim.memberNo || current.claim.nhis_member_no || '',
        hin: current.claim.hin || '',
        previousVisit: previous.visitDate.toISOString(),
        currentVisit: current.visitDate.toISOString(),
        timeDifferenceHours: Math.round((diffMs / (60 * 60 * 1000)) * 10) / 10,
        previousClaim: getClaimNumber(previous.claim),
        currentClaim: getClaimNumber(current.claim),
        sameMedicationRepeated: repeated.length > 0,
        repeatedMedicines: repeated.map(getDrugName).join(', '),
        previousMedicines: previousMedicines.map((line) => `${getDrugName(line)} x ${getMedicineQuantity(line)}`).join('; '),
        currentMedicines: currentMedicines.map((line) => `${getDrugName(line)} x ${getMedicineQuantity(line)}`).join('; '),
        overrideReason: current.claim.nhis_return_override_reason || current.claim.returnOverrideReason || '',
        previousStaff: getUserId(previous.claim),
        currentStaff: getUserId(current.claim),
        branch: getBranchId(current.claim),
        status: getStatus(current.claim),
      })
    }
  })
  return rows.sort((left, right) => new Date(right.currentVisit) - new Date(left.currentVisit))
}

const getGdrgServiceLines = (claims) =>
  rowsOf(claims).flatMap((claim) =>
    rowsOf(claim.nhis_claim_services || claim.services || claim.payload?.services).map((service) => ({
      id: service.id || `${claim.id}-${service.gdrg_code || service.gdrgCode || service.description}`,
      claimNumber: getClaimNumber(claim),
      patient: getPatientName(claim),
      serviceDate: service.service_date || service.serviceDate || getServiceDate(claim),
      status: getStatus(claim),
      code: service.gdrg_code || service.gdrgCode || service.code || '',
      category: service.category || service.service_category || service.serviceCategory || '',
      description: service.description || service.name || 'Service',
      quantity: service.quantity || 1,
      totalAmount: service.total_amount ?? service.totalAmount ?? service.unit_price ?? service.unitPrice,
      branch: getBranchId(claim),
      officer: getUserId(claim),
    }))
  )

const normalizeKey = (value) => String(value || '').trim().toLowerCase()
const normalizeDrugKey = (name, id = '') => normalizeKey(id || name)
const getDrugName = (item = {}) =>
  item.drug_name || item.drugName || item.description || item.name || item.drugs?.name || 'Medicine'
const getDrugId = (item = {}) =>
  item.drug_id || item.drugId || item.nhis_drug_id || item.nhisDrugId || item.drugs?.id || ''
const getPatientId = (row = {}) =>
  row.patient_id || row.patientId || row.patients?.id || row.member_number || row.memberNumber || row.insurance_id || row.insuranceId || ''
const getPatientType = (row = {}) => {
  const provider = normalizeKey(row.insurance_provider || row.insuranceProvider || row.patients?.insurance_provider)
  const payment = normalizeKey(row.payment_method || row.paymentMethod)
  if (provider.includes('nhis') || provider.includes('nhia') || payment === 'nhia') return 'NHIS'
  if (provider || payment === 'insurance') return 'Corporate'
  return 'Cash'
}
const getFolderNo = (row = {}) =>
  row.folder_no || row.folderNo || row.folder_number || row.folderNumber || row.patients?.folder_no || row.patient?.folderNo || ''
const getDepartment = (row = {}) =>
  row.department || row.department_name || row.departmentName || row.module || row.service_department || row.serviceDepartment || ''
const getPrescriber = (row = {}) =>
  row.prescriber || row.prescriber_name || row.prescriberName || row.physician_name || row.physicianName || row.doctor_name || row.doctorName || ''
const getDiagnosis = (row = {}) => {
  const details = rowsOf(row.diagnosis_details || row.diagnosisDetails)
    .map((diagnosis) => diagnosis.label || diagnosis.name || diagnosis.diagnosis || diagnosis.code)
    .filter(Boolean)
  return row.diagnosis || details.join('; ') || ''
}
const getLineQuantity = (item = {}) =>
  numberValue(
    item.dispensed_quantity ??
    item.dispensedQuantity ??
    item.dispensed_qty ??
    item.dispensedQty ??
    item.quantity ??
    item.prescribed_quantity ??
    item.prescribedQuantity
  )
const getLineUnit = (item = {}, drug = {}) =>
  item.unit || item.nhis_unit || item.nhisUnit || item.drugs?.unit || drug.unit || 'unit'
const getLineUnitPrice = (item = {}) =>
  numberValue(item.unit_price ?? item.unitPrice ?? item.price ?? item.nhis_price ?? item.nhisPrice)
const getLineTotal = (item = {}) => {
  const explicit = item.total_price ?? item.totalPrice ?? item.total_amount ?? item.totalAmount
  if (explicit !== undefined && explicit !== null && explicit !== '') return numberValue(explicit)
  return getLineQuantity(item) * getLineUnitPrice(item)
}
const dateLabel = (value) => value ? formatAppDateTime(value) : ''
const getQuarterKey = (dateValue) => {
  const date = new Date(dateValue)
  if (Number.isNaN(date.getTime())) return 'Unspecified'
  return `${date.getFullYear()} Q${Math.floor(date.getMonth() / 3) + 1}`
}

const getDispensingLines = (bundle) => {
  const drugsById = new Map(rowsOf(bundle.drugs).map((drug) => [String(drug.id), drug]))

  const saleLines = rowsOf(bundle.sales).flatMap((sale) =>
    rowsOf(sale.sale_items || sale.items).map((item) => {
      const drug = drugsById.get(String(getDrugId(item))) || {}
      const quantity = getLineQuantity(item)
      const total = getLineTotal(item)
      return {
        id: item.id || `${sale.id}-${getDrugId(item) || getDrugName(item)}`,
        source: 'POS',
        recordNo: sale.sale_number || sale.saleNumber,
        recordId: sale.id,
        drugId: getDrugId(item),
        drug: getDrugName(item),
        nhiaCode: item.nhis_code || item.nhia_code || item.nhiaCode || drug.nhis_code || drug.nhia_code || '',
        patientId: getPatientId(sale),
        patient: getPatientName(sale),
        folderNo: getFolderNo(sale),
        patientType: getPatientType(sale),
        quantity,
        unit: getLineUnit(item, drug),
        unitPrice: getLineUnitPrice(item),
        revenue: total,
        nhisValue: getPatientType(sale) === 'NHIS' ? total : 0,
        date: sale.sale_date || sale.saleDate || sale.created_at || sale.createdAt,
        branch: getBranchId(sale),
        prescriber: getPrescriber(sale),
        department: getDepartment(sale),
        diagnosis: getDiagnosis(sale),
      }
    })
  )

  const nhisLines = rowsOf(bundle.nhisClaims).flatMap((claim) =>
    rowsOf(claim.nhis_claim_medicines || claim.items).map((item) => {
      const drug = drugsById.get(String(getDrugId(item))) || {}
      const quantity = getLineQuantity(item)
      const total = getLineTotal(item)
      return {
        id: item.id || `${claim.id}-${getDrugId(item) || getDrugName(item)}`,
        source: 'NHIS',
        recordNo: getClaimNumber(claim),
        recordId: claim.id,
        drugId: getDrugId(item),
        drug: getDrugName(item),
        nhiaCode: item.nhia_code || item.nhiaCode || item.drug_code || item.drugCode || item.code || drug.nhis_code || '',
        patientId: getPatientId(claim),
        patient: getPatientName(claim),
        folderNo: getFolderNo(claim),
        patientType: 'NHIS',
        quantity,
        unit: getLineUnit(item, drug),
        unitPrice: getLineUnitPrice(item),
        revenue: total,
        nhisValue: total,
        date: getServiceDate(claim),
        branch: getBranchId(claim),
        prescriber: getPrescriber(claim),
        department: getDepartment(claim),
        diagnosis: getDiagnosis(claim),
      }
    })
  )

  return [...saleLines, ...nhisLines]
}

const matchesFilterText = (value, expected) =>
  !expected || normalizeKey(value).includes(normalizeKey(expected))

const filterDispensingLines = (lines, filters = {}) =>
  rowsOf(lines).filter((line) => (
    matchesFilterText(line.drug, filters.drug || filters.drugCategory) &&
    matchesFilterText(line.patientType, filters.patientType) &&
    matchesFilterText(line.department, filters.department) &&
    matchesFilterText(line.prescriber, filters.prescriber || filters.staff) &&
    matchesFilterText(line.branch, filters.facilityBranch || filters.branch)
  ))

const summarizeDrugUtilization = (lines) =>
  Object.values(
    rowsOf(lines).reduce((summary, line) => {
      const key = normalizeDrugKey(line.drug, line.drugId)
      if (!summary[key]) {
        summary[key] = {
          drug: line.drug,
          patients: new Set(),
          quantity: 0,
          prescriptions: new Set(),
          revenue: 0,
          nhisValue: 0,
          unit: line.unit,
          lastDate: '',
          prescribers: {},
        }
      }
      const patientKey = line.patientId || line.patient
      if (patientKey) summary[key].patients.add(String(patientKey))
      if (line.recordNo || line.recordId) summary[key].prescriptions.add(String(line.recordNo || line.recordId))
      summary[key].quantity += numberValue(line.quantity)
      summary[key].revenue += numberValue(line.revenue)
      summary[key].nhisValue += numberValue(line.nhisValue)
      if (line.unit && summary[key].unit === 'unit') summary[key].unit = line.unit
      if (String(line.date || '') > String(summary[key].lastDate || '')) summary[key].lastDate = line.date
      if (line.prescriber) summary[key].prescribers[line.prescriber] = (summary[key].prescribers[line.prescriber] || 0) + 1
      return summary
    }, {})
  )
    .map((entry) => ({
      ...entry,
      patientsServed: entry.patients.size,
      prescriptionsCount: entry.prescriptions.size,
      topPrescribers: Object.entries(entry.prescribers)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([name, count]) => `${name} (${count})`)
        .join(', '),
    }))
    .sort((left, right) => right.quantity - left.quantity || right.patientsServed - left.patientsServed)

const getDrugMovementRows = (bundle, lines) => {
  const dispensedByDrug = summarizeDrugUtilization(lines).reduce((map, item) => {
    map[normalizeDrugKey(item.drug)] = item
    return map
  }, {})
  const purchaseItems = rowsOf(bundle.purchases).flatMap((purchase) => rowsOf(purchase.purchase_items || purchase.items))
  const purchasesByDrug = purchaseItems.reduce((map, item) => {
    const key = normalizeDrugKey(getDrugName(item), getDrugId(item))
    map[key] = (map[key] || 0) + getLineQuantity(item)
    return map
  }, {})

  return rowsOf(bundle.drugs)
    .map((drug) => {
      const key = normalizeDrugKey(drug.name, drug.id)
      const byNameKey = normalizeDrugKey(drug.name)
      const dispensed = dispensedByDrug[key]?.quantity || dispensedByDrug[byNameKey]?.quantity || 0
      const purchased = purchasesByDrug[key] || purchasesByDrug[byNameKey] || 0
      const balance = numberValue(drug.quantity)
      const expired = drug.expiry_date && new Date(drug.expiry_date).getTime() < Date.now() ? balance : 0
      const opening = balance + dispensed - purchased
      return [drug.name, numberValue(opening), purchased, dispensed, 0, expired, balance, drug.unit || 'unit', getBranchId(drug)]
    })
    .filter((row) => row[2] || row[3] || row[6])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
}

const getTrendRows = (lines) => {
  const periods = rowsOf(lines).reduce((summary, line) => {
    const date = new Date(line.date)
    const month = Number.isNaN(date.getTime()) ? 'Unspecified' : line.date.slice(0, 7)
    const year = Number.isNaN(date.getTime()) ? 'Unspecified' : String(date.getFullYear())
    const periodKey = `${month}|${getQuarterKey(line.date)}|${year}|${line.drug}`
    if (!summary[periodKey]) {
      summary[periodKey] = { month, quarter: getQuarterKey(line.date), year, drug: line.drug, patients: new Set(), quantity: 0, revenue: 0, nhisValue: 0 }
    }
    if (line.patientId || line.patient) summary[periodKey].patients.add(String(line.patientId || line.patient))
    summary[periodKey].quantity += numberValue(line.quantity)
    summary[periodKey].revenue += numberValue(line.revenue)
    summary[periodKey].nhisValue += numberValue(line.nhisValue)
    return summary
  }, {})

  return Object.values(periods)
    .sort((left, right) => String(right.month).localeCompare(String(left.month)) || right.quantity - left.quantity)
    .map((entry) => [entry.month, entry.quarter, entry.year, entry.drug, entry.patients.size, entry.quantity, money(entry.revenue), money(entry.nhisValue)])
}

const includesTerm = (row, term) =>
  !term ||
  Object.values(row).some((value) =>
    String(value || '').toLowerCase().includes(String(term || '').toLowerCase())
  )

const getReportRows = (reportId, bundle, filters = {}) => {
  const nhisClaims = rowsOf(bundle.nhisClaims)
  const generalClaims = rowsOf(bundle.claims)
  const dispensingLines = filterDispensingLines(getDispensingLines(bundle), filters)
  const drugSummary = summarizeDrugUtilization(dispensingLines)
  const nhisDrugLines = dispensingLines.filter((line) => line.patientType === 'NHIS' || line.source === 'NHIS')

  const claimRows = (claims) =>
    rowsOf(claims).map((claim) => [
      getClaimNumber(claim),
      getPatientName(claim),
      claim.member_number || claim.memberNumber || claim.nhis_member_no || claim.nhisMemberNo || '',
      claim.insurance_provider || claim.insuranceProvider || 'NHIS',
      getStatus(claim),
      money(getClaimAmount(claim)),
      text(getServiceDate(claim)),
      text(claim.submitted_at || claim.submittedAt || claim.updated_at || claim.updatedAt),
      text(getBranchId(claim)),
      text(getUserId(claim)),
      text(getClaimError(claim)),
    ])

  const definitions = {
    'drug-utilization': {
      headers: ['Drug', 'Patients Served', 'Quantity Dispensed', 'Unit', 'Prescriptions', 'Revenue', 'NHIS Value', 'Last Dispensed', 'Top Prescribers'],
      rows: drugSummary.map((drug) => [
        drug.drug,
        drug.patientsServed,
        drug.quantity,
        drug.unit || 'unit',
        drug.prescriptionsCount,
        money(drug.revenue),
        money(drug.nhisValue),
        dateLabel(drug.lastDate),
        drug.topPrescribers || '',
      ]),
    },
    'drug-patient-drilldown': {
      headers: ['Date', 'Patient', 'Folder No.', 'Patient Type', 'Drug', 'Quantity', 'Unit', 'Prescriber', 'Department', 'Branch', 'Source', 'Record No.'],
      rows: dispensingLines
        .sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')))
        .map((line) => [
          dateLabel(line.date),
          line.patient,
          line.folderNo,
          line.patientType,
          line.drug,
          line.quantity,
          line.unit,
          line.prescriber,
          line.department,
          line.branch,
          line.source,
          line.recordNo,
        ]),
    },
    'top-dispensed-drugs': {
      headers: ['Rank', 'Drug', 'Patients', 'Quantity Dispensed', 'Unit', 'Revenue', 'NHIS Value', 'Prescriptions'],
      rows: drugSummary.slice(0, 10).map((drug, index) => [
        index + 1,
        drug.drug,
        drug.patientsServed,
        drug.quantity,
        drug.unit || 'unit',
        money(drug.revenue),
        money(drug.nhisValue),
        drug.prescriptionsCount,
      ]),
    },
    'disease-drug-analysis': {
      headers: ['Diagnosis', 'Drug', 'Patients', 'Quantity', 'Unit', 'NHIS Value', 'Prescriptions'],
      rows: Object.values(
        nhisDrugLines.reduce((summary, line) => {
          const diagnosis = line.diagnosis || 'Unspecified'
          const key = `${normalizeKey(diagnosis)}|${normalizeDrugKey(line.drug, line.drugId)}`
          if (!summary[key]) summary[key] = { diagnosis, drug: line.drug, patients: new Set(), quantity: 0, unit: line.unit, value: 0, prescriptions: new Set() }
          if (line.patientId || line.patient) summary[key].patients.add(String(line.patientId || line.patient))
          if (line.recordNo || line.recordId) summary[key].prescriptions.add(String(line.recordNo || line.recordId))
          summary[key].quantity += numberValue(line.quantity)
          summary[key].value += numberValue(line.nhisValue)
          return summary
        }, {})
      )
        .sort((left, right) => right.quantity - left.quantity)
        .map((entry) => [entry.diagnosis, entry.drug, entry.patients.size, entry.quantity, entry.unit || 'unit', money(entry.value), entry.prescriptions.size]),
    },
    'nhis-drug-consumption': {
      headers: ['Drug', 'Quantity Served', 'Unit', 'Patients Served', 'NHIS Claims Value', 'Claims/Prescriptions'],
      rows: summarizeDrugUtilization(nhisDrugLines).map((drug) => [
        drug.drug,
        drug.quantity,
        drug.unit || 'unit',
        drug.patientsServed,
        money(drug.nhisValue),
        drug.prescriptionsCount,
      ]),
    },
    'drug-movement': {
      headers: ['Drug', 'Opening Stock Estimate', 'Purchased', 'Dispensed', 'Adjustments', 'Expired', 'Current Balance', 'Unit', 'Branch'],
      rows: getDrugMovementRows(bundle, dispensingLines),
    },
    'drug-utilization-trends': {
      headers: ['Month', 'Quarter', 'Year', 'Drug', 'Patients', 'Quantity', 'Revenue', 'NHIS Value'],
      rows: getTrendRows(dispensingLines),
    },
    'sales-summary': {
      headers: ['Sale No.', 'Date', 'Patient', 'Payment', 'Items', 'Units', 'Gross', 'Discount', 'Tax', 'Net Amount', 'Status', 'Cashier', 'Branch', 'Notes'],
      rows: rowsOf(bundle.sales).map((sale) => [
        sale.sale_number || sale.saleNumber,
        formatAppDateTime(sale.sale_date || sale.saleDate),
        sale.patients?.full_name || sale.patientName || 'Walk-in Customer',
        sale.payment_method || sale.paymentMethod,
        rowsOf(sale.sale_items || sale.items).length,
        rowsOf(sale.sale_items || sale.items).reduce((sum, item) => sum + numberValue(item.quantity), 0),
        money(sale.total_amount ?? sale.totalAmount ?? sale.gross_amount ?? sale.grossAmount),
        money(sale.discount_amount ?? sale.discountAmount),
        money(sale.tax_amount ?? sale.taxAmount),
        money(sale.net_amount ?? sale.netAmount),
        sale.payment_status || sale.paymentStatus,
        sale.sold_by || sale.soldBy,
        getBranchId(sale),
        sale.notes || sale.reference || '',
      ]),
    },
    'inventory-stock': {
      headers: ['Medicine', 'Batch', 'Category', 'NHIA Code', 'Quantity', 'Reorder Level', 'Unit', 'Unit Cost', 'Selling Price', 'Stock Value', 'Expiry', 'Branch', 'Supplier'],
      rows: rowsOf(bundle.drugs).map((drug) => [
        drug.name,
        drug.batch_number || drug.batchNumber,
        drug.category || drug.required_pharmacy_level || drug.requiredPharmacyLevel,
        drug.nhis_code || drug.nhia_code || drug.nhiaCode || '',
        drug.quantity,
        drug.reorder_level || drug.reorderLevel || 0,
        drug.unit,
        money(drug.cost_price || drug.costPrice),
        money(drug.price),
        money(numberValue(drug.quantity) * numberValue(drug.price)),
        drug.expiry_date || drug.expiryDate,
        getBranchId(drug),
        drug.supplier_name || drug.supplierName || '',
      ]),
    },
    'low-stock': {
      headers: ['Medicine', 'Batch', 'Category', 'Quantity', 'Reorder Level', 'Shortfall', 'Unit', 'Expiry', 'Branch', 'Supplier'],
      rows: rowsOf(bundle.lowStock).map((drug) => [
        drug.name,
        drug.batch_number || drug.batchNumber,
        drug.category || drug.required_pharmacy_level || drug.requiredPharmacyLevel,
        drug.quantity,
        drug.reorder_level || drug.reorderLevel || 0,
        Math.max(numberValue(drug.reorder_level || drug.reorderLevel) - numberValue(drug.quantity), 0),
        drug.unit,
        drug.expiry_date || drug.expiryDate,
        getBranchId(drug),
        drug.supplier_name || drug.supplierName || '',
      ]),
    },
    'expired-expiring': {
      headers: ['Medicine', 'Batch', 'Category', 'Quantity', 'Unit', 'Expiry', 'Status', 'Stock Value', 'Branch', 'Supplier'],
      rows: [...rowsOf(bundle.expired).map((drug) => ({ ...drug, expiryStatus: 'Expired' })), ...rowsOf(bundle.expiring).map((drug) => ({ ...drug, expiryStatus: 'Expiring' }))].map((drug) => [
        drug.name,
        drug.batch_number || drug.batchNumber,
        drug.category || drug.required_pharmacy_level || drug.requiredPharmacyLevel,
        drug.quantity,
        drug.unit,
        drug.expiry_date || drug.expiryDate,
        drug.expiryStatus,
        money(numberValue(drug.quantity) * numberValue(drug.price)),
        getBranchId(drug),
        drug.supplier_name || drug.supplierName || '',
      ]),
    },
    purchases: {
      headers: ['Purchase No.', 'Supplier', 'Invoice No.', 'Date', 'Due Date', 'Status', 'Items', 'Total', 'Paid', 'Balance', 'Created By', 'Branch'],
      rows: rowsOf(bundle.purchases).map((purchase) => [
        purchase.purchase_number || purchase.purchaseNumber || purchase.invoice_number,
        purchase.supplier_name || purchase.supplierName || purchase.suppliers?.name,
        purchase.invoice_number || purchase.invoiceNumber,
        purchase.purchase_date || purchase.purchaseDate || purchase.created_at,
        purchase.due_date || purchase.dueDate || '',
        purchase.status,
        rowsOf(purchase.purchase_items || purchase.items).length,
        money(purchase.total_amount ?? purchase.totalAmount),
        money(purchase.paid_amount ?? purchase.paidAmount),
        money((purchase.balance ?? purchase.balanceAmount) || getPurchaseAmount(purchase) - numberValue(purchase.paid_amount ?? purchase.paidAmount)),
        getUserId(purchase),
        getBranchId(purchase),
      ]),
    },
    'supplier-balances': {
      headers: ['Supplier', 'Contact Person', 'Phone', 'Email', 'Address', 'Opening Balance', 'Purchases', 'Paid', 'Outstanding Balance', 'Status'],
      rows: rowsOf(bundle.suppliers).map((supplier) => [
        supplier.name || supplier.supplier_name,
        supplier.contact_person || supplier.contactPerson || '',
        supplier.phone,
        supplier.email,
        supplier.address || '',
        money(supplier.opening_balance || supplier.openingBalance),
        money(supplier.total_purchases || supplier.totalPurchases),
        money(supplier.total_paid || supplier.totalPaid),
        money(supplier.balance || supplier.outstanding_balance || supplier.outstandingBalance),
        supplier.status || 'active',
      ]),
    },
    patients: {
      headers: ['Patient', 'Phone', 'Gender', 'DOB/Age', 'Insurance Provider', 'Insurance ID', 'NHIS No.', 'Registered', 'Last Visit', 'Branch', 'Address'],
      rows: rowsOf(bundle.patients).map((patient) => [
        patient.full_name || patient.patient_name,
        patient.phone,
        patient.gender,
        patient.date_of_birth || patient.dateOfBirth || patient.age || '',
        patient.insurance_provider,
        patient.insurance_id,
        patient.nhis_member_no || patient.member_no,
        formatAppDateTime(patient.created_at || patient.createdAt),
        formatAppDateTime(patient.last_visit_at || patient.lastVisitAt),
        getBranchId(patient),
        patient.address || '',
      ]),
    },
    'nhis-summary': {
      headers: ['Metric', 'Count', 'Amount'],
      rows: [
        ['Total NHIS claims', bundle.metrics.nhisClaimsCount || nhisClaims.length, money(nhisClaims.reduce((sum, claim) => sum + getClaimAmount(claim), 0))],
        ['Pending claims', bundle.metrics.pendingNhisClaims, money(nhisClaims.filter((claim) => ['draft', 'ready', 'pending', 'failed'].includes(normalizeStatus(getStatus(claim)))).reduce((sum, claim) => sum + getClaimAmount(claim), 0))],
        ['Submitted claims', bundle.metrics.submittedNhisClaims, money(nhisClaims.filter((claim) => ['submitted', 'accepted', 'approved', 'paid', 'rejected'].includes(normalizeStatus(getStatus(claim)))).reduce((sum, claim) => sum + getClaimAmount(claim), 0))],
        ['Approved/paid claims', bundle.metrics.approvedNhisClaims, money(nhisClaims.filter((claim) => ['accepted', 'approved', 'paid'].includes(normalizeStatus(getStatus(claim)))).reduce((sum, claim) => sum + getClaimAmount(claim), 0))],
        ['Rejected/failed claims', bundle.metrics.rejectedNhisClaims, money(nhisClaims.filter((claim) => ['rejected', 'failed'].includes(normalizeStatus(getStatus(claim)))).reduce((sum, claim) => sum + getClaimAmount(claim), 0))],
        ['Unique NHIS members', uniqueCount(nhisClaims.map((claim) => claim.member_number || claim.memberNumber || claim.nhis_member_no || claim.nhisMemberNo)), ''],
        ['Medicine lines', getNhisMedicineLines(nhisClaims).length, money(getNhisMedicineLines(nhisClaims).reduce((sum, line) => sum + numberValue(line.totalPrice), 0))],
        ['GDRG/service lines', getGdrgServiceLines(nhisClaims).length, money(getGdrgServiceLines(nhisClaims).reduce((sum, line) => sum + numberValue(line.totalAmount), 0))],
        ...buildBreakdownRows('Status', nhisClaims, (claim) => getStatus(claim), getClaimAmount),
        ...buildBreakdownRows('Insurance provider', nhisClaims, (claim) => claim.insurance_provider || claim.insuranceProvider || 'NHIS', getClaimAmount),
      ],
    },
    'submitted-claims': {
      headers: ['Claim No.', 'Patient', 'Member No.', 'Provider', 'Status', 'Amount', 'Service Date', 'Submitted/Updated', 'Branch', 'Officer', 'Notes/Error'],
      rows: claimRows(nhisClaims.filter((claim) => ['submitted', 'accepted', 'approved', 'paid', 'rejected'].includes(String(getStatus(claim)).toLowerCase()))),
    },
    'pending-claims': {
      headers: ['Claim No.', 'Patient', 'Member No.', 'Provider', 'Status', 'Amount', 'Service Date', 'Submitted/Updated', 'Branch', 'Officer', 'Notes/Error'],
      rows: claimRows(nhisClaims.filter((claim) => ['draft', 'ready', 'pending', 'failed'].includes(String(getStatus(claim)).toLowerCase()))),
    },
    'approved-claims': {
      headers: ['Claim No.', 'Patient', 'Member No.', 'Provider', 'Status', 'Amount', 'Service Date', 'Submitted/Updated', 'Branch', 'Officer', 'Notes/Error'],
      rows: claimRows(nhisClaims.filter((claim) => ['accepted', 'approved', 'paid'].includes(String(getStatus(claim)).toLowerCase()))),
    },
    'rejected-claims': {
      headers: ['Claim No.', 'Patient', 'Member No.', 'Provider', 'Status', 'Amount', 'Service Date', 'Submitted/Updated', 'Branch', 'Officer', 'Notes/Error'],
      rows: claimRows(nhisClaims.filter((claim) => ['rejected', 'failed'].includes(String(getStatus(claim)).toLowerCase()))),
    },
    'unserved-medicines': {
      headers: ['Claim No.', 'Patient', 'Member No.', 'Service Date', 'Status', 'Claim Amount', 'Branch', 'Officer', 'Unserved Note'],
      rows: nhisClaims
        .filter((claim) => claim.unserved_medicines_note || claim.unservedMedicinesNote)
        .map((claim) => [
          getClaimNumber(claim),
          getPatientName(claim),
          claim.member_number || claim.memberNumber || claim.nhis_member_no || claim.nhisMemberNo || '',
          text(getServiceDate(claim)),
          getStatus(claim),
          money(getClaimAmount(claim)),
          getBranchId(claim),
          getUserId(claim),
          claim.unserved_medicines_note || claim.unservedMedicinesNote,
        ]),
    },
    'nhis-medicines-dispensed': {
      headers: ['Claim No.', 'Patient', 'Date', 'Status', 'Medicine', 'NHIA Code', 'Category', 'Prescribed', 'Dispensed', 'Qty', 'Unit Price', 'Total', 'Branch', 'Officer'],
      rows: getNhisMedicineLines(nhisClaims).map((line) => [
        line.claimNumber,
        line.patient,
        text(line.serviceDate),
        line.status,
        line.item,
        line.code,
        line.category,
        line.prescribed,
        line.dispensed,
        line.quantity,
        money(line.unitPrice),
        money(line.totalPrice),
        line.branch,
        line.officer,
      ]),
    },
    'nhis-patient-return-alerts': {
      headers: ['Patient', 'Member No.', 'HIN', 'Previous Visit', 'Current Visit', 'Hours Since Previous', 'Previous Claim', 'Current Claim', 'Medication Repeated', 'Repeated Medicines', 'Previous Medicines', 'Current Medicines', 'Override Reason', 'Previous Staff', 'Current Staff', 'Branch', 'Claim Status'],
      rows: getNhisPatientReturnRows(nhisClaims).map((row) => [
        row.patient,
        row.memberNo,
        row.hin,
        formatAppDateTime(row.previousVisit),
        formatAppDateTime(row.currentVisit),
        row.timeDifferenceHours,
        row.previousClaim,
        row.currentClaim,
        row.sameMedicationRepeated ? 'Yes' : 'No',
        row.repeatedMedicines,
        row.previousMedicines,
        row.currentMedicines,
        row.overrideReason,
        row.previousStaff,
        row.currentStaff,
        row.branch,
        row.status,
      ]),
    },
    'tariff-gdrg-services': {
      headers: ['Claim No.', 'Patient', 'Date', 'Status', 'GDRG Code', 'Category', 'Service', 'Qty', 'Total', 'Branch', 'Officer'],
      rows: getGdrgServiceLines(nhisClaims).map((line) => [
        line.claimNumber,
        line.patient,
        text(line.serviceDate),
        line.status,
        line.code,
        line.category,
        line.description,
        line.quantity,
        money(line.totalAmount),
        line.branch,
        line.officer,
      ]),
    },
    'claims-officer-activity': {
      headers: ['Date', 'Action', 'Status', 'HTTP', 'Claim/Batch', 'Officer', 'Branch', 'Details'],
      rows: rowsOf(bundle.submissionLogs).map((log) => [
        formatAppDateTime(log.createdAt || log.created_at),
        log.action,
        log.status,
        log.httpStatus || log.http_status || '',
        log.claimId || log.nhia_claim_id || log.batchId || log.batch_id,
        log.createdBy || log.created_by || log.userId || log.user_id || '',
        getBranchId(log),
        log.errorMessage || log.error_message || log.httpStatus || log.http_status || '',
      ]),
    },
    'monthly-nhis-submission': {
      headers: ['Month', 'Claims', 'Amount', 'Accepted', 'Rejected', 'Pending', 'Approval Rate', 'Rejection Rate'],
      rows: rowsOf(bundle.monthlyNhisSubmission).map((month) => [
        month.month,
        month.count,
        money(month.totalAmount),
        month.accepted,
        month.rejected,
        month.pending,
        `${month.count ? ((numberValue(month.accepted) / numberValue(month.count)) * 100).toFixed(1) : '0.0'}%`,
        `${month.count ? ((numberValue(month.rejected) / numberValue(month.count)) * 100).toFixed(1) : '0.0'}%`,
      ]),
    },
    'nhia-reconciliation': {
      headers: ['Status', 'Claims', 'Amount', 'Share of Value', 'Last Activity'],
      rows: ['draft', 'ready', 'submitted', 'accepted', 'paid', 'rejected', 'failed'].map((status) => {
        const statusClaims = nhisClaims.filter((claim) => String(getStatus(claim)).toLowerCase() === status)
        const amount = statusClaims.reduce((sum, claim) => sum + getClaimAmount(claim), 0)
        const totalAmount = nhisClaims.reduce((sum, claim) => sum + getClaimAmount(claim), 0)
        const lastActivity = statusClaims.map((claim) => claim.updated_at || claim.updatedAt || claim.submitted_at || claim.submittedAt || getServiceDate(claim)).sort().at(-1)
        return [status, statusClaims.length, money(amount), `${totalAmount ? ((amount / totalAmount) * 100).toFixed(1) : '0.0'}%`, text(lastActivity)]
      }),
    },
    'claimit-export-history': {
      headers: ['Batch No.', 'Status', 'Format', 'Claims', 'Amount', 'File', 'Created', 'Submitted', 'Created By', 'Branch', 'Response/Error'],
      rows: rowsOf(bundle.exportHistory).map((batch) => [
        batch.batch_number || batch.batchNumber,
        batch.status,
        batch.export_format || batch.exportFormat,
        batch.claim_count || batch.claimCount,
        money(batch.total_amount ?? batch.totalAmount),
        batch.file_name || batch.fileName,
        formatAppDateTime(batch.created_at || batch.createdAt),
        formatAppDateTime(batch.submitted_at || batch.submittedAt),
        getUserId(batch),
        getBranchId(batch),
        compact([batch.response?.message, batch.response?.error, batch.error_message || batch.errorMessage]),
      ]),
    },
    'cc-code-generation': {
      headers: ['Date', 'Action', 'Status', 'HTTP', 'Claim/Batch', 'Officer', 'Branch', 'Error/Response'],
      rows: rowsOf(bundle.submissionLogs)
        .filter((log) => String(log.action || '').toLowerCase().includes('cc') || String(log.action || '').toLowerCase().includes('submit'))
        .map((log) => [
          formatAppDateTime(log.createdAt || log.created_at),
          log.action,
          log.status,
          log.httpStatus || log.http_status || '',
          log.claimId || log.nhia_claim_id || log.batchId || log.batch_id || '',
          getUserId(log),
          getBranchId(log),
          log.errorMessage || log.error_message || '',
        ]),
    },
    'accounting-shifts': {
      headers: ['Sale No.', 'Date', 'Cashier', 'Payment', 'Gross', 'Discount', 'Tax', 'Net Amount', 'Status', 'Shift/Session', 'Branch'],
      rows: rowsOf(bundle.sales).map((sale) => [
        sale.sale_number || sale.saleNumber,
        formatAppDateTime(sale.sale_date || sale.saleDate),
        sale.sold_by || sale.soldBy,
        sale.payment_method || sale.paymentMethod,
        money(sale.total_amount ?? sale.totalAmount ?? sale.gross_amount ?? sale.grossAmount),
        money(sale.discount_amount ?? sale.discountAmount),
        money(sale.tax_amount ?? sale.taxAmount),
        money(sale.net_amount ?? sale.netAmount),
        sale.payment_status || sale.paymentStatus,
        sale.shift_id || sale.shiftId || sale.session_id || sale.sessionId || '',
        getBranchId(sale),
      ]),
    },
    'insurance-receivables': {
      headers: ['Claim No.', 'Patient', 'Member No.', 'Provider', 'Status', 'Receivable', 'Service Date', 'Submitted/Updated', 'Branch', 'Officer', 'Aging/Notes'],
      rows: claimRows([...generalClaims, ...nhisClaims]).map((row) => [row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10]]),
    },
    'facility-billing': {
      headers: ['Metric', 'Value', 'Notes'],
      rows: [
        ['Report source', bundle.source || 'cloud', 'ONLINE_CLOUD, ONLINE_LOCAL_SYNC, or OFFLINE_LOCAL source'],
        ['Facility subscription', bundle.subscriptionStatus || bundle.billing_status || 'Available in facility settings', 'Current facility billing state if supplied by cloud'],
        ['Subscription tier', bundle.subscriptionTier || bundle.subscription_tier || '', 'Plan attached to this organization'],
        ['Trial ends', bundle.trialEndsAt || bundle.trial_ends_at || '', 'Cloud billing date when available'],
        ['Subscription ends', bundle.subscriptionEndsAt || bundle.subscription_ends_at || '', 'Cloud billing date when available'],
        ['Billing records', rowsOf(bundle.facilityBilling).length, 'Cached facility billing rows in report bundle'],
      ],
    },
    'staff-activity': {
      headers: ['Date', 'Module', 'Action', 'Status', 'User', 'Entity/Record', 'Branch', 'Details'],
      rows: rowsOf(bundle.staffActivity).map((activity) => [
        formatAppDateTime(activity.createdAt || activity.created_at),
        activity.module || activity.entity_type || 'System',
        activity.action || activity.event_type,
        activity.status,
        activity.userId || activity.user_id || activity.created_by,
        activity.entity_id || activity.entityId || activity.claimId || activity.saleNumber || '',
        getBranchId(activity),
        activity.details || '',
      ]),
    },
  }

  return definitions[reportId] || {
    headers: ['Sale No.', 'Date', 'Patient', 'Payment', 'Item', 'Qty', 'Unit Price', 'Total', 'Cashier', 'Branch'],
    rows: getSaleItems(bundle.sales).map((item) => [
      item.saleNumber,
      formatAppDateTime(item.date),
      item.patient,
      item.payment,
      item.item,
      item.quantity,
      money(item.unitPrice),
      money(item.totalPrice),
      item.cashier || '',
      item.branch || '',
    ]),
  }
}

const getReportSummaryRows = (reportId, bundle, visibleRows = []) => {
  const sales = rowsOf(bundle.sales)
  const nhisClaims = rowsOf(bundle.nhisClaims)
  const purchases = rowsOf(bundle.purchases)
  const drugs = rowsOf(bundle.drugs)
  const reportTotal = visibleRows.length
  const totalNhisAmount = nhisClaims.reduce((sum, claim) => sum + getClaimAmount(claim), 0)

  const commonRows = [
    [`Rows exported: ${reportTotal}`],
    [`Report source: ${bundle.source || 'cloud'}`],
  ]

  const summaries = {
    'sales-summary': [
      [`Sales transactions: ${sales.length}`],
      [`Gross sales: ${money(sales.reduce((sum, sale) => sum + numberValue(sale.total_amount ?? sale.totalAmount ?? sale.gross_amount ?? sale.grossAmount), 0))}`],
      [`Net sales: ${money(sales.reduce((sum, sale) => sum + getSaleAmount(sale), 0))}`],
      [`Payment breakdown: ${buildBreakdownRows('', sales, (sale) => sale.payment_method || sale.paymentMethod, getSaleAmount).map((row) => `${row[0].replace(/^: /, '')} ${row[1]} (${row[2]})`).join('; ') || 'None'}`],
    ],
    'inventory-stock': [
      [`Inventory items: ${drugs.length}`],
      [`Stock value: ${money(drugs.reduce((sum, drug) => sum + numberValue(drug.quantity) * numberValue(drug.price), 0))}`],
      [`Low stock: ${bundle.metrics.lowStockCount || rowsOf(bundle.lowStock).length}`],
      [`Expired/expiring: ${(bundle.metrics.expiredCount || rowsOf(bundle.expired).length) + (bundle.metrics.expiringCount || rowsOf(bundle.expiring).length)}`],
    ],
    'low-stock': [
      [`Low stock items: ${rowsOf(bundle.lowStock).length}`],
      [`Total reorder shortfall: ${rowsOf(bundle.lowStock).reduce((sum, drug) => sum + Math.max(numberValue(drug.reorder_level || drug.reorderLevel) - numberValue(drug.quantity), 0), 0)}`],
    ],
    'expired-expiring': [
      [`Expired items: ${rowsOf(bundle.expired).length}`],
      [`Expiring items: ${rowsOf(bundle.expiring).length}`],
    ],
    purchases: [
      [`Purchase records: ${purchases.length}`],
      [`Purchase total: ${money(purchases.reduce((sum, purchase) => sum + getPurchaseAmount(purchase), 0))}`],
      [`Outstanding balance: ${money(purchases.reduce((sum, purchase) => sum + numberValue((purchase.balance ?? purchase.balanceAmount) || getPurchaseAmount(purchase) - numberValue(purchase.paid_amount ?? purchase.paidAmount)), 0))}`],
    ],
    patients: [
      [`Patients: ${rowsOf(bundle.patients).length}`],
      [`Insurance providers: ${uniqueCount(rowsOf(bundle.patients).map((patient) => patient.insurance_provider || patient.insuranceProvider))}`],
    ],
    'nhis-summary': [
      [`NHIS claims: ${nhisClaims.length}`],
      [`NHIS claim value: ${money(totalNhisAmount)}`],
      [`Approved/paid: ${bundle.metrics.approvedNhisClaims || 0}`],
      [`Rejected/failed: ${bundle.metrics.rejectedNhisClaims || 0}`],
    ],
    'nhis-medicines-dispensed': [
      [`Medicine lines: ${getNhisMedicineLines(nhisClaims).length}`],
      [`Medicine value: ${money(getNhisMedicineLines(nhisClaims).reduce((sum, line) => sum + numberValue(line.totalPrice), 0))}`],
    ],
    'nhis-patient-return-alerts': [
      [`Return alerts: ${getNhisPatientReturnRows(nhisClaims).length}`],
      [`Same medication repeated: ${getNhisPatientReturnRows(nhisClaims).filter((row) => row.sameMedicationRepeated).length}`],
      [`Different medication supplied: ${getNhisPatientReturnRows(nhisClaims).filter((row) => !row.sameMedicationRepeated).length}`],
    ],
    'tariff-gdrg-services': [
      [`GDRG/service lines: ${getGdrgServiceLines(nhisClaims).length}`],
      [`GDRG/service value: ${money(getGdrgServiceLines(nhisClaims).reduce((sum, line) => sum + numberValue(line.totalAmount), 0))}`],
    ],
    'monthly-nhis-submission': [
      [`Months: ${rowsOf(bundle.monthlyNhisSubmission).length}`],
      [`Claims submitted in period: ${rowsOf(bundle.monthlyNhisSubmission).reduce((sum, month) => sum + numberValue(month.count), 0)}`],
      [`Submission value: ${money(rowsOf(bundle.monthlyNhisSubmission).reduce((sum, month) => sum + numberValue(month.totalAmount), 0))}`],
    ],
    'nhia-reconciliation': [
      [`Claims reconciled: ${nhisClaims.length}`],
      [`Total claim value: ${money(totalNhisAmount)}`],
      [`Outstanding/pending value: ${money(nhisClaims.filter((claim) => !['accepted', 'approved', 'paid'].includes(normalizeStatus(getStatus(claim)))).reduce((sum, claim) => sum + getClaimAmount(claim), 0))}`],
    ],
    'staff-activity': [
      [`Activity records: ${rowsOf(bundle.staffActivity).length}`],
      [`Users captured: ${uniqueCount(rowsOf(bundle.staffActivity).map(getUserId))}`],
    ],
  }

  return [...commonRows, ...(summaries[reportId] || [])]
}

const Reports = () => {
  const { role, displayName, branch } = useAuth()
  const { organization, canUseClaims, tierLimits } = useTenant()
  const [filters, setFilters] = useState(FILTER_DEFAULTS)
  const [activeTab, setActiveTab] = useState('overview')
  const [selectedReportId, setSelectedReportId] = useState('sales-summary')
  const [selectedDrug, setSelectedDrug] = useState('')
  const [drugSearchTerm, setDrugSearchTerm] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMoreNhis, setLoadingMoreNhis] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [bundle, setBundle] = useState(null)
  const [drugSearchBundle, setDrugSearchBundle] = useState(null)
  const [hasGeneratedReports, setHasGeneratedReports] = useState(false)
  const [facilitySettings, setFacilitySettings] = useState(null)
  const lastServerDrugSearchRef = useRef('')
  const reportOutputRef = useRef(null)

  const brandingSource = { ...(organization || {}), ...(facilitySettings || {}) }
  const facilityName = getFacilityName(brandingSource)
  const facilityLogo = getFacilityLogo(brandingSource)
  const reportFooter = getReportFooter(brandingSource)
  const reportCatalog = useMemo(() => getVisibleReportCatalog(role), [role])
  const canViewDrugAnalytics = reportCatalog.some((report) => report.tab === 'analytics')
  const canViewFullDrugAnalytics = canAccessReport(role, 'drug-utilization')
  const selectedReport = reportCatalog.find((report) => report.id === selectedReportId) || reportCatalog[0]
  const effectiveBundle = useMemo(() => (
    drugSearchTerm.trim().length >= 3 && drugSearchBundle
      ? { ...(bundle || {}), sales: drugSearchBundle.sales, nhisClaims: drugSearchBundle.nhisClaims }
      : bundle
  ), [bundle, drugSearchBundle, drugSearchTerm])
  const normalizedBundle = useMemo(() => normalizeReportBundle(effectiveBundle || {}), [effectiveBundle])
  const analyticsFilters = useMemo(() => ({
    ...filters,
    drug: selectedDrug || filters.drug,
    patientType: canViewFullDrugAnalytics ? filters.patientType : 'NHIS',
  }), [canViewFullDrugAnalytics, filters, selectedDrug])
  const rawReportData = useMemo(
    () => (selectedReport ? getReportRows(selectedReport.id, normalizedBundle, analyticsFilters) : { headers: [], rows: [] }),
    [selectedReport, normalizedBundle, analyticsFilters]
  )
  const filteredRows = useMemo(
    () => rawReportData.rows.filter((row) => includesTerm(row, searchTerm)),
    [rawReportData.rows, searchTerm]
  )
  const reportData = useMemo(
    () => ({ headers: rawReportData.headers, rows: filteredRows }),
    [rawReportData.headers, filteredRows]
  )

  const visibleTabs = REPORT_TABS

  const filteredReportCards = useMemo(() => {
    const reports = activeTab === 'overview'
      ? reportCatalog
      : reportCatalog.filter((report) => report.tab === activeTab)
    if (!searchTerm) return reports
    return reports.filter((report) => includesTerm([report.title, report.description], searchTerm))
  }, [activeTab, reportCatalog, searchTerm])

  const summaryCards = [
    { label: 'Sales', value: money(normalizedBundle.metrics.salesAmount), detail: `${normalizedBundle.metrics.salesCount} transactions` },
    { label: 'Inventory', value: normalizedBundle.metrics.inventoryCount, detail: `${normalizedBundle.metrics.lowStockCount} low stock` },
    { label: 'NHIS Claims', value: normalizedBundle.metrics.nhisClaimsCount || normalizedBundle.metrics.claimsCount, detail: `${normalizedBundle.metrics.rejectedNhisClaims || 0} rejected/failed` },
    { label: 'Purchases', value: money(normalizedBundle.metrics.purchaseAmount), detail: `${normalizedBundle.metrics.purchasesCount} purchase records` },
  ]
  const dispensingLines = useMemo(
    () => filterDispensingLines(getDispensingLines(normalizedBundle), analyticsFilters),
    [normalizedBundle, analyticsFilters]
  )
  const drugAnalytics = useMemo(() => summarizeDrugUtilization(dispensingLines), [dispensingLines])
  const searchedDrugAnalytics = useMemo(
    () => drugSearchTerm
      ? drugAnalytics.filter((drug) => matchesFilterText(drug.drug, drugSearchTerm))
      : drugAnalytics,
    [drugAnalytics, drugSearchTerm]
  )
  const fastSearchResult = searchedDrugAnalytics[0]
  const topDrugs = searchedDrugAnalytics.slice(0, 10)
  const selectedDrugLines = useMemo(
    () => selectedDrug
      ? dispensingLines.filter((line) => matchesFilterText(line.drug, selectedDrug))
      : dispensingLines.slice(0, 8),
    [dispensingLines, selectedDrug]
  )
  const visibleDrugPatientLines = selectedDrugLines.slice(0, selectedDrug ? 50 : 8)

  const updateFilter = (key, value) => {
    setFilters((current) => ({ ...current, [key]: value }))
    if (key === 'drug') {
      setSelectedDrug('')
      setDrugSearchTerm(value)
    }
  }

  const showNotice = useCallback((message) => {
    setNotice(message)
  }, [])

  const handleTabClick = useCallback((tab) => {
    const tabReports = tab.id === 'overview'
      ? reportCatalog
      : reportCatalog.filter((report) => report.tab === tab.id)

    if (tabReports.length === 0) {
      showNotice(`${tab.label} is not available yet for your account. It is planned for a future update.`)
      return
    }

    setActiveTab(tab.id)
    setSelectedReportId(tabReports[0].id)

    if (!hasGeneratedReports) {
      showNotice(`${tab.label} is open. Click Generate Reports to load data for this tab.`)
    } else if (searchTerm && !tabReports.some((report) => includesTerm([report.title, report.description], searchTerm))) {
      showNotice(`${tab.label} is open, but no report cards match the current search.`)
    }
  }, [hasGeneratedReports, reportCatalog, searchTerm, showNotice])

  const openDrugDrillDown = useCallback((drugName) => {
    const resolvedDrug = drugName || selectedDrug || fastSearchResult?.drug
    if (!resolvedDrug) {
      showNotice('Select a medicine first to open its patient drill down.')
      return
    }

    setSelectedDrug(resolvedDrug)
    setDrugSearchTerm(resolvedDrug)
    setActiveTab('analytics')
    setSelectedReportId('drug-patient-drilldown')
    showNotice(`Opened the patient drill down for ${resolvedDrug}.`)

    window.requestAnimationFrame(() => {
      reportOutputRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      reportOutputRef.current?.focus?.({ preventScroll: true })
    })
  }, [fastSearchResult?.drug, selectedDrug, showNotice])

  const runReports = useCallback(async (nextFilters = filters) => {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    try {
      setLoading(true)
      setError('')
      setNotice('')

      if (!tierLimits.hasReports) {
        setBundle(null)
        return
      }

      if (nextFilters.startDate && nextFilters.endDate && nextFilters.startDate > nextFilters.endDate) {
        setError('Start date must be before or equal to end date.')
        return
      }

      const data = await getReportBundle({
        ...nextFilters,
        branchId: nextFilters.branch,
        userId: nextFilters.staff,
        prescriber: nextFilters.prescriber,
        patientType: nextFilters.patientType,
        drug: nextFilters.drug,
        nhisClaimLimit: nextFilters.nhisClaimLimit,
      })
      setBundle(data)
      setHasGeneratedReports(true)
      logPerformance('reports.bundle', startedAt, role, {
        source: data?.source || 'cloud',
      })
    } catch (reportError) {
      console.error('Error generating reports:', reportError)
      setError(reportError.message || 'Unable to generate reports.')
    } finally {
      setLoading(false)
    }
  }, [filters, role, tierLimits.hasReports])

  const loadMoreNhisClaims = useCallback(async () => {
    if (loadingMoreNhis || !normalizedBundle.pagination?.nhisClaims?.hasMore) return

    try {
      setLoadingMoreNhis(true)
      setError('')
      const result = await getReportNhisPage({
        startDate: filters.startDate,
        endDate: filters.endDate,
        offset: normalizedBundle.nhisClaims.length,
        limit: normalizedBundle.pagination.nhisClaims.limit || 200,
      })
      const nextRows = result?.nhisClaims || []
      setBundle((current) => {
        const existing = current?.nhisClaims || []
        const seen = new Set(existing.map((claim) => claim.id))
        return {
          ...(current || {}),
          nhisClaims: [...existing, ...nextRows.filter((claim) => !seen.has(claim.id))],
          pagination: {
            ...(current?.pagination || {}),
            nhisClaims: result?.pagination || current?.pagination?.nhisClaims,
          },
        }
      })
    } catch (loadError) {
      setError(loadError.message || 'Unable to load more NHIS report rows.')
    } finally {
      setLoadingMoreNhis(false)
    }
  }, [
    filters.endDate,
    filters.startDate,
    loadingMoreNhis,
    normalizedBundle.nhisClaims.length,
    normalizedBundle.pagination?.nhisClaims,
  ])

  useEffect(() => {
    if (!notice) return undefined

    const timer = window.setTimeout(() => setNotice(''), 7000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!tierLimits.hasReports) {
      setBundle(null)
      setHasGeneratedReports(false)
      return
    }
  }, [tierLimits.hasReports])

  useEffect(() => {
    const term = drugSearchTerm.trim()
    const searchKey = [
      term,
      filters.startDate,
      filters.endDate,
      filters.branch,
      filters.facilityBranch,
      filters.patientType,
      filters.prescriber,
      filters.staff,
    ].join('|')

    if (
      !canViewDrugAnalytics ||
      !hasGeneratedReports ||
      loading ||
      term.length < 3 ||
      searchedDrugAnalytics.length > 0 ||
      lastServerDrugSearchRef.current === searchKey
    ) {
      return
    }

    const timer = window.setTimeout(() => {
      lastServerDrugSearchRef.current = searchKey
      void getReportDrugMatches({
        ...filters,
        drug: term,
        branchId: filters.branch,
        userId: filters.staff,
      }).then(setDrugSearchBundle).catch((searchError) => {
        console.error('Error searching report medicines:', searchError)
        setError(searchError.message || 'Unable to search medicine utilization.')
      })
    }, 500)

    return () => window.clearTimeout(timer)
  }, [
    canViewDrugAnalytics,
    drugSearchTerm,
    filters,
    hasGeneratedReports,
    loading,
    searchedDrugAnalytics.length,
  ])

  useEffect(() => {
    let cancelled = false
    getPharmacyBrandingSettings()
      .then((settings) => {
        if (!cancelled) setFacilitySettings(settings)
      })
      .catch((settingsError) => {
        console.warn('Unable to load report branding settings:', settingsError)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!selectedReport || canAccessReport(role, selectedReport.id)) {
      return
    }

    setSelectedReportId(reportCatalog[0]?.id || '')
  }, [reportCatalog, role, selectedReport])

  useEffect(() => {
    const nextReport = activeTab === 'overview'
      ? reportCatalog[0]
      : reportCatalog.find((report) => report.tab === activeTab)

    const shouldSelectReport = activeTab === 'overview'
      ? selectedReport?.id !== nextReport?.id
      : selectedReport?.tab !== activeTab

    if (nextReport && shouldSelectReport) {
      setSelectedReportId(nextReport.id)
    }
  }, [activeTab, reportCatalog, selectedReport])

  const getMetadataRows = (title, reportId = selectedReport?.id, rows = reportData.rows) => [
    ...buildReportHeaderRows({
      title,
      filters,
      branding: {
        facilityName,
        nhisCode: brandingSource.nhis_code || brandingSource.nhia_code || brandingSource.nhisCode,
        address: brandingSource.address,
        phone: brandingSource.phone,
      },
      generatedBy: displayName,
      branchName: branch?.name,
    }),
    ...getReportSummaryRows(reportId, normalizedBundle, rows),
    [],
    ...(reportFooter ? [[reportFooter]] : []),
    [PLATFORM_GENERATED_BY],
    [],
  ]

  const exportSelectedCsv = () => {
    if (!selectedReport) return
    downloadCsv(
      `${selectedReport.id}.csv`,
      reportData.headers,
      reportData.rows,
      getMetadataRows(selectedReport.title, selectedReport.id, reportData.rows)
    )
  }

  const exportSelectedPdf = () => {
    if (!selectedReport) return
    void exportReportPdf({
      title: selectedReport.title,
      headers: reportData.headers,
      rows: reportData.rows,
      metadataRows: getMetadataRows(selectedReport.title, selectedReport.id, reportData.rows),
    })
  }

  const printSelectedReport = () => {
    if (!selectedReport) return
    printReport({
      title: selectedReport.title,
      headers: reportData.headers,
      rows: reportData.rows,
      metadataRows: getMetadataRows(selectedReport.title, selectedReport.id, reportData.rows),
    })
  }

  return (
    <UpgradeGate locked={!tierLimits.hasReports} feature="Reports" requiredTier="pro">
      <div className="reports-page">
        <div className="page-header reports-header">
          <div className="reports-facility-brand">
            {facilityLogo && <img src={facilityLogo} alt={`${facilityName} logo`} />}
            <div>
              <h1>{facilityName}</h1>
              <p>Reports dashboard for NHIS claims, POS, inventory, purchases, accounting, patients, and staff activity</p>
              <span>{PLATFORM_GENERATED_BY}</span>
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => runReports()} disabled={loading}>
            <RefreshCcw size={16} />
            {loading ? 'Generating...' : 'Generate Reports'}
          </button>
        </div>

        {error && <div className="reports-alert">{error}</div>}
        {notice && <div className="reports-notice">{notice}</div>}

        <div className="reports-filter-panel">
          <label>
            <span>Date range</span>
            <div className="reports-date-pair">
              <Calendar size={16} />
              <input type="date" value={filters.startDate} onChange={(event) => updateFilter('startDate', event.target.value)} />
              <input type="date" value={filters.endDate} onChange={(event) => updateFilter('endDate', event.target.value)} />
            </div>
          </label>
          <label>
            <span>Branch</span>
            <input value={filters.branch} onChange={(event) => updateFilter('branch', event.target.value)} placeholder="All branches" />
          </label>
          <label>
            <span>Facility branch</span>
            <input value={filters.facilityBranch} onChange={(event) => updateFilter('facilityBranch', event.target.value)} placeholder="Branch name or code" />
          </label>
          <label>
            <span>Drug</span>
            <input value={filters.drug} onChange={(event) => updateFilter('drug', event.target.value)} placeholder="Amoxicillin, Paracetamol..." />
          </label>
          <label>
            <span>Patient type</span>
            <select value={filters.patientType} onChange={(event) => updateFilter('patientType', event.target.value)}>
              <option value="">All</option>
              <option value="NHIS">NHIS</option>
              <option value="Cash">Cash</option>
              <option value="Corporate">Corporate</option>
            </select>
          </label>
          <label>
            <span>Facility</span>
            <input value={filters.facility} onChange={(event) => updateFilter('facility', event.target.value)} placeholder="Current facility" />
          </label>
          <label>
            <span>Department/module</span>
            <input value={filters.department} onChange={(event) => updateFilter('department', event.target.value)} placeholder="All modules" />
          </label>
          <label>
            <span>Staff/user</span>
            <input value={filters.staff} onChange={(event) => updateFilter('staff', event.target.value)} placeholder="All users" />
          </label>
          <label>
            <span>Prescriber</span>
            <input value={filters.prescriber} onChange={(event) => updateFilter('prescriber', event.target.value)} placeholder="Doctor or prescriber" />
          </label>
          <label>
            <span>Payment type</span>
            <select value={filters.paymentType} onChange={(event) => updateFilter('paymentType', event.target.value)}>
              <option value="">All</option>
              <option value="cash">Cash</option>
              <option value="momo">Mobile money</option>
              <option value="card">Card</option>
              <option value="insurance">Insurance</option>
              <option value="nhia">NHIA</option>
            </select>
          </label>
          <label>
            <span>Insurance provider</span>
            <input value={filters.insuranceProvider} onChange={(event) => updateFilter('insuranceProvider', event.target.value)} placeholder="NHIS, private..." />
          </label>
          <label>
            <span>NHIS status</span>
            <select value={filters.nhisStatus} onChange={(event) => updateFilter('nhisStatus', event.target.value)}>
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="ready">Ready</option>
              <option value="submitted">Submitted</option>
              <option value="accepted">Accepted</option>
              <option value="paid">Paid</option>
              <option value="rejected">Rejected</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label>
            <span>Claim status</span>
            <input value={filters.claimStatus} onChange={(event) => updateFilter('claimStatus', event.target.value)} placeholder="pending, approved..." />
          </label>
          <label>
            <span>Drug/service category</span>
            <input value={filters.drugCategory} onChange={(event) => updateFilter('drugCategory', event.target.value)} placeholder="Category or GDRG" />
          </label>
        </div>

        <div className="reports-summary-grid">
          {summaryCards.map((card) => (
            <div className="report-summary-card" key={card.label}>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <p>{card.detail}</p>
            </div>
          ))}
        </div>

        {canViewDrugAnalytics && (
        <div className="drug-analytics-panel">
          <div className="drug-fast-search">
            <label className="report-filter-field">
              <Search size={16} />
              <input
                type="search"
                placeholder="Fast search drug utilization"
                value={drugSearchTerm}
                onChange={(event) => {
                  const nextSearch = event.target.value
                  setDrugSearchTerm(nextSearch)
                  if (normalizeKey(nextSearch) !== normalizeKey(selectedDrug)) {
                    setSelectedDrug('')
                  }
                }}
                aria-label="Fast search drug utilization"
              />
              {drugSearchTerm && (
                <button
                  type="button"
                  className="report-filter-clear"
                  onClick={() => {
                    setDrugSearchTerm('')
                    setSelectedDrug('')
                  }}
                  aria-label="Clear drug utilization search"
                >
                  x
                </button>
              )}
            </label>
            <div className="drug-fast-stats">
              <div>
                <span>Patients served</span>
                <strong>{fastSearchResult?.patientsServed || 0}</strong>
              </div>
              <div>
                <span>Quantity dispensed</span>
                <strong>{fastSearchResult ? `${fastSearchResult.quantity} ${fastSearchResult.unit || ''}`.trim() : 0}</strong>
              </div>
              <div>
                <span>Revenue</span>
                <strong>{money(fastSearchResult?.revenue)}</strong>
              </div>
              <div>
                <span>NHIS value</span>
                <strong>{money(fastSearchResult?.nhisValue)}</strong>
              </div>
              <div>
                <span>Last dispensed</span>
                <strong>{dateLabel(fastSearchResult?.lastDate) || '-'}</strong>
              </div>
              <div>
                <span>Top prescribers</span>
                <strong>{fastSearchResult?.topPrescribers || '-'}</strong>
              </div>
            </div>
          </div>

          <div className="drug-top-list">
            <div className="drug-panel-heading">
              <h2>Top 10 Dispensed Drugs</h2>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => {
                  setActiveTab('analytics')
                  setSelectedReportId('top-dispensed-drugs')
                }}
              >
                View Report
              </button>
            </div>
            {topDrugs.length === 0 ? (
              <div className="report-empty-state">
                {!hasGeneratedReports
                  ? 'Click Generate Reports to load drug utilization data.'
                  : drugSearchTerm
                    ? `No dispensing records found for "${drugSearchTerm}" in the selected period. Try a wider date range.`
                    : 'No drug utilization data found for the selected filters.'}
              </div>
            ) : (
              <div className="drug-chip-list">
                {topDrugs.map((drug, index) => (
                  <button
                    type="button"
                    key={`${drug.drug}-${index}`}
                    className={selectedDrug && matchesFilterText(drug.drug, selectedDrug) ? 'active' : ''}
                    onClick={() => openDrugDrillDown(drug.drug)}
                  >
                    <span>{drug.drug}</span>
                    <strong>{drug.patientsServed} patients</strong>
                    <small>{drug.quantity} {drug.unit || 'unit'} | {money(drug.revenue)}</small>
                    <em>View patients who received this drug</em>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="drug-drilldown-preview">
            <div className="drug-panel-heading">
              <div>
                <h2>{selectedDrug ? `${selectedDrug} - Patients Given This Drug` : 'Recent Patient Drug Recipients'}</h2>
                <p>
                  {selectedDrug
                    ? `${selectedDrugLines.length} dispensing record${selectedDrugLines.length === 1 ? '' : 's'} found for ${selectedDrug}.`
                    : 'Select a drug above to see exactly which patients received it.'}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!fastSearchResult && !selectedDrug}
                onClick={() => openDrugDrillDown()}
              >
                Open Drill Down
              </button>
            </div>
            <div className="report-table-wrap">
              <table className="report-table compact">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Patient</th>
                    <th>Folder No.</th>
                    <th>Patient Type</th>
                    <th>Quantity</th>
                    <th>Prescriber</th>
                    <th>Source</th>
                    <th>Record No.</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDrugPatientLines.map((line) => (
                    <tr key={line.id}>
                      <td>{dateLabel(line.date) || '-'}</td>
                      <td>{line.patient}</td>
                      <td>{line.folderNo || '-'}</td>
                      <td>{line.patientType || '-'}</td>
                      <td>{line.quantity} {line.unit || ''}</td>
                      <td>{line.prescriber || '-'}</td>
                      <td>{line.source || '-'}</td>
                      <td>{line.recordNo || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {selectedDrugLines.length === 0 && <div className="report-empty-state">Search or select a drug to see patient-level dispensing detail.</div>}
              {selectedDrugLines.length > visibleDrugPatientLines.length && (
                <div className="drug-recipient-note">
                  Showing the first {visibleDrugPatientLines.length} recipient records. Open the drill down report to view and export all rows.
                </div>
              )}
            </div>
          </div>
        </div>
        )}

        <div className="reports-tabs" role="tablist" aria-label="Report categories">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? 'active' : ''}
              onClick={() => handleTabClick(tab)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="reports-toolbar">
          <label className="report-filter-field">
            <Search size={16} />
            <input
              type="search"
              placeholder="Search reports or visible rows"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              aria-label="Search reports"
            />
          </label>
          <div className="reports-export-actions">
            <button className="btn btn-outline" onClick={printSelectedReport} disabled={!selectedReport || !hasGeneratedReports}>
              <Printer size={16} />
              Print
            </button>
            <button className="btn btn-outline" onClick={exportSelectedPdf} disabled={!selectedReport || !hasGeneratedReports}>
              <FileText size={16} />
              PDF
            </button>
            <button className="btn btn-primary" onClick={exportSelectedCsv} disabled={!selectedReport || !hasGeneratedReports}>
              <FileSpreadsheet size={16} />
              Excel/CSV
            </button>
          </div>
        </div>

        <div className="reports-grid">
          {filteredReportCards.length === 0 ? (
            <div className="reports-empty-panel">
              {searchTerm
                ? 'No report cards match the current search. Clear the search or choose another tab.'
                : 'No reports are available in this tab for your role or facility plan.'}
            </div>
          ) : filteredReportCards.map((report) => (
            <div key={report.id} className={`report-card ${selectedReport?.id === report.id ? 'selected' : ''}`}>
              <div className="report-icon">
                <BarChart3 size={28} />
              </div>
              <div className="report-content">
                <h3>{report.title}</h3>
                <p>{report.description}</p>
              </div>
              <div className="report-actions">
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => {
                    setSelectedReportId(report.id)
                    if (!hasGeneratedReports) {
                      void runReports()
                    } else {
                      window.requestAnimationFrame(() => {
                        reportOutputRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
                      })
                    }
                  }}
                >
                  {hasGeneratedReports ? 'View' : 'Generate'}
                </button>
                <button
                  className="btn btn-outline"
                  type="button"
                  disabled={!hasGeneratedReports}
                  onClick={() => {
                    setSelectedReportId(report.id)
                    downloadCsv(
                      `${report.id}.csv`,
                      getReportRows(report.id, normalizedBundle, analyticsFilters).headers,
                      getReportRows(report.id, normalizedBundle, analyticsFilters).rows,
                      getMetadataRows(report.title, report.id, getReportRows(report.id, normalizedBundle, analyticsFilters).rows)
                    )
                  }}
                >
                  <Download size={16} />
                  Export
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="report-table-card" ref={reportOutputRef} tabIndex={-1}>
          <div className="report-table-header">
            <div>
              <h3>{selectedReport?.title || 'Report Preview'}</h3>
              <p>{selectedReport?.description || 'Select a report to preview its generated rows.'}</p>
            </div>
            <div className="report-table-actions">
              <span className="report-table-count">{reportData.rows.length} rows</span>
              {activeTab === 'nhis' && normalizedBundle.pagination?.nhisClaims?.hasMore && (
                <button
                  className="btn btn-outline"
                  type="button"
                  onClick={() => void loadMoreNhisClaims()}
                  disabled={loadingMoreNhis}
                >
                  {loadingMoreNhis ? 'Loading...' : 'Load more'}
                </button>
              )}
            </div>
          </div>

          {reportData.rows.length === 0 ? (
            <div className="report-empty-state">
              {hasGeneratedReports ? 'No report data found for the selected filters.' : 'Choose filters, then generate reports.'}
            </div>
          ) : (
            <div className="report-table-wrap">
              <table className="report-table">
                <thead>
                  <tr>
                    {reportData.headers.map((header) => (
                      <th key={header}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reportData.rows.slice(0, 250).map((row, rowIndex) => (
                    <tr key={`${selectedReport?.id || 'report'}-${rowIndex}`}>
                      {row.map((cell, cellIndex) => (
                        <td key={`${rowIndex}-${cellIndex}`}>{text(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {!canUseClaims && activeTab === 'nhis' && (
          <div className="reports-alert">NHIS reports are visible only when the NHIS/claims module is enabled for this facility.</div>
        )}
      </div>
    </UpgradeGate>
  )
}

export default Reports
