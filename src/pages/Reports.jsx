import { useEffect, useMemo, useState } from 'react'
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
import { getPharmacySettings } from '../services/settingsService'
import {
  REPORT_TABS,
  buildReportHeaderRows,
  canAccessReport,
  downloadCsv,
  exportReportPdf,
  getReportBundle,
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
}

const money = (value) => `GHS ${Number(value || 0).toFixed(2)}`
const text = (value, fallback = '-') => value || fallback
const rowsOf = (value) => (Array.isArray(value) ? value : [])
const getStatus = (row = {}) => row.status || row.claim_status || row.claimStatus || ''
const getClaimNumber = (row = {}) => row.claim_number || row.claimNumber || row.localSaleNumber || row.id
const getPatientName = (row = {}) => row.patient_name || row.patientName || row.patients?.full_name || 'Walk-in Customer'
const getServiceDate = (row = {}) => row.service_date || row.serviceDate || row.created_at || row.createdAt
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
      id: item.id || `${claim.id}-${item.drug_name || item.drugName}`,
      claimNumber: getClaimNumber(claim),
      patient: getPatientName(claim),
      serviceDate: getServiceDate(claim),
      status: getStatus(claim),
      item: item.drug_name || item.drugName || item.name || 'Medicine',
      code: item.nhia_code || item.nhiaCode || item.code || '',
      category: item.category || item.drug_category || item.drugCategory || '',
      prescribed: item.prescribed_quantity || item.prescribedQuantity || item.quantity,
      dispensed: item.dispensed_quantity || item.dispensedQuantity || item.quantity,
      quantity: item.quantity,
      unitPrice: item.unit_price ?? item.unitPrice,
      totalPrice: item.total_price ?? item.totalPrice,
      branch: getBranchId(claim),
      officer: getUserId(claim),
    }))
  )

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

const includesTerm = (row, term) =>
  !term ||
  Object.values(row).some((value) =>
    String(value || '').toLowerCase().includes(String(term || '').toLowerCase())
  )

const getReportRows = (reportId, bundle) => {
  const nhisClaims = rowsOf(bundle.nhisClaims)
  const generalClaims = rowsOf(bundle.claims)

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
  const [searchTerm, setSearchTerm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [bundle, setBundle] = useState(null)
  const [facilitySettings, setFacilitySettings] = useState(null)

  const brandingSource = { ...(organization || {}), ...(facilitySettings || {}) }
  const facilityName = getFacilityName(brandingSource)
  const facilityLogo = getFacilityLogo(brandingSource)
  const reportFooter = getReportFooter(brandingSource)
  const reportCatalog = useMemo(() => getVisibleReportCatalog(role), [role])
  const selectedReport = reportCatalog.find((report) => report.id === selectedReportId) || reportCatalog[0]
  const normalizedBundle = useMemo(() => normalizeReportBundle(bundle || {}), [bundle])
  const rawReportData = useMemo(
    () => (selectedReport ? getReportRows(selectedReport.id, normalizedBundle) : { headers: [], rows: [] }),
    [selectedReport, normalizedBundle]
  )
  const filteredRows = useMemo(
    () => rawReportData.rows.filter((row) => includesTerm(row, searchTerm)),
    [rawReportData.rows, searchTerm]
  )
  const reportData = useMemo(
    () => ({ headers: rawReportData.headers, rows: filteredRows }),
    [rawReportData.headers, filteredRows]
  )

  const visibleTabs = useMemo(() => {
    const tabIds = new Set(['overview'])
    reportCatalog.forEach((report) => tabIds.add(report.tab))
    return REPORT_TABS.filter((tab) => tabIds.has(tab.id))
  }, [reportCatalog])

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

  const updateFilter = (key, value) => {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  const runReports = async (nextFilters = filters) => {
    try {
      setLoading(true)
      setError('')

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
      })
      setBundle(data)
    } catch (reportError) {
      console.error('Error generating reports:', reportError)
      setError(reportError.message || 'Unable to generate reports.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!tierLimits.hasReports) {
      setBundle(null)
      return
    }

    void runReports(FILTER_DEFAULTS)
  }, [tierLimits.hasReports])

  useEffect(() => {
    let cancelled = false
    getPharmacySettings()
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
    exportReportPdf({
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

        <div className="reports-tabs" role="tablist" aria-label="Report categories">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? 'active' : ''}
              onClick={() => setActiveTab(tab.id)}
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
            <button className="btn btn-outline" onClick={printSelectedReport} disabled={!selectedReport}>
              <Printer size={16} />
              Print
            </button>
            <button className="btn btn-outline" onClick={exportSelectedPdf} disabled={!selectedReport}>
              <FileText size={16} />
              PDF
            </button>
            <button className="btn btn-primary" onClick={exportSelectedCsv} disabled={!selectedReport}>
              <FileSpreadsheet size={16} />
              Excel/CSV
            </button>
          </div>
        </div>

        <div className="reports-grid">
          {filteredReportCards.map((report) => (
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
                  onClick={() => setSelectedReportId(report.id)}
                >
                  Generate
                </button>
                <button
                  className="btn btn-outline"
                  type="button"
                  onClick={() => {
                    setSelectedReportId(report.id)
                    downloadCsv(
                      `${report.id}.csv`,
                      getReportRows(report.id, normalizedBundle).headers,
                      getReportRows(report.id, normalizedBundle).rows,
                      getMetadataRows(report.title, report.id, getReportRows(report.id, normalizedBundle).rows)
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

        <div className="report-table-card">
          <div className="report-table-header">
            <div>
              <h3>{selectedReport?.title || 'Report Preview'}</h3>
              <p>{selectedReport?.description || 'Select a report to preview its generated rows.'}</p>
            </div>
            <span className="report-table-count">{reportData.rows.length} rows</span>
          </div>

          {reportData.rows.length === 0 ? (
            <div className="report-empty-state">No report data found for the selected filters.</div>
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
