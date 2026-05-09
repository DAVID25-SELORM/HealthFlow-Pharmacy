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

const getAgeDays = (dateValue) => {
  const parsed = new Date(dateValue)
  if (Number.isNaN(parsed.getTime())) {
    return 0
  }

  return Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 86_400_000))
}

const buildGeneralReceivablesRows = async (claims, branchId = null) => {
  const claimsWithoutBranch = claims.filter((claim) => !claim.branch_id)
  const branchMap = await getUserBranchIdsByUserIds(
    claimsWithoutBranch.map((claim) => claim.submitted_by)
  )

  return claims
    .map((claim) => {
      const approvedAmount = Number(claim.approval_amount ?? claim.total_amount ?? 0)
      const totalPaid = (claim.claim_payments || []).reduce(
        (sum, payment) => sum + Number(payment.paid_amount),
        0
      )
      const outstanding = Math.max(0, approvedAmount - totalPaid)
      const ageDays = getAgeDays(claim.service_date)

      return {
        ...claim,
        source_type: 'claim',
        source_id: claim.id,
        approved_amount: approvedAmount,
        branch_id: claim.branch_id || branchMap[claim.submitted_by] || null,
        totalPaid,
        outstanding,
        ageDays,
        ageBucket: getAgeBucket(ageDays),
      }
    })
    .filter((claim) => claim.outstanding > 0)
    .filter((claim) => !branchId || claim.branch_id === branchId)
}

