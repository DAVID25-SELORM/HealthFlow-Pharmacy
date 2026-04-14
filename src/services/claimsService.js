import { supabase } from '../lib/supabase'

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

// Create new claim
export const createClaim = async (claimData) => {
  try {
    // Generate claim number
    const claimNumber = await generateClaimNumber()
    
    // Calculate total amount from items
    const totalAmount = claimData.items?.reduce(
      (sum, item) => sum + (item.price * item.quantity),
      0
    ) || parseFloat(claimData.totalAmount)
    
    // Create claim record
    const { data: claim, error: claimError } = await supabase
      .from('claims')
      .insert([
        {
          claim_number: claimNumber,
          patient_id: claimData.patientId || null,
          patient_name: claimData.patientName,
          insurance_provider: claimData.insuranceProvider,
          insurance_id: claimData.insuranceId,
          service_date: claimData.serviceDate || new Date().toISOString().split('T')[0],
          total_amount: totalAmount,
          claim_status: 'pending',
          prescription_url: claimData.prescriptionUrl,
          notes: claimData.notes,
          submitted_by: claimData.submittedBy,
          submitted_at: new Date().toISOString()
        }
      ])
      .select()
    
    if (claimError) throw claimError
    
    // If items are provided, create claim items
    if (claimData.items && claimData.items.length > 0) {
      const claimItems = claimData.items.map(item => ({
        claim_id: claim[0].id,
        drug_id: item.drugId,
        drug_name: item.name,
        quantity: parseFloat(item.quantity),
        unit_price: parseFloat(item.price),
        total_price: parseFloat(item.price * item.quantity)
      }))
      
      const { error: itemsError } = await supabase
        .from('claim_items')
        .insert(claimItems)
      
      if (itemsError) throw itemsError
    }
    
    return { claim: claim[0], claimNumber }
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
  const { data, error } = await supabase
    .from('claims')
    .select('*')
    .or(`patient_name.ilike.%${searchTerm}%,claim_number.ilike.%${searchTerm}%,insurance_id.ilike.%${searchTerm}%`)
    .order('submitted_at', { ascending: false })
  
  if (error) throw error
  return data
}
