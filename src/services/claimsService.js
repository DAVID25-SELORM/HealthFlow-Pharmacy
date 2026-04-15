import { supabase } from '../lib/supabase'
import {
  assertNonNegativeNumber,
  assertRequiredText,
  normalizeText,
  sanitizeSearchTerm,
} from '../utils/validation'
import { tryLogAuditEvent } from './auditService'

/**
 * Claims Service
 * Handles all insurance claims operations
 */

// Generate claim number
const generateClaimNumber = async () => {
  const { data, error } = await supabase.rpc('generate_claim_number')
  
  if (error) {
    // Fallback if function doesn't exist
    const timestamp = Date.now()
    return `CLM-${timestamp.toString().slice(-8)}`
  }
  
  return data
}

const buildValidatedClaimPayload = (claimData) => {
  const patientName = assertRequiredText(claimData.patientName, 'Patient name')
  const insuranceProvider = assertRequiredText(claimData.insuranceProvider, 'Insurance provider')
  const insuranceId = assertRequiredText(claimData.insuranceId, 'Insurance ID')

  const totalAmount =
    claimData.items?.reduce((sum, item) => {
      const quantity = assertNonNegativeNumber(item.quantity, 'Item quantity')
      const price = assertNonNegativeNumber(item.price, 'Item price')
      return sum + (price * quantity)
    }, 0) || assertNonNegativeNumber(claimData.totalAmount, 'Total amount')

  return {
    patientName,
    insuranceProvider,
    insuranceId,
    totalAmount,
  }
}

const createClaimLegacy = async (claimData) => {
  const claimNumber = await generateClaimNumber()
  const validated = buildValidatedClaimPayload(claimData)

  const { data: claim, error: claimError } = await supabase
    .from('claims')
    .insert([
      {
        claim_number: claimNumber,
        patient_id: claimData.patientId || null,
        patient_name: validated.patientName,
        insurance_provider: validated.insuranceProvider,
        insurance_id: validated.insuranceId,
        service_date: claimData.serviceDate || new Date().toISOString().split('T')[0],
        total_amount: validated.totalAmount,
        claim_status: 'pending',
        prescription_url: claimData.prescriptionUrl,
        notes: normalizeText(claimData.notes) || null,
        submitted_by: claimData.submittedBy,
        submitted_at: new Date().toISOString(),
      },
    ])
    .select()

  if (claimError) throw claimError

  if (claimData.items && claimData.items.length > 0) {
    const claimItems = claimData.items.map((item) => ({
      claim_id: claim[0].id,
      drug_id: item.drugId,
      drug_name: item.name,
      quantity: assertNonNegativeNumber(item.quantity, 'Item quantity'),
      unit_price: assertNonNegativeNumber(item.price, 'Item price'),
      total_price:
        assertNonNegativeNumber(item.price, 'Item price') *
        assertNonNegativeNumber(item.quantity, 'Item quantity'),
    }))

    const { error: itemsError } = await supabase.from('claim_items').insert(claimItems)
    if (itemsError) throw itemsError
  }

  await tryLogAuditEvent({
    eventType: 'claim.submitted',
    entityType: 'claims',
    entityId: claim[0].id,
    action: 'create',
    details: {
      claim_number: claim[0].claim_number,
      insurance_provider: validated.insuranceProvider,
      total_amount: validated.totalAmount,
      item_count: claimData.items?.length || 0,
    },
  })

  return { claim: claim[0], claimNumber: claim[0].claim_number }
}

// Create new claim
export const createClaim = async (claimData) => {
  try {
    if (!claimData?.items?.length) {
      throw new Error('At least one claim item is required.')
    }

    const validated = buildValidatedClaimPayload(claimData)

    const { data: txData, error: txError } = await supabase.rpc('create_claim_transaction', {
      claim_payload: {
        patient_id: claimData.patientId || null,
        patient_name: validated.patientName,
        insurance_provider: validated.insuranceProvider,
        insurance_id: validated.insuranceId,
        service_date: claimData.serviceDate || new Date().toISOString().split('T')[0],
        claim_status: 'pending',
        prescription_url: claimData.prescriptionUrl || null,
        notes: normalizeText(claimData.notes) || null,
        submitted_by: claimData.submittedBy || null,
        submitted_at: new Date().toISOString(),
        items: claimData.items.map((item) => ({
          drugId: item.drugId,
          name: item.name,
          quantity: assertNonNegativeNumber(item.quantity, 'Item quantity'),
          price: assertNonNegativeNumber(item.price, 'Item price'),
        })),
      },
    })

    if (txError) {
      console.warn('create_claim_transaction RPC unavailable, falling back to legacy path:', txError.message)
      return createClaimLegacy(claimData)
    }

    const txPayload = txData || {}

    await tryLogAuditEvent({
      eventType: 'claim.submitted',
      entityType: 'claims',
      entityId: txPayload.claim_id,
      action: 'create',
      details: {
        claim_number: txPayload.claim_number,
        insurance_provider: validated.insuranceProvider,
        total_amount: validated.totalAmount,
        item_count: claimData.items.length,
      },
    })

    return {
      claim: {
        id: txPayload.claim_id,
        claim_number: txPayload.claim_number,
      },
      claimNumber: txPayload.claim_number,
    }
  } catch (error) {
    console.error('Error creating claim:', error)
    throw error
  }
}