const buildNhisReceivablesRows = async (claims, branchId = null) => {
  const claimsWithoutBranch = claims.filter((claim) => !claim.branch_id)
  const branchMap = await getUserBranchIdsByUserIds(
    claimsWithoutBranch.map((claim) => claim.created_by)
  )

  return claims
    .map((claim) => {
      const approvedAmount = Number(claim.total_amount || 0)
      const totalPaid = (claim.nhis_claim_payments || []).reduce(
        (sum, payment) => sum + Number(payment.paid_amount),
        0
      )
      const outstanding = Math.max(0, approvedAmount - totalPaid)
      const serviceDate = claim.service_date_from || claim.created_at?.slice(0, 10) || formatLocalDate()
      const ageDays = getAgeDays(serviceDate)
      const patientName = [claim.surname, claim.other_names].filter(Boolean).join(' ').trim()

      return {
        ...claim,
        source_type: 'nhis_claim',
        source_id: claim.id,
        claim_status: claim.status,
        insurance_provider: 'NHIS',
        insurance_id: claim.member_no || claim.hin || '',
        patient_name: patientName || 'NHIS patient',
        service_date: serviceDate,
        approved_amount: approvedAmount,
        branch_id: claim.branch_id || branchMap[claim.created_by] || null,
        patients: {
          phone: null,
          insurance_id: claim.member_no || claim.hin || '',
        },
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
      branch_id,
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
    sourceType: 'claim',
    claimNumber: claim.claim_number,
    insurerName: claim.insurance_provider,
    approvedAmount,
    outstanding: Math.max(0, approvedAmount - totalPaid),
    branchId: claim.branch_id || branchMap[claim.submitted_by] || null,
  }
}

const getNhisClaimPaymentContext = async (claimId) => {
  const { data: claim, error } = await supabase
    .from('nhis_claims')
    .select(`
      id,
      organization_id,
      branch_id,
      claim_number,
      total_amount,
      status,
      surname,
      other_names,
      member_no,
      hin,
      created_by,
      nhis_claim_payments (paid_amount)
    `)
    .eq('id', claimId)
    .single()

  if (error) throw error
  if (claim.status === 'rejected') {
    throw new Error('Rejected NHIS claims cannot receive payments.')
  }

  const branchMap = claim.branch_id ? {} : await getUserBranchIdsByUserIds([claim.created_by])
  const approvedAmount = Number(claim.total_amount || 0)
  const totalPaid = (claim.nhis_claim_payments || []).reduce(
    (sum, payment) => sum + Number(payment.paid_amount),
    0
  )

  return {
    claimId: claim.id,
    sourceType: 'nhis_claim',
    organizationId: claim.organization_id,
    claimNumber: claim.claim_number,
    insurerName: 'NHIS',
    approvedAmount,
    outstanding: Math.max(0, approvedAmount - totalPaid),
    branchId: claim.branch_id || branchMap[claim.created_by] || null,
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

const getGeneralReceivables = async (branchId = null) => {
  const { data, error } = await supabase
    .from('claims')
    .select(`
      id,
      claim_number,
      claim_status,
      insurance_provider,
      insurance_id,
      total_amount,
      approval_amount,
      service_date,
      patient_name,
      submitted_by,
      branch_id,
      patients (phone, insurance_id),
      claim_payments (id, paid_amount, payment_date)
    `)
    .eq('claim_status', 'approved')
    .order('service_date', { ascending: true })

  if (error) throw error
  return buildGeneralReceivablesRows(data || [], branchId)
}

const getNhisReceivables = async (branchId = null) => {
  let query = supabase
    .from('nhis_claims')
    .select(`
      id,
      branch_id,
      claim_number,
      status,
      total_amount,
      service_date_from,
      surname,
      other_names,
      member_no,
      hin,
      created_by,
      created_at,
      nhis_claim_payments (id, paid_amount, payment_date)
    `)
    .eq('status', 'submitted')
    .order('service_date_from', { ascending: true, nullsFirst: false })

  if (branchId) query = query.eq('branch_id', branchId)

  const { data, error } = await query
  if (error) throw error
  return buildNhisReceivablesRows(data || [], branchId)
}

export const getReceivables = async (branchId = null) => {
  const [generalResult, nhisResult] = await Promise.allSettled([
    getGeneralReceivables(branchId),
    getNhisReceivables(branchId),
  ])

  const receivables = []
  if (generalResult.status === 'fulfilled') receivables.push(...generalResult.value)
  else console.warn('Unable to load insurance receivables:', generalResult.reason)

  if (nhisResult.status === 'fulfilled') receivables.push(...nhisResult.value)
  else console.warn('Unable to load NHIS receivables:', nhisResult.reason)

  return receivables.sort((a, b) => new Date(a.service_date) - new Date(b.service_date))
}

export const recordClaimPayment = async (paymentData) => {
  const isNhisClaim = paymentData.sourceType === 'nhis_claim'
  const claimContext = isNhisClaim
    ? await getNhisClaimPaymentContext(paymentData.claimId)
    : await getClaimPaymentContext(paymentData.claimId)
  const paidAmount = assertNonNegativeNumber(paymentData.paidAmount, 'Paid amount')

  if (paidAmount > claimContext.outstanding) {
    throw new Error('Paid amount cannot exceed the outstanding approved amount.')
  }

  const payload = {
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

  const tableName = isNhisClaim ? 'nhis_claim_payments' : 'claim_payments'
  const insertPayload = isNhisClaim
    ? {
        ...payload,
        organization_id: claimContext.organizationId,
        nhis_claim_id: paymentData.claimId,
      }
    : {
        ...payload,
        claim_id: paymentData.claimId,
      }

  const selectFields = isNhisClaim
    ? '*, nhis_claims(claim_number)'
    : '*, claims(claim_number, insurance_provider)'

  const { data, error } = await supabase
    .from(tableName)
    .insert([insertPayload])
    .select(selectFields)
    .single()

  if (error) throw error

  if (isNhisClaim && paidAmount >= claimContext.outstanding - 0.01) {
    const { error: statusError } = await supabase
      .from('nhis_claims')
      .update({ status: 'paid', updated_at: new Date().toISOString() })
      .eq('id', paymentData.claimId)

    if (statusError) throw statusError
  }

  await tryLogAuditEvent({
    eventType: isNhisClaim ? 'nhis_claim.payment_recorded' : 'claim.payment_recorded',
    entityType: tableName,
    entityId: data.id,
    action: 'create',
    details: {
      claim_id: paymentData.claimId,
      insurer_name: payload.insurer_name,
      paid_amount: payload.paid_amount,
    },
  })

  if (data.payment_method === 'cash' && data.branch_id) {
    try {
      await recordCashbookMovementIfSessionOpen({
        branchId: data.branch_id,
        entryType: 'deposit',
        sourceType: isNhisClaim ? 'nhis_claim_payment' : 'claim_payment',
        sourceId: data.id,
        amount: data.paid_amount,
        direction: 'in',
        description: `${
          isNhisClaim ? 'NHIS claim payment' : 'Claim payment'
        } ${data.claims?.claim_number || data.nhis_claims?.claim_number || claimContext.claimNumber}`,
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
