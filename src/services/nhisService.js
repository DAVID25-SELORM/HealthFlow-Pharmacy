import { supabase } from '../lib/supabase'
import { assertRequiredText, assertNonNegativeNumber, normalizeText, sanitizeSearchTerm } from '../utils/validation'
import { tryLogAuditEvent } from './auditService'

// ─── NHIS Drug Catalog ────────────────────────────────────────────────────────

export const getAllNhisDrugs = async (searchTerm = '') => {
  let query = supabase
    .from('nhis_drugs')
    .select('*')
    .eq('is_active', true)
    .order('description')

  const term = sanitizeSearchTerm(searchTerm)
  if (term) {
    query = query.or(
      `code.ilike.%${term}%,description.ilike.%${term}%,generic_name.ilike.%${term}%`
    )
  }

  const { data, error } = await query
  if (error) throw error
  return data || []
}

export const getNhisDrugByCode = async (code) => {
  const { data, error } = await supabase
    .from('nhis_drugs')
    .select('*')
    .eq('code', code.trim().toUpperCase())
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw error
  return data
}

export const createNhisDrug = async (drugData) => {
  const code        = assertRequiredText(drugData.code,        'Drug code').toUpperCase()
  const description = assertRequiredText(drugData.description, 'Description')

  const { data, error } = await supabase
    .from('nhis_drugs')
    .insert([{
      code,
      description,
      generic_name: normalizeText(drugData.genericName)  || null,
      strength:     normalizeText(drugData.strength)     || null,
      dosage_form:  normalizeText(drugData.dosageForm)   || null,
      category:     normalizeText(drugData.category)     || null,
      unit:         normalizeText(drugData.unit)         || 'unit',
      unit_price:   assertNonNegativeNumber(drugData.unitPrice, 'Unit price'),
    }])
    .select()
    .single()

  if (error) throw error
  return data
}

