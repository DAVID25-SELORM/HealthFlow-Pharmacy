import { supabase } from '../lib/supabase'
import { formatLocalDate } from '../utils/date'
import { assertNonNegativeNumber, assertRequiredText, normalizeText } from '../utils/validation'
import { tryLogAuditEvent } from './auditService'
import { getUserBranchIdsByUserIds } from './branchService'
import { recordCashbookMovementIfSessionOpen } from './cashbookService'

const AGE_BUCKETS = ['0-30', '31-60', '61-90', '90+']

const getAgeBucket = (ageDays) => {
  if (ageDays <= 30) return '0-30'
  if (ageDays <= 60) return '31-60'
  if (ageDays <= 90) return '61-90'
  return '90+'
}

const buildReceivablesRows = async (claims, branchId = null) => {
  const branchMap = await getUserBranchIdsByUserIds(claims.map((claim) => claim.submitted_by))

  return claims
    .map((claim) => {
      const approvedAmount = Number(claim.approval_amount ?? claim.total_amount ?? 0)
      const totalPaid = (claim.claim_payments || []).reduce(
        (sum, payment) => sum + Number(payment.paid_amount),
        0
      )
      const outstanding = Math.max(0, approvedAmount - totalPaid)
      const ageDays = Math.max(
        0,
        Math.floor((Date.now() - new Date(claim.service_date).getTime()) / 86_400_000)
      )

      return {
        ...claim,
        approved_amount: approvedAmount,
        branch_id: branchMap[claim.submitted_by] || null,
        totalPaid,
        outstanding,
        ageDays,
        ageBucket: getAgeBucket(ageDays),
      }
    })
    .filter((claim) => claim.outstanding > 0)
    .filter((claim) => !branchId || claim.branch_id === branchId)
}

const getClaimPaymentContext = async (claimId) => {
  const { data: claim, error } = await supabase
    .from('claims')
    .select(`
      id,
      claim_number,
      insurance_provider,
      total_amount,
      approval_amount,
      submitted_by,
      claim_payments (paid_amount)
    `)
    .eq('id', claimId)
    .single()

  if (error) throw error

  const branchMap = await getUserBranchIdsByUserIds([claim.submitted_by])
  const approvedAmount = Number(claim.approval_amount ?? claim.total_amount ?? 0)
  const totalPaid = (claim.claim_payments || []).reduce(
    (sum, payment) => sum + Number(payment.paid_amount),
    0
  )

  return {
    claimId: claim.id,
    claimNumber: claim.claim_number,
    insurerName: claim.insurance_provider,
    approvedAmount,
    outstanding: Math.max(0, approvedAmount - totalPaid),
    branchId: branchMap[claim.submitted_by] || null,
  }
}

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
    .order('payment_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })

  if (filters.branchId) query = query.eq('branch_id', filters.branchId)
  if (filters.startDate) query = query.gte('payment_date', filters.startDate)
  if (filters.endDate) query = query.lte('payment_date', filters.endDate)

  const { data, error } = await query
  if (error) throw error
  return data
}

export const getReceivables = async (branchId = null) => {
  const { data, error } = await supabase
    .from('claims')
    .select(`
      id,
      claim_number,
      claim_status,
      insurance_provider,
      total_amount,
      approval_amount,
      service_date,
      patient_name,
      submitted_by,
      claim_payments (id, paid_amount, payment_date)
    `)
    .eq('claim_status', 'approved')
    .order('service_date', { ascending: true })

  if (error) throw error
  return buildReceivablesRows(data || [], branchId)
}

export const recordClaimPayment = async (paymentData) => {
  const claimContext = await getClaimPaymentContext(paymentData.claimId)
  const paidAmount = assertNonNegativeNumber(paymentData.paidAmount, 'Paid amount')

  if (paidAmount > claimContext.outstanding) {
    throw new Error('Paid amount cannot exceed the outstanding approved amount.')
  }

  const payload = {
    claim_id: paymentData.claimId,
    insurer_name: assertRequiredText(paymentData.insurerName || claimContext.insurerName, 'Insurer name'),
    approved_amount: claimContext.approvedAmount,
    paid_amount: paidAmount,
    payment_date: paymentData.paymentDate || formatLocalDate(),
    payment_method: paymentData.paymentMethod || 'bank_transfer',
    payment_reference: normalizeText(paymentData.paymentReference) || null,
    notes: normalizeText(paymentData.notes) || null,
    branch_id: paymentData.branchId || claimContext.branchId || null,
    created_by: paymentData.createdBy || null,
  }

  const { data, error } = await supabase
    .from('claim_payments')
    .insert([payload])
    .select('*, claims(claim_number, insurance_provider)')
    .single()

  if (error) throw error

  await tryLogAuditEvent({
    eventType: 'claim.payment_recorded',
    entityType: 'claim_payments',
    entityId: data.id,
    action: 'create',
    details: {
      claim_id: payload.claim_id,
      insurer_name: payload.insurer_name,
      paid_amount: payload.paid_amount,
    },
  })

  if (data.payment_method === 'cash' && data.branch_id) {
    try {
      await recordCashbookMovementIfSessionOpen({
        branchId: data.branch_id,
        entryType: 'deposit',
        sourceType: 'claim_payment',
        sourceId: data.id,
        amount: data.paid_amount,
        direction: 'in',
        description: `Claim payment ${data.claims?.claim_number || claimContext.claimNumber}`,
        createdBy: data.created_by,
      })
    } catch (cashbookError) {
      console.warn('Unable to sync claim payment to cashbook:', cashbookError)
    }
  }

  return data
}

export const updateClaimPayment = async (id, updates) => {
  const payload = { updated_at: new Date().toISOString() }

  if (updates.paidAmount !== undefined) payload.paid_amount = assertNonNegativeNumber(updates.paidAmount, 'Paid amount')
  if (updates.paymentDate) payload.payment_date = updates.paymentDate
  if (updates.paymentMethod) payload.payment_method = updates.paymentMethod
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

export const getReceivablesSummary = async (branchId = null) => {
  const receivables = await getReceivables(branchId)

  const totalOutstanding = receivables.reduce((sum, receivable) => sum + receivable.outstanding, 0)
  const totalApproved = receivables.reduce((sum, receivable) => sum + Number(receivable.approved_amount || 0), 0)
  const totalPaid = receivables.reduce((sum, receivable) => sum + receivable.totalPaid, 0)

  const byInsurer = receivables.reduce((acc, receivable) => {
    const key = receivable.insurance_provider || 'Unknown'
    if (!acc[key]) acc[key] = { insurer: key, outstanding: 0, count: 0 }
    acc[key].outstanding += receivable.outstanding
    acc[key].count += 1
    return acc
  }, {})

  const byAgeBucket = AGE_BUCKETS.reduce((acc, bucket) => {
    acc[bucket] = 0
    return acc
  }, {})

  receivables.forEach((receivable) => {
    byAgeBucket[receivable.ageBucket] += receivable.outstanding
  })

  return {
    totalOutstanding,
    totalApproved,
    totalPaid,
    byInsurer: Object.values(byInsurer).sort((a, b) => b.outstanding - a.outstanding),
    byAgeBucket,
    count: receivables.length,
  }
}
