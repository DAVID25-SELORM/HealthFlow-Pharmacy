// Says which parts of a cloud report are incomplete, so the screen and every export can say so.
//
// The cloud report service sends one batch of NHIS claims first (200 by default, with the true total). For other
// records it says which lists went past its limit (`pagination.truncated`) and which could not be read
// (`unavailable`). An older server says neither and stops every list at 1,000, so that is still recognised.
// The offline branch server has different limits and sends no NHIS pagination, so none of this applies to it.

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

  const truncated = bundle.pagination.truncated
  for (const key of LIST_KEYS) {
    if (truncated ? truncated[key] : sizeOf(bundle[key]) >= REPORT_ROW_CAP && OLD_SERVER_KEYS.includes(key)) {
      partials[key] = { limit: truncated ? 0 : REPORT_ROW_CAP }
    }
  }

  for (const name of bundle.unavailable || []) {
    if (name === 'nhisClaims') partials.nhis = { ...(partials.nhis || { loaded, total }), unavailable: true }
    else if (LIST_KEYS.includes(name)) partials[name] = { unavailable: true }
  }
  return partials
}

const NHIS_PAGE_MAX = 250
export const NHIS_LOAD_ALL_MAX = 20000

// How far the server's own list has been read. Claims a drug filter adds on top of the first batch must not
// count, or the next page would start too far along and skip claims.
export const getNhisPagedCount = (bundle = {}) => {
  const paging = bundle?.pagination?.nhisClaims || {}
  if (Number.isFinite(paging.paged)) return paging.paged
  const loaded = sizeOf(bundle.nhisClaims)
  return Math.min(Number(paging.limit || loaded), loaded)
}

/** The bundle with one more page of NHIS claims added; a claim already there is not added twice. */
export const appendNhisPage = (bundle, result, offset) => {
  const received = result?.nhisClaims || []
  const existing = bundle?.nhisClaims || []
  const seen = new Set(existing.map((claim) => claim.id))
  return {
    ...bundle,
    nhisClaims: [...existing, ...received.filter((claim) => !seen.has(claim.id))],
    pagination: {
      ...(bundle?.pagination || {}),
      nhisClaims: {
        ...(bundle?.pagination?.nhisClaims || {}),
        ...(result?.pagination || {}),
        limit: bundle?.pagination?.nhisClaims?.limit || NHIS_PAGE_MAX,
        paged: offset + received.length,
        hasMore: Boolean(result?.pagination?.hasMore) && received.length > 0,
      },
    },
  }
}

export const NHIS_LOAD_ALL_PAGE_SIZE = NHIS_PAGE_MAX

const listMessage = (name, figures) => ({ limit, unavailable }) => {
  if (unavailable) return `${name} could not be loaded, so ${figures} are missing.`
  if (limit) return `${name} stop at ${count(limit)} records, so ${figures} may be incomplete.`
  return `${name} go past the report's record limit, so ${figures} are incomplete. Choose a shorter period.`
}

const MESSAGES = {
  nhis: ({ loaded, total, unavailable }) => (unavailable
    ? 'NHIS claims could not be loaded, so NHIS claim and medicine figures are missing.'
    : `Only ${count(loaded)} of ${count(total)} NHIS claims are loaded, so NHIS claim and medicine figures are incomplete.`),
  sales: listMessage('Sales', 'sales figures'),
  drugs: listMessage('Inventory items', 'stock, low-stock and expiry figures'),
  patients: listMessage('Patients', 'patient figures'),
  purchases: listMessage('Purchases', 'purchase figures'),
  claims: listMessage('Insurance claims', 'their figures'),
  suppliers: listMessage('Suppliers', 'supplier figures'),
  exportHistory: listMessage('CLAIM-it export records', 'export history figures'),
  submissionLogs: listMessage('CC code requests', 'CC code figures'),
}

const LIST_KEYS = Object.keys(MESSAGES).filter((key) => key !== 'nhis')
const OLD_SERVER_KEYS = ['sales', 'drugs', 'patients', 'purchases', 'claims', 'suppliers']

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
  'staff-activity': ['sales', 'submissionLogs'],
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
  'claims-officer-activity': ['nhis', 'submissionLogs'],
  'nhia-reconciliation': NHIS_ONLY,
  'insurance-receivables': ['nhis', 'claims'],
  // Built from totals the server counts across every claim, or from no capped records.
  'monthly-nhis-submission': [],
  'claimit-export-history': ['exportHistory'],
  'cc-code-generation': ['submissionLogs'],
  'facility-billing': [],
}

export const describePartials = (partials = {}, keys = Object.keys(MESSAGES)) =>
  keys.filter((key) => partials[key]).map((key) => MESSAGES[key](partials[key]))

// A report this list does not know about is treated as using everything, so it is never silently trusted.
export const getReportWarnings = (reportId, partials = {}) =>
  describePartials(partials, REPORT_SOURCES[reportId] || Object.keys(MESSAGES))
