import { db, parseJson } from './db.js'
import { config } from './config.js'
import { listLocalInventory } from './inventoryRepository.js'
import { listOfflineRecords } from './offlineRecordsRepository.js'
import { getNhiaSubmissionLogs, listNhiaClaims } from './nhiaRepository.js'

const selectSales = db.prepare(`
  SELECT *
  FROM sales
  ORDER BY sale_date DESC
  LIMIT ?
`)

const selectSaleItems = db.prepare(`
  SELECT *
  FROM sale_items
  WHERE sale_id = ?
  ORDER BY created_at ASC
`)

const selectBatches = db.prepare(`
  SELECT *
  FROM nhia_claim_batches
  ORDER BY created_at DESC
  LIMIT ?
`)

const toDateOnly = (value) => String(value || '').slice(0, 10)

const normalizeText = (value) => String(value || '').trim().toLowerCase()

const toMoney = (value) => {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

const isInRange = (dateValue, startDate, endDate) => {
  const date = toDateOnly(dateValue)
  if (!date) return true
  if (startDate && date < startDate) return false
  if (endDate && date > endDate) return false
  return true
}

const hasTextMatch = (values, expected) => {
  const term = normalizeText(expected)
  if (!term) return true
  return values.some((value) => normalizeText(value).includes(term))
}

const getClaimStatus = (claim = {}) => normalizeText(claim.status || claim.claim_status)

const getClaimServiceDate = (claim = {}) =>
  claim.serviceDate || claim.service_date || claim.service_date_from || claim.createdAt || claim.created_at

const mapSale = (sale, patientMap = new Map()) => ({
  ...sale,
  patients: patientMap.get(String(sale.patient_id || '')) || null,
  sale_items: selectSaleItems.all(sale.id),
})

const mapBatch = (batch) => ({
  id: batch.id,
  batchNumber: batch.batch_number,
  status: batch.status,
  exportFormat: batch.export_format,
  claimCount: batch.claim_count,
  totalAmount: batch.total_amount,
  payload: parseJson(batch.payload_json, {}),
  response: parseJson(batch.response_json, null),
  fileName: batch.file_name,
  organizationId: batch.organization_id,
  branchId: batch.branch_id,
  createdBy: batch.created_by,
  submittedAt: batch.submitted_at,
  createdAt: batch.created_at,
  updatedAt: batch.updated_at,
})

const normalizeNhisClaimForReport = (claim = {}) => ({
  ...claim,
  claim_number: claim.claimNumber || claim.claim_number,
  patient_name: claim.patientName || claim.patient_name,
  member_number: claim.memberNumber || claim.member_number,
  insurance_provider: claim.insuranceProvider || claim.insurance_provider || 'NHIS',
  total_amount: claim.totalAmount || claim.total_amount || 0,
  service_date: claim.serviceDate || claim.service_date,
  claim_status: claim.status || claim.claim_status,
  branch_id: claim.branchId || claim.branch_id,
  created_by: claim.createdBy || claim.created_by,
  created_at: claim.createdAt || claim.created_at,
  nhis_claim_medicines: claim.items || claim.nhis_claim_medicines || [],
  nhis_claim_services: claim.services || claim.payload?.services || claim.nhis_claim_services || [],
})

const filterSales = (sales, filters) =>
  sales.filter((sale) => {
    if (!isInRange(sale.sale_date, filters.startDate, filters.endDate)) return false
    if (filters.branch && sale.branch_id !== filters.branch) return false
    if (filters.staff && sale.sold_by !== filters.staff) return false
    if (filters.paymentType && normalizeText(sale.payment_method) !== normalizeText(filters.paymentType)) return false
    if (!hasTextMatch([sale.notes, sale.sale_number, sale.payment_method], filters.department)) return false
    return true
  })

const filterClaims = (claims, filters) =>
  claims.filter((claim) => {
    if (!isInRange(getClaimServiceDate(claim), filters.startDate, filters.endDate)) return false
    if (filters.branch && (claim.branch_id || claim.branchId) !== filters.branch) return false
    if (filters.staff && (claim.submitted_by || claim.created_by || claim.createdBy) !== filters.staff) return false
    if (filters.insuranceProvider && !hasTextMatch([claim.insurance_provider, claim.insuranceProvider], filters.insuranceProvider)) return false
    if (filters.nhisStatus && getClaimStatus(claim) !== normalizeText(filters.nhisStatus)) return false
    if (filters.claimStatus && getClaimStatus(claim) !== normalizeText(filters.claimStatus)) return false
    return true
  })

const filterInventory = (drugs, filters) =>
  drugs.filter((drug) => {
    if (filters.branch && drug.branch_id && drug.branch_id !== filters.branch) return false
    if (filters.drugCategory && !hasTextMatch([drug.category, drug.required_pharmacy_level, drug.medicine_access_level, drug.nhis_code], filters.drugCategory)) {
      return false
    }
    return true
  })

const filterPurchases = (purchases, filters) =>
  purchases.filter((purchase) => {
    if (!isInRange(purchase.purchase_date || purchase.created_at, filters.startDate, filters.endDate)) return false
    if (filters.branch && purchase.branch_id !== filters.branch) return false
    if (filters.staff && purchase.created_by !== filters.staff) return false
    return true
  })

const getDailySales = (sales) =>
  sales.reduce((summary, sale) => {
    const date = toDateOnly(sale.sale_date)
    if (date) {
      summary[date] = (summary[date] || 0) + toMoney(sale.net_amount)
    }
    return summary
  }, {})

const getMonthlyNhisSubmission = (claims) =>
  Object.values(
    claims.reduce((summary, claim) => {
      const month = String(claim.submission_month || getClaimServiceDate(claim) || '').slice(0, 7) || 'Unspecified'
      if (!summary[month]) {
        summary[month] = { month, count: 0, totalAmount: 0, accepted: 0, rejected: 0, pending: 0 }
      }
      const status = getClaimStatus(claim)
      summary[month].count += 1
      summary[month].totalAmount += toMoney(claim.total_amount || claim.totalAmount)
      if (['accepted', 'approved', 'paid'].includes(status)) summary[month].accepted += 1
      else if (['rejected', 'failed'].includes(status)) summary[month].rejected += 1
      else summary[month].pending += 1
      return summary
    }, {})
  ).sort((left, right) => right.month.localeCompare(left.month))

export const getLocalReportBundle = (filters = {}) => {
  const normalizedFilters = {
    startDate: String(filters.startDate || filters.fromDate || '').slice(0, 10),
    endDate: String(filters.endDate || filters.toDate || '').slice(0, 10),
    branch: String(filters.branch || filters.branchId || '').trim(),
    staff: String(filters.staff || filters.userId || '').trim(),
    paymentType: String(filters.paymentType || '').trim(),
    insuranceProvider: String(filters.insuranceProvider || '').trim(),
    nhisStatus: String(filters.nhisStatus || '').trim(),
    claimStatus: String(filters.claimStatus || '').trim(),
    drugCategory: String(filters.drugCategory || filters.category || '').trim(),
    department: String(filters.department || filters.module || '').trim(),
  }

  const patients = listOfflineRecords('patients', { limit: 5000 })
  const patientMap = new Map(patients.map((patient) => [String(patient.id), patient]))
  const sales = filterSales(selectSales.all(5000).map((sale) => mapSale(sale, patientMap)), normalizedFilters)
  const claims = filterClaims(listOfflineRecords('claims', { limit: 5000 }), normalizedFilters)
  const nhisClaims = filterClaims(
    listNhiaClaims({ limit: 5000 }).map(normalizeNhisClaimForReport),
    normalizedFilters
  )
  const drugs = filterInventory(listLocalInventory({ branchId: normalizedFilters.branch || config.branchId || '', limit: 20000 }), normalizedFilters)
  const purchases = filterPurchases(listOfflineRecords('purchases', { limit: 5000 }), normalizedFilters)
  const suppliers = listOfflineRecords('suppliers', { limit: 5000 })
  const submissionLogs = getNhiaSubmissionLogs({ limit: 200 }).filter((log) =>
    isInRange(log.createdAt, normalizedFilters.startDate, normalizedFilters.endDate)
  )
  const exportHistory = selectBatches.all(500).map(mapBatch).filter((batch) =>
    isInRange(batch.createdAt || batch.submittedAt, normalizedFilters.startDate, normalizedFilters.endDate)
  )

  const now = new Date()
  const thirtyDaysAhead = new Date(now)
  thirtyDaysAhead.setDate(thirtyDaysAhead.getDate() + 30)
  const lowStock = drugs.filter((drug) => Number(drug.quantity || 0) <= Number(drug.reorder_level || 0))
  const expired = drugs.filter((drug) => drug.expiry_date && new Date(drug.expiry_date).getTime() < now.getTime())
  const expiring = drugs.filter((drug) => {
    if (!drug.expiry_date) return false
    const expiryTime = new Date(drug.expiry_date).getTime()
    return expiryTime >= now.getTime() && expiryTime <= thirtyDaysAhead.getTime()
  })
  const staffActivity = [
    ...submissionLogs.map((log) => ({
      id: log.id,
      action: log.action,
      status: log.status,
      userId: null,
      module: 'NHIS',
      createdAt: log.createdAt,
      details: log.errorMessage || log.httpStatus || '',
    })),
    ...sales.map((sale) => ({
      id: sale.id,
      action: 'sale.completed',
      status: sale.payment_status,
      userId: sale.sold_by,
      module: 'Sales',
      createdAt: sale.sale_date,
      details: sale.sale_number,
    })),
  ].sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))

  return {
    source: 'local-branch-server',
    filters: normalizedFilters,
    sales,
    claims,
    nhisClaims,
    patients,
    drugs,
    lowStock,
    expired,
    expiring,
    purchases,
    suppliers,
    submissionLogs,
    exportHistory,
    monthlyNhisSubmission: getMonthlyNhisSubmission(nhisClaims),
    staffActivity,
    metrics: {
      salesCount: sales.length,
      salesAmount: sales.reduce((sum, sale) => sum + toMoney(sale.net_amount), 0),
      soldLineItems: sales.reduce((sum, sale) => sum + sale.sale_items.length, 0),
      unitsSold: sales.reduce(
        (sum, sale) => sum + sale.sale_items.reduce((itemSum, item) => itemSum + Number(item.quantity || 0), 0),
        0
      ),
      claimsCount: claims.length,
      nhisClaimsCount: nhisClaims.length,
      lowStockCount: lowStock.length,
      expiredCount: expired.length,
      expiringCount: expiring.length,
      patientCount: patients.length,
      inventoryCount: drugs.length,
      purchasesCount: purchases.length,
      purchaseAmount: purchases.reduce((sum, purchase) => sum + toMoney(purchase.total_amount || purchase.totalAmount), 0),
      dailySales: getDailySales(sales),
    },
  }
}
