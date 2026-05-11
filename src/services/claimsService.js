import {
  assertNonNegativeNumber,
  assertRequiredText,
  normalizeText,
  sanitizeSearchTerm,
} from '../utils/validation'
import { tryLogAuditEvent } from './auditService'
import {
  createBranchRecord,
  listBranchRecords,
  shouldUseBranchServer,
  updateBranchRecord,
} from './branchServerApi'
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
  if (shouldUseBranchServer()) {
    const claim = await createBranchRecord('claims', {
      patient_id: claimData.patientId || null,
      patient_name: validated.patientName,
      insurance_provider: validated.insuranceProvider,
      insurance_id: validated.insuranceId,
      service_date: claimData.serviceDate || new Date().toISOString().split('T')[0],
      total_amount: validated.totalAmount,
      prescription_url: claimData.prescriptionUrl || null,
      notes: normalizeText(claimData.notes) || null,
      branch_id: normalizeText(claimData.branchId) || null,
      claim_items: claimData.items.map((item) => ({
        drug_id: item.drugId,
        drug_name: item.name,
        quantity: assertNonNegativeNumber(item.quantity, 'Item quantity'),
        unit_price: assertNonNegativeNumber(item.price, 'Item price'),
        total_price:
          assertNonNegativeNumber(item.quantity, 'Item quantity') *
          assertNonNegativeNumber(item.price, 'Item price'),
      })),
    })

    return {
      claim,
      claimNumber: claim.claim_number,
    }
  }

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
      branchId: normalizeText(claimData.branchId) || null,
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
  if (shouldUseBranchServer()) {
    return await listBranchRecords('claims', filters)
  }

  const response = await invokeTierAccess({
    action: 'get_claims',
    filters: {
      status: filters.status,
      insuranceProvider: filters.insuranceProvider,
      startDate: filters.startDate,
      endDate: filters.endDate,
      searchTerm: filters.searchTerm,
      branchId: filters.branchId,
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
  if (shouldUseBranchServer()) {
    return await updateBranchRecord('claims', id, {
      claim_status: status,
      status,
      approval_amount: additionalData.approval_amount ?? null,
      rejection_reason: additionalData.rejection_reason || null,
    })
  }

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
  shouldUseBranchServer()
    ? (() => {
        return getAllClaims().then((claims) => ({
          total: claims.length,
          pending: claims.filter((claim) => (claim.claim_status || claim.status) === 'pending').length,
          approved: claims.filter((claim) => (claim.claim_status || claim.status) === 'approved').length,
          rejected: claims.filter((claim) => (claim.claim_status || claim.status) === 'rejected').length,
        }))
      })()
    : await invokeTierAccess({
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