export const updateNhisDrug = async (id, drugData) => {
  const { data, error } = await supabase
    .from('nhis_drugs')
    .update({
      description:  normalizeText(drugData.description),
      generic_name: normalizeText(drugData.genericName)  || null,
      strength:     normalizeText(drugData.strength)     || null,
      dosage_form:  normalizeText(drugData.dosageForm)   || null,
      category:     normalizeText(drugData.category)     || null,
      unit:         normalizeText(drugData.unit)         || 'unit',
      unit_price:   assertNonNegativeNumber(drugData.unitPrice, 'Unit price'),
      updated_at:   new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

export const deleteNhisDrug = async (id) => {
  const { error } = await supabase
    .from('nhis_drugs')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw error
}

/**
 * Bulk upsert NHIS drugs from an import (CSV/Excel).
 * Existing drugs (matched by code) are updated; new ones are inserted.
 * @param {Array} drugs - validated drug rows
 * @returns {{ inserted: number, updated: number, errors: string[] }}
 */
export const upsertNhisDrugs = async (drugs) => {
  if (!drugs?.length) throw new Error('No drugs to import.')

  const rows = drugs.map((d) => ({
    code:         String(d.code || '').trim().toUpperCase(),
    description:  String(d.description || '').trim(),
    generic_name: String(d.generic_name || d.genericName || '').trim() || null,
    strength:     String(d.strength     || '').trim() || null,
    dosage_form:  String(d.dosage_form  || d.dosageForm || '').trim() || null,
    category:     String(d.category     || '').trim() || null,
    unit:         String(d.unit         || 'unit').trim(),
    unit_price:   Number.parseFloat(d.unit_price ?? d.unitPrice ?? 0) || 0,
    is_active:    true,
    updated_at:   new Date().toISOString(),
  })).filter((r) => r.code && r.description)

  if (!rows.length) throw new Error('No valid rows found to import.')

  const { error } = await supabase
    .from('nhis_drugs')
    .upsert(rows, { onConflict: 'organization_id,code', ignoreDuplicates: false })

  if (error) throw error

  await tryLogAuditEvent({
    eventType: 'nhis_drugs.imported',
    entityType: 'nhis_drugs',
    entityId: null,
    action: 'import',
    details: { count: rows.length },
  })

  return rows.length
}

// ─── NHIS Claims ─────────────────────────────────────────────────────────────

export const getAllNhisClaims = async (filters = {}) => {
  let query = supabase
    .from('nhis_claims')
    .select(`
      *,
      nhis_claim_medicines (
        id, nhis_drug_id, drug_code, description, unit,
        unit_price, dispensed_qty, dispensary_date,
        dose, frequency, duration, total_amount
      )
    `)
    .order('created_at', { ascending: false })

  if (filters.status && filters.status !== 'all') {
    query = query.eq('status', filters.status)
  }

  if (filters.month) {
    query = query.eq('submission_month', filters.month)
  }

  if (filters.searchTerm) {
    const term = sanitizeSearchTerm(filters.searchTerm)
    if (term) {
      query = query.or(
        `surname.ilike.%${term}%,other_names.ilike.%${term}%,member_no.ilike.%${term}%,claim_number.ilike.%${term}%,hin.ilike.%${term}%`
      )
    }
  }

  const { data, error } = await query
  if (error) throw error
  return data || []
}

export const getNhisClaimStats = async () => {
  const { data, error } = await supabase
    .from('nhis_claims')
    .select('status, total_amount')

  if (error) throw error

  const rows = data || []
  return {
    total:     rows.length,
    served:    rows.filter((r) => r.status === 'served').length,
    submitted: rows.filter((r) => r.status === 'submitted').length,
    paid:      rows.filter((r) => r.status === 'paid').length,
    rejected:  rows.filter((r) => r.status === 'rejected').length,
    totalPaid: rows
      .filter((r) => r.status === 'paid')
      .reduce((s, r) => s + Number(r.total_amount || 0), 0),
  }
}

/**
 * Creates an NHIS claim with medicines.
 * Also saves HIN/member_no back to the patient record if patient_id is provided.
 */
export const createNhisClaim = async (claimData, medicines) => {
  if (!medicines?.length) throw new Error('Add at least one medicine to the claim.')
  assertRequiredText(claimData.surname, 'Surname')

  const totalAmount = medicines.reduce((s, m) => s + Number(m.totalAmount || 0), 0)

  const { data: claim, error: claimError } = await supabase
    .from('nhis_claims')
    .insert([{
      patient_id:         claimData.patientId         || null,
      member_no:          normalizeText(claimData.memberNo)          || null,
      hin:                normalizeText(claimData.hin)               || null,
      surname:            normalizeText(claimData.surname),
      other_names:        normalizeText(claimData.otherNames)        || null,
      folder_no:          normalizeText(claimData.folderNo)          || null,
      gender:             normalizeText(claimData.gender)            || null,
      date_of_birth:      claimData.dateOfBirth                      || null,
      ccc_no:             normalizeText(claimData.cccNo)             || null,
      service_date_from:  claimData.serviceDateFrom                  || null,
      service_date_to:    claimData.serviceDateTo                    || null,
      referring_facility: normalizeText(claimData.referringFacility) || null,
      referral_code:      normalizeText(claimData.referralCode)      || null,
      physician_name:     normalizeText(claimData.physicianName)     || null,
      pre_auth_codes:     normalizeText(claimData.preAuthCodes)      || null,
      total_amount:       totalAmount,
      status:             'served',
      notes:              normalizeText(claimData.notes)             || null,
    }])
    .select()
    .single()

  if (claimError) throw claimError

  // Insert medicines
  const medicineRows = medicines.map((m) => ({
    claim_id:       claim.id,
    nhis_drug_id:   m.nhisDrugId      || null,
    drug_code:      normalizeText(m.drugCode)      || null,
    description:    assertRequiredText(m.description, 'Medicine description'),
    unit:           normalizeText(m.unit)           || 'unit',
    unit_price:     assertNonNegativeNumber(m.unitPrice, 'Unit price'),
    dispensed_qty:  assertNonNegativeNumber(m.dispensedQty, 'Dispensed qty'),
    dispensary_date: m.dispensaryDate || null,
    dose:           normalizeText(m.dose)           || null,
    frequency:      normalizeText(m.frequency)      || null,
    duration:       normalizeText(m.duration)       || null,
    total_amount:   assertNonNegativeNumber(m.totalAmount, 'Total amount'),
  }))

  const { error: medsError } = await supabase
    .from('nhis_claim_medicines')
    .insert(medicineRows)

  if (medsError) throw medsError

  // Save NHIS member info back to patient record for auto-fill on future visits
  if (claimData.patientId && (claimData.memberNo || claimData.hin)) {
    await supabase
      .from('patients')
      .update({
        nhis_member_no:    normalizeText(claimData.memberNo) || null,
        nhis_hin:          normalizeText(claimData.hin)      || null,
        insurance_provider: 'NHIS',
        insurance_id:      normalizeText(claimData.memberNo || claimData.hin) || null,
      })
      .eq('id', claimData.patientId)
  }

  await tryLogAuditEvent({
    eventType: 'nhis_claim.created',
    entityType: 'nhis_claims',
    entityId: claim.id,
    action: 'create',
    details: {
      claim_number:  claim.claim_number,
      patient_name:  `${claimData.surname} ${claimData.otherNames || ''}`.trim(),
      medicine_count: medicines.length,
      total_amount:   totalAmount,
    },
  })

  return claim
}

export const updateNhisClaimStatus = async (id, status, rejectionReason = '') => {
  const validStatuses = ['served', 'submitted', 'paid', 'rejected']
  if (!validStatuses.includes(status)) throw new Error('Invalid claim status.')

  const updates = {
    status,
    updated_at: new Date().toISOString(),
    ...(status === 'rejected' && rejectionReason
      ? { rejection_reason: rejectionReason }
      : {}),
  }

  const { data, error } = await supabase
    .from('nhis_claims')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error

  await tryLogAuditEvent({
    eventType: 'nhis_claim.status_updated',
    entityType: 'nhis_claims',
    entityId: id,
    action: 'update_status',
    details: { status, rejection_reason: rejectionReason || null },
  })

  return data
}

// ─── Monthly Batch Export ─────────────────────────────────────────────────────

/**
 * Returns all claims for a given month (YYYY-MM) ready for NHIA submission.
 */
export const getNhisClaimsForMonth = async (yearMonth) => {
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) throw new Error('Month must be in YYYY-MM format.')

  const { data, error } = await supabase
    .from('nhis_claims')
    .select(`
      *,
      nhis_claim_medicines (
        drug_code, description, unit, unit_price,
        dispensed_qty, dispensary_date, dose, frequency, duration, total_amount
      )
    `)
    .eq('submission_month', yearMonth)
    .order('created_at')

  if (error) throw error
  return data || []
}

/**
 * Generates a CSV string for all claims in a given month and triggers download.
 */
export const exportNhisMonthlyCSV = async (yearMonth) => {
  const claims = await getNhisClaimsForMonth(yearMonth)
  if (!claims.length) throw new Error(`No claims found for ${yearMonth}.`)

  const escapeCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`

  const headerRow = [
    'Claim Number', 'Status', 'Surname', 'Other Names', 'Member No', 'HIN',
    'Folder No', 'Gender', 'Date of Birth', 'CCC No',
    'Service Date From', 'Service Date To',
    'Referring Facility', 'Referral Code',
    'Physician Name', 'Pre-Auth Codes',
    'Drug Code', 'Description', 'Unit', 'Unit Price',
    'Dispensed Qty', 'Dispensary Date', 'Dose', 'Frequency', 'Duration', 'Line Total',
    'Claim Total',
  ].map(escapeCell).join(',')

  const dataRows = []
  for (const claim of claims) {
    const meds = claim.nhis_claim_medicines || []
    if (!meds.length) {
      dataRows.push([
        claim.claim_number, claim.status,
        claim.surname, claim.other_names || '',
        claim.member_no || '', claim.hin || '',
        claim.folder_no || '', claim.gender || '',
        claim.date_of_birth || '', claim.ccc_no || '',
        claim.service_date_from || '', claim.service_date_to || '',
        claim.referring_facility || '', claim.referral_code || '',
        claim.physician_name || '', claim.pre_auth_codes || '',
        '', '', '', '', '', '', '', '', '', '', claim.total_amount,
      ].map(escapeCell).join(','))
    } else {
      for (const med of meds) {
        dataRows.push([
          claim.claim_number, claim.status,
          claim.surname, claim.other_names || '',
          claim.member_no || '', claim.hin || '',
          claim.folder_no || '', claim.gender || '',
          claim.date_of_birth || '', claim.ccc_no || '',
          claim.service_date_from || '', claim.service_date_to || '',
          claim.referring_facility || '', claim.referral_code || '',
          claim.physician_name || '', claim.pre_auth_codes || '',
          med.drug_code || '', med.description,
          med.unit, med.unit_price,
          med.dispensed_qty, med.dispensary_date || '',
          med.dose || '', med.frequency || '', med.duration || '',
          med.total_amount, claim.total_amount,
        ].map(escapeCell).join(','))
      }
    }
  }

  const csv = [headerRow, ...dataRows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `NHIS-Claims-${yearMonth}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)

  // Mark all served claims for this month as submitted
  await supabase
    .from('nhis_claims')
    .update({ status: 'submitted', updated_at: new Date().toISOString() })
    .eq('submission_month', yearMonth)
    .eq('status', 'served')

  return claims.length
}
