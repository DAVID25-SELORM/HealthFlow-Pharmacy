import { supabase } from '../lib/supabase'
import { REPORT_COUNTED_STATUSES } from '../utils/nhisMonthlyReports'

const PAGE_SIZE = 1000
const MAX_PAGES = 60
const DRUG_ID_CHUNK = 100

export const MEDICINE_SOURCES = ['all', 'nhis', 'cash']

const LINE_SELECT = `
  id, claim_id, drug_code, description, unit, unit_price, dispensed_qty, served_qty,
  serving_status, total_amount, dispensary_date,
  nhis_claims!inner (
    id, organization_id, claim_number, surname, other_names, member_no, folder_no, ccc_no,
    gender, date_of_birth, service_date_from, status
  )
`

const SALE_LINE_SELECT = `
  *,
  drugs (name),
  sales!inner (
    *,
    patients (id, full_name, folder_no, nhis_member_no, insurance_id, date_of_birth, gender)
  )
`

const TOO_MANY = 'That search found too many lines to list. Choose fewer months or more specific medicine names.'

// Terms reach the database as a filter string, so anything that could end a value early is dropped.
const filterValue = (term) => `"*${String(term).replace(/["*\\,()%]/g, ' ').replace(/\s+/g, ' ').trim()}*"`

const cleanTerms = (terms) => [...new Set((terms || []).map((term) => String(term || '').trim()).filter(Boolean))]

const requireInternet = () => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('Medicine search needs an internet connection. Connect and try again.')
  }
}

const dayAfter = (date) => {
  const [year, month, day] = String(date).split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

const toNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/**
 * Claim lines (with their claim and patient details) whose medicine name contains any of the terms,
 * for served, submitted and paid claims with a service date inside the period.
 */
export const searchNhisClaimMedicines = async ({ organizationId = '', fromDate, toDate, terms = [] } = {}) => {
  const wanted = cleanTerms(terms)
  if (!wanted.length) return []
  requireInternet()

  const orFilter = wanted.map((term) => `description.ilike.${filterValue(term)}`).join(',')
  const lines = []

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE
    let query = supabase
      .from('nhis_claim_medicines')
      .select(LINE_SELECT)
      .or(orFilter)
      .in('nhis_claims.status', REPORT_COUNTED_STATUSES)
      .gte('nhis_claims.service_date_from', fromDate)
      .lte('nhis_claims.service_date_from', toDate)
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
    if (organizationId) query = query.eq('nhis_claims.organization_id', organizationId)

    const { data, error } = await query
    if (error) throw new Error(error.message || 'The medicine search could not be completed.')
    lines.push(...(data || []).map(({ nhis_claims: claim, ...line }) => ({ ...line, source: 'nhis', claim })))
    if (!data || data.length < PAGE_SIZE) return lines
  }

  throw new Error(TOO_MANY)
}

// A POS sale line in the same shape as a claim line, so one set of rules builds the summary from both.
const saleLineToSearchLine = (item) => {
  const { drugs: drug, sales: sale, ...rest } = item
  const patient = sale?.patients || null
  const quantity = toNumber(rest.quantity)
  const unitPrice = toNumber(rest.unit_price ?? rest.price)
  const explicitTotal = rest.total_price ?? rest.total_amount
  const hasTotal = explicitTotal !== null && explicitTotal !== undefined && String(explicitTotal) !== ''
  return {
    id: rest.id,
    claim_id: sale?.id,
    source: 'cash',
    hasPatient: Boolean(patient),
    description: drug?.name || rest.drug_name || rest.name || rest.description || '',
    unit: rest.unit || '',
    unit_price: unitPrice,
    dispensed_qty: quantity,
    served_qty: 0,
    total_amount: hasTotal ? toNumber(explicitTotal) : quantity * unitPrice,
    dispensary_date: sale?.sale_date ? String(sale.sale_date).slice(0, 10) : null,
    claim: {
      id: sale?.id,
      claim_number: sale?.sale_number || '',
      status: 'completed',
      surname: patient?.full_name || '',
      other_names: '',
      member_no: patient?.nhis_member_no || patient?.insurance_id || '',
      folder_no: patient?.folder_no || '',
      patient_id: patient?.id || '',
      ccc_no: '',
      gender: patient?.gender || '',
      date_of_birth: patient?.date_of_birth || null,
      service_date_from: sale?.sale_date ? String(sale.sale_date).slice(0, 10) : null,
    },
  }
}

/**
 * Completed POS sale lines for medicines whose name contains any of the terms, in the period.
 * Sales with no patient are returned too (marked hasPatient: false) so they can be counted and left out.
 */
export const searchCashSaleMedicines = async ({ organizationId = '', fromDate, toDate, terms = [] } = {}) => {
  const wanted = cleanTerms(terms)
  if (!wanted.length) return []
  requireInternet()

  let drugQuery = supabase
    .from('drugs')
    .select('id, name')
    .or(wanted.map((term) => `name.ilike.${filterValue(term)}`).join(','))
    .limit(5000)
  if (organizationId) drugQuery = drugQuery.eq('organization_id', organizationId)
  const { data: drugs, error: drugError } = await drugQuery
  if (drugError) throw new Error(drugError.message || 'The medicine search could not be completed.')
  const drugIds = [...new Set((drugs || []).map((drug) => drug.id).filter(Boolean))]
  if (!drugIds.length) return []

  const lines = []
  for (let start = 0; start < drugIds.length; start += DRUG_ID_CHUNK) {
    const chunk = drugIds.slice(start, start + DRUG_ID_CHUNK)
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const from = page * PAGE_SIZE
      let query = supabase
        .from('sale_items')
        .select(SALE_LINE_SELECT)
        .in('drug_id', chunk)
        .eq('sales.payment_status', 'completed')
        .gte('sales.sale_date', fromDate)
        .lt('sales.sale_date', dayAfter(toDate))
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
      if (organizationId) query = query.eq('sales.organization_id', organizationId)

      const { data, error } = await query
      if (error) throw new Error(error.message || 'The medicine search could not be completed.')
      lines.push(...(data || []).map(saleLineToSearchLine))
      if (!data || data.length < PAGE_SIZE) break
      if (page === MAX_PAGES - 1) throw new Error(TOO_MANY)
    }
  }
  return lines
}

/** NHIS claim lines, cash sale lines, or both, depending on `source` ('nhis', 'cash' or 'all'). */
export const searchMedicineLines = async ({ source = 'all', ...options } = {}) => {
  if (source === 'nhis') return searchNhisClaimMedicines(options)
  if (source === 'cash') return searchCashSaleMedicines(options)
  const [claimLines, saleLines] = await Promise.all([
    searchNhisClaimMedicines(options),
    searchCashSaleMedicines(options),
  ])
  return [...claimLines, ...saleLines]
}