// Get all claims
export const getAllClaims = async (filters = {}) => {
  let query = supabase
    .from('claims')
    .select(`
      *,
      claim_items (*),
      patients (full_name, phone, insurance_provider),
      users:submitted_by (full_name)
    `)
    .order('submitted_at', { ascending: false })
  
  // Apply filters
  if (filters.status) {
    query = query.eq('claim_status', filters.status)
  }
  
  if (filters.insuranceProvider) {
    query = query.eq('insurance_provider', filters.insuranceProvider)
  }
  
  if (filters.startDate) {
    query = query.gte('service_date', filters.startDate)
  }
  
  if (filters.endDate) {
    query = query.lte('service_date', filters.endDate)
  }
  
  const { data, error } = await query
  
  if (error) throw error
  return data
}

// Get claim by ID
export const getClaimById = async (id) => {
  const { data, error } = await supabase
    .from('claims')
    .select(`
      *,
      claim_items (*),
      patients (*),
      users:submitted_by (full_name)
    `)
    .eq('id', id)
    .single()
  
  if (error) throw error
  return data
}

// Update claim status
export const updateClaimStatus = async (id, status, additionalData = {}) => {
  const updateData = {
    claim_status: status,
    processed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...additionalData
  }
  
  const { data, error } = await supabase
    .from('claims')
    .update(updateData)
    .eq('id', id)
    .select()
  
  if (error) throw error

  await tryLogAuditEvent({
    eventType: 'claim.status_updated',
    entityType: 'claims',
    entityId: id,
    action: 'update_status',
    details: {
      status,
      ...additionalData,
    },
  })

  return data[0]
}

// Approve claim
export const approveClaim = async (id, approvalAmount) => {
  return updateClaimStatus(id, 'approved', {
    approval_amount: parseFloat(approvalAmount)
  })
}

// Reject claim
export const rejectClaim = async (id, rejectionReason) => {
  return updateClaimStatus(id, 'rejected', {
    rejection_reason: rejectionReason
  })
}

// Get claims statistics
export const getClaimsStatistics = async () => {
  const { data, error } = await supabase
    .from('claims')
    .select('claim_status, total_amount')
  
  if (error) throw error
  
  const stats = {
    total: data.length,
    pending: data.filter(c => c.claim_status === 'pending').length,
    approved: data.filter(c => c.claim_status === 'approved').length,
    rejected: data.filter(c => c.claim_status === 'rejected').length,
    processing: data.filter(c => c.claim_status === 'processing').length,
    totalAmount: data.reduce((sum, c) => sum + parseFloat(c.total_amount), 0),
    approvedAmount: data
      .filter(c => c.claim_status === 'approved')
      .reduce((sum, c) => sum + parseFloat(c.total_amount), 0)
  }
  
  return stats
}

// Get recent claims
export const getRecentClaims = async (limit = 10) => {
  const { data, error } = await supabase
    .from('claims')
    .select('*')
    .order('submitted_at', { ascending: false })
    .limit(limit)
  
  if (error) throw error
  return data
}

// Search claims
export const searchClaims = async (searchTerm) => {
  const term = sanitizeSearchTerm(searchTerm)
  if (!term) {
    return getAllClaims()
  }

  const { data, error } = await supabase
    .from('claims')
    .select('*')
    .or(`patient_name.ilike.%${term}%,claim_number.ilike.%${term}%,insurance_id.ilike.%${term}%`)
    .order('submitted_at', { ascending: false })
  
  if (error) throw error
  return data
}
