import { supabase } from '../lib/supabase'
import { assertNonNegativeNumber, assertRequiredText, normalizeText } from '../utils/validation'
import { tryLogAuditEvent } from './auditService'

// ── Claim payments (receivables) ───────────────────────────────────────────────

export const getClaimPayments = async (filters = {}) => {
  let query = supabase
    .from('claim_payments')
    .select(`
      *,
      claims (
        id,
        claim_number,
        claim_status,
        total_amount,
        service_date,
        patient_name
      ),
      branches (id, name, code)
    `)
    .order('created_at', { ascending: false })

  if (filters.branchId) query = query.eq('branch_id', filters.branchId)
  if (filters.startDate) query = query.gte('created_at', `${filters.startDate}T00:00:00`)
  if (filters.endDate)   query = query.lte('created_at', `${filters.endDate}T23:59:59`)

  const { data, error } = await query
  if (error) throw error
  return data
}

/**
 * Get approved claims that have no or partial payment — the receivables list.
 */
export const getReceivables = async (branchId = null) => {
  let query = supabase
    .from('claims')
    .select(`
      id,
      claim_number,
      claim_status,
      insurance_provider,
      total_amount,
      service_date,
      patient_name,
      claim_payments (id, paid_amount, payment_date)
    `)
    .eq('claim_status', 'approved')
    .order('service_date', { ascending: true })

  const { data, error } = await query
  if (error) throw error

  return data
    .map((claim) => {
      const totalPaid = (claim.claim_payments || []).reduce(
        (sum, p) => sum + Number(p.paid_amount),
        0
      )
      const outstanding = Math.max(0, Number(claim.total_amount) - totalPaid)
      const ageDays = Math.floor(
        (Date.now() - new Date(claim.service_date).getTime()) / 86_400_000
      )
      return {
        ...claim,
        totalPaid,
        outstanding,
        ageDays,
        ageBucket:
          ageDays <= 30 ? '0–30'
          : ageDays <= 60 ? '31–60'
          : ageDays <= 90 ? '61–90'
          : '90+',
      }
    })
    .filter((c) => c.outstanding > 0)
}

export const recordClaimPayment = async (paymentData) => {
  const payload = {
    claim_id:          paymentData.claimId,
    insurer_name:      assertRequiredText(paymentData.insurerName, 'Insurer name'),
    approved_amount:   assertNonNegativeNumber(paymentData.approvedAmount, 'Approved amount'),
    paid_amount:       assertNonNegativeNumber(paymentData.paidAmount, 'Paid amount'),
    payment_date:      paymentData.paymentDate || new Date().toISOString().split('T')[0],
    payment_method:    paymentData.paymentMethod || 'bank_transfer',
    payment_reference: normalizeText(paymentData.paymentReference) || null,
    notes:             normalizeText(paymentData.notes) || null,
    branch_id:         paymentData.branchId  || null,
    created_by:        paymentData.createdBy || null,
  }

  if (payload.paid_amount > payload.approved_amount) {
    throw new Error('Paid amount cannot exceed approved amount.')
  }

  const { data, error } = await supabase
    .from('claim_payments')
    .insert([payload])
    .select(`*, claims(claim_number, insurance_provider)`)
    .single()

  if (error) throw error

  await tryLogAuditEvent({
    eventType: 'claim.payment_recorded',
    entityType: 'claim_payments',
    entityId: data.id,
    action: 'create',
    details: {
      claim_id:     payload.claim_id,
      insurer_name: payload.insurer_name,
      paid_amount:  payload.paid_amount,
    },
  })

  return data
}

export const updateClaimPayment = async (id, updates) => {
  const payload = { updated_at: new Date().toISOString() }

  if (updates.paidAmount !== undefined) payload.paid_amount = assertNonNegativeNumber(updates.paidAmount, 'Paid amount')
  if (updates.paymentDate)    payload.payment_date    = updates.paymentDate
  if (updates.paymentMethod)  payload.payment_method  = updates.paymentMethod
  if (updates.paymentReference !== undefined) payload.payment_reference = normalizeText(updates.paymentReference) || null
  if (updates.notes !== undefined) payload.notes = normalizeText(updates.notes) || null

  const { data, error } = await supabase
    .from('claim_payments')
    .update(payload)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

// ── Receivables summary ───────────────────────────────────────────────────────

export const getReceivablesSummary = async () => {
  const receivables = await getReceivables()

  const totalOutstanding = receivables.reduce((sum, r) => sum + r.outstanding, 0)
  const totalApproved    = receivables.reduce((sum, r) => sum + Number(r.total_amount), 0)
  const totalPaid        = receivables.reduce((sum, r) => sum + r.totalPaid, 0)

  const byInsurer = receivables.reduce((acc, r) => {
    const key = r.insurance_provider || 'Unknown'
    if (!acc[key]) acc[key] = { insurer: key, outstanding: 0, count: 0 }
    acc[key].outstanding += r.outstanding
    acc[key].count++
    return acc
  }, {})

  const byAgeBucket = receivables.reduce((acc, r) => {
    acc[r.ageBucket] = (acc[r.ageBucket] || 0) + r.outstanding
    return acc
  }, {})

  return {
    totalOutstanding,
    totalApproved,
    totalPaid,
    byInsurer: Object.values(byInsurer).sort((a, b) => b.outstanding - a.outstanding),
    byAgeBucket,
    count: receivables.length,
  }
}
