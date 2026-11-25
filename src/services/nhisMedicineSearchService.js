import { supabase } from '../lib/supabase'
import { REPORT_COUNTED_STATUSES } from '../utils/nhisMonthlyReports'

const PAGE_SIZE = 1000
const MAX_PAGES = 60

const LINE_SELECT = `
  id, claim_id, drug_code, description, unit, unit_price, dispensed_qty, served_qty,
  serving_status, total_amount, dispensary_date,
  nhis_claims!inner (
    id, organization_id, claim_number, surname, other_names, member_no, folder_no, ccc_no,
    gender, date_of_birth, service_date_from, status
  )
`

// Terms reach the database as a filter string, so anything that could end a value early is dropped.
const filterValue = (term) => `"*${String(term).replace(/["*\\,()%]/g, ' ').replace(/\s+/g, ' ').trim()}*"`

/**
 * Claim lines (with their claim and patient details) whose medicine name contains any of the terms,
 * for served, submitted and paid claims with a service date inside the period.
 */
export const searchNhisClaimMedicines = async ({ organizationId = '', fromDate, toDate, terms = [] } = {}) => {
  const cleanTerms = [...new Set(terms.map((term) => String(term || '').trim()).filter(Boolean))]
  if (!cleanTerms.length) return []
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('Medicine search needs an internet connection. Connect and try again.')
  }

  const orFilter = cleanTerms.map((term) => `description.ilike.${filterValue(term)}`).join(',')
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
    lines.push(...(data || []).map(({ nhis_claims: claim, ...line }) => ({ ...line, claim })))
    if (!data || data.length < PAGE_SIZE) return lines
  }

  throw new Error('That search found too many lines to list. Choose fewer months or more specific medicine names.')
}
