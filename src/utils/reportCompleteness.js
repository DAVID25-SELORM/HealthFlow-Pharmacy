// Says which parts of a cloud report are incomplete, so the screen and every export can say so.
//
// The cloud report service sends only one batch of NHIS claims (200 by default, with the true total), and at most
// 1,000 rows of each other kind of record. The offline branch server has different limits and sends no NHIS
// pagination, so none of these warnings apply to it.

export const REPORT_ROW_CAP = 1000

const count = (value) => Number(value || 0).toLocaleString('en-GB')
const sizeOf = (value) => (Array.isArray(value) ? value.length : 0)

export const getReportPartials = (bundle = {}) => {
  const paging = bundle?.pagination?.nhisClaims
  if (!paging) return {}

  const partials = {}
  const loaded = sizeOf(bundle.nhisClaims)
  const total = Number(paging.total || 0)
  if (total > loaded) partials.nhis = { loaded, total }

  for (const key of ['sales', 'drugs', 'patients', 'purchases', 'claims', 'suppliers']) {
    if (sizeOf(bundle[key]) >= REPORT_ROW_CAP) partials[key] = true
  }
  return partials
}

const MESSAGES = {
  nhis: ({ loaded, total }) =>
    `Only ${count(loaded)} of ${count(total)} NHIS claims are loaded, so NHIS claim and medicine figures are incomplete.`,
  sales: () => `Sales stop at ${count(REPORT_ROW_CAP)} records, so sales figures may be incomplete.`,
  drugs: () => `Inventory stops at ${count(REPORT_ROW_CAP)} items, so stock, low-stock and expiry figures may be incomplete.`,
  patients: () => `Patients stop at ${count(REPORT_ROW_CAP)} records, so patient figures may be incomplete.`,
  purchases: () => `Purchases stop at ${count(REPORT_ROW_CAP)} records, so purchase figures may be incomplete.`,
  claims: () => `Insurance claims stop at ${count(REPORT_ROW_CAP)} records, so their figures may be incomplete.`,
  suppliers: () => `Suppliers stop at ${count(REPORT_ROW_CAP)} records, so supplier figures may be incomplete.`,
}

const DRUG_LINES = ['nhis', 'sales']
const NHIS_ONLY = ['nhis']

// Which kinds of record each report is built from.
const REPORT_SOURCES = {
  'drug-utilization': DRUG_LINES,
  'drug-patient-drilldown': DRUG_LINES,
  'top-dispensed-drugs': DRUG_LINES,
  'disease-drug-analysis': DRUG_LINES,
  'nhis-drug-consumption': DRUG_LINES,
  'drug-utilization-trends': DRUG_LINES,
  'drug-movement': ['nhis', 'sales', 'drugs', 'purchases'],
  'sales-summary': ['sales'],
  'accounting-shifts': ['sales'],
  'staff-activity': ['sales'],
  'inventory-stock': ['drugs'],
  'low-stock': ['drugs'],
  'expired-expiring': ['drugs'],
  purchases: ['purchases'],
  'supplier-balances': ['suppliers'],
  patients: ['patients'],
  'nhis-summary': NHIS_ONLY,
  'submitted-claims': NHIS_ONLY,
  'pending-claims': NHIS_ONLY,
  'approved-claims': NHIS_ONLY,
  'rejected-claims': NHIS_ONLY,
  'unserved-medicines': NHIS_ONLY,
  'nhis-medicines-dispensed': NHIS_ONLY,
  'nhis-patient-return-alerts': NHIS_ONLY,
  'tariff-gdrg-services': NHIS_ONLY,
  'claims-officer-activity': NHIS_ONLY,
  'nhia-reconciliation': NHIS_ONLY,
  'insurance-receivables': ['nhis', 'claims'],
  // Built from totals the server counts across every claim, or from no capped records.
  'monthly-nhis-submission': [],
  'claimit-export-history': [],
  'cc-code-generation': [],
  'facility-billing': [],
}

export const describePartials = (partials = {}, keys = Object.keys(MESSAGES)) =>
  keys.filter((key) => partials[key]).map((key) => MESSAGES[key](partials[key]))

// A report this list does not know about is treated as using everything, so it is never silently trusted.
export const getReportWarnings = (reportId, partials = {}) =>
  describePartials(partials, REPORT_SOURCES[reportId] || Object.keys(MESSAGES))
