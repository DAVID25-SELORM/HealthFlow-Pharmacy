import {
  assertNonNegativeNumber,
  assertRequiredText,
  normalizeText,
  sanitizeSearchTerm,
} from '../utils/validation'
import { tryLogAuditEvent } from './auditService'
import { invokeTierAccess } from './tierAccessService'

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

export const createClaim = async (claimData) => {
  if (!claimData?.items?.length) {
    throw new Error('At least one claim item is required.')
  }

  const validated = buildValidatedClaimPayload(claimData)
  const response = await invokeTierAccess({
    action: 'create_claim',
    claimData: {
      patientId: claimData.patientId || null,
      patientName: validated.patientName,
      insuranceProvider: validated.insuranceProvider,
      insuranceId: validated.insuranceId,
      serviceDate: claimData.serviceDate || new Date().toISOString().split('T')[0],
      prescriptionUrl: claimData.prescriptionUrl || null,
      notes: normalizeText(claimData.notes) || null,
      items: claimData.items.map((item) => ({
        drugId: item.drugId,
        name: item.name,
        quantity: assertNonNegativeNumber(item.quantity, 'Item quantity'),
        price: assertNonNegativeNumber(item.price, 'Item price'),
      })),
    },
  })

  await tryLogAuditEvent({
    eventType: 'claim.submitted',
    entityType: 'claims',
    entityId: response.claim?.id,
    action: 'create',
    details: {
      claim_number: response.claimNumber,
      insurance_provider: validated.insuranceProvider,
      total_amount: validated.totalAmount,
      item_count: claimData.items.length,
    },
  })

  return response
}

export const getAllClaims = async (filters = {}) => {
  const response = await invokeTierAccess({
    action: 'get_claims',
    filters: {
      status: filters.status,
      insuranceProvider: filters.insuranceProvider,
      startDate: filters.startDate,
      endDate: filters.endDate,
      searchTerm: filters.searchTerm,
      id: filters.id,
      limit: filters.limit,
    },
  })

  return response.claims || []
}

export const getClaimById = async (id) => {
  const claims = await getAllClaims({ id, limit: 1 })
  if (!claims.length) {
    throw new Error('Claim not found.')
  }

  return claims[0]
}

export const updateClaimStatus = async (id, status, additionalData = {}) => {
  let response

  if (status === 'approved') {
    response = await invokeTierAccess({
      action: 'approve_claim',
      id,
      approvalAmount: additionalData.approval_amount,
    })
  } else if (status === 'rejected') {
    response = await invokeTierAccess({
      action: 'reject_claim',
      id,
      rejectionReason: additionalData.rejection_reason,
    })
  } else {
    throw new Error('Unsupported claim status update.')
  }

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

  return response.claim
}

export const approveClaim = async (id, approvalAmount) =>
  updateClaimStatus(id, 'approved', {
    approval_amount: parseFloat(approvalAmount),
  })

export const rejectClaim = async (id, rejectionReason) =>
  updateClaimStatus(id, 'rejected', {
    rejection_reason: rejectionReason,
  })

export const getClaimsStatistics = async () =>
  await invokeTierAccess({
    action: 'get_claims_statistics',
  })

export const getRecentClaims = async (limit = 10) => {
  const response = await invokeTierAccess({
    action: 'get_recent_claims',
    limit,
  })

  return response.claims || []
}

export const searchClaims = async (searchTerm) => {
  const term = sanitizeSearchTerm(searchTerm)
  if (!term) {
    return getAllClaims()
  }

  return getAllClaims({ searchTerm: term })
}
