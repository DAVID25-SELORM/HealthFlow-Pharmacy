import {
  assertNonNegativeNumber,
  assertRequiredText,
  normalizeText,
  sanitizeSearchTerm,
} from '../utils/validation'
import { tryLogAuditEvent } from './auditService'
import {
  createBranchRecord,
  getBranchInventory,
  listBranchRecords,
  updateBranchRecord,
  submitNhisPharmacyClaim as branchSubmitNhisPharmacyClaim,
} from './branchServerApi'
import { routeRead, routeWrite } from './apiRouter'
import { invokeTierAccess } from './tierAccessService'
import { normalizePatientWorkspaceData } from './patientService'
import { getConnectivityState } from './connectivityService'

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
  const localCreate = async () => {
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

  const cloudCreate = async () => {
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

  return await routeWrite({
    label: 'claim',
    local: localCreate,
    cloud: cloudCreate,
  })
}

export const updateClaim = async (id, claimData) => {
  if (!claimData?.items?.length) {
    throw new Error('At least one claim item is required.')
  }

  const validated = buildValidatedClaimPayload(claimData)
  const normalizedItems = claimData.items.map((item) => ({
    drugId: item.drugId,
    name: item.name,
    quantity: assertNonNegativeNumber(item.quantity, 'Item quantity'),
    price: assertNonNegativeNumber(item.price, 'Item price'),
  }))

  const localUpdate = async () => {
    const claim = await updateBranchRecord('claims', id, {
      patient_id: claimData.patientId || null,
      patient_name: validated.patientName,
      insurance_provider: validated.insuranceProvider,
      insurance_id: validated.insuranceId,
      service_date: claimData.serviceDate || new Date().toISOString().split('T')[0],
      total_amount: validated.totalAmount,
      prescription_url: claimData.prescriptionUrl || null,
      notes: normalizeText(claimData.notes) || null,
      branch_id: normalizeText(claimData.branchId) || null,
      claim_items: normalizedItems.map((item) => ({
        drug_id: item.drugId,
        drug_name: item.name,
        quantity: item.quantity,
        unit_price: item.price,
        total_price: item.quantity * item.price,
      })),
    })

    return {
      claim,
      claimNumber: claim.claim_number,
    }
  }

  const cloudUpdate = async () => {
    const response = await invokeTierAccess({
      action: 'update_claim',
      id,
      claimData: {
        patientId: claimData.patientId || null,
        patientName: validated.patientName,
        insuranceProvider: validated.insuranceProvider,
        insuranceId: validated.insuranceId,
        serviceDate: claimData.serviceDate || new Date().toISOString().split('T')[0],
        prescriptionUrl: claimData.prescriptionUrl || null,
        notes: normalizeText(claimData.notes) || null,
        branchId: normalizeText(claimData.branchId) || null,
        items: normalizedItems,
      },
    })

    await tryLogAuditEvent({
      eventType: 'claim.corrected',
      entityType: 'claims',
      entityId: id,
      action: 'update',
      details: {
        claim_number: response.claim?.claim_number,
        insurance_provider: validated.insuranceProvider,
        total_amount: validated.totalAmount,
        item_count: normalizedItems.length,
      },
    })

    return response
  }

  return await routeWrite({
    label: 'claim update',
    local: localUpdate,
    cloud: cloudUpdate,
  })
}

export const getAllClaims = async (filters = {}) => {
  return await routeRead({
    label: 'claims',
    local: async () => await listBranchRecords('claims', filters),
    cloud: async () => {
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
    },
    fallback: [],
  })
}

const getClaimsStatisticsFromRows = (claims = []) => ({
  total: claims.length,
  pending: claims.filter((claim) => (claim.claim_status || claim.status) === 'pending').length,
  approved: claims.filter((claim) => (claim.claim_status || claim.status) === 'approved').length,
  rejected: claims.filter((claim) => (claim.claim_status || claim.status) === 'rejected').length,
})

export const getClaimsWorkspace = async () =>
  await routeRead({
    label: 'claims workspace',
    local: async () => {
      const [claims, patients, nhisClaims, drugs] = await Promise.all([
        listBranchRecords('claims', { limit: 5000 }),
        listBranchRecords('patients', { limit: 5000 }),
        Promise.resolve(listBranchRecords('nhis/claims', { limit: 5000 })).catch(() => []),
        getBranchInventory({ limit: 20000 }),
      ])
      const localPatients = normalizePatientWorkspaceData({ patients, nhisClaims })
      let workspacePatients = localPatients

      if (!localPatients.length && getConnectivityState().internetAvailable !== false) {
        try {
          const cloudPatientData = await invokeTierAccess({ action: 'get_patients_workspace' })
          workspacePatients = normalizePatientWorkspaceData(cloudPatientData)
        } catch {
          workspacePatients = localPatients
        }
      }

      return {
        claims,
        statistics: getClaimsStatisticsFromRows(claims),
        patients: workspacePatients,
        drugs,
      }
    },
    cloud: async () => {
      const response = await invokeTierAccess({ action: 'get_claims_workspace' })
      return {
        claims: response.claims || [],
        statistics: response.statistics || getClaimsStatisticsFromRows(response.claims || []),
        patients: normalizePatientWorkspaceData(response),
        drugs: response.drugs || [],
      }
    },
    fallback: {
      claims: [],
      statistics: getClaimsStatisticsFromRows([]),
      patients: [],
      drugs: [],
    },
  })

export const getClaimById = async (id) => {
  const claims = await getAllClaims({ id, limit: 1 })
  if (!claims.length) {
    throw new Error('Claim not found.')
  }

  return claims[0]
}

export const updateClaimStatus = async (id, status, additionalData = {}) => {
  const localUpdate = async () =>
    await updateBranchRecord('claims', id, {
      claim_status: status,
      status,
      approval_amount: additionalData.approval_amount ?? null,
      rejection_reason: additionalData.rejection_reason || null,
    })

  const cloudUpdate = async () => {
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

  return await routeWrite({
    label: 'claim status',
    local: localUpdate,
    cloud: cloudUpdate,
  })
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
  await routeRead({
    label: 'claim statistics',
    local: async () => {
      const claims = await getAllClaims()
      return {
        total: claims.length,
        pending: claims.filter((claim) => (claim.claim_status || claim.status) === 'pending').length,
        approved: claims.filter((claim) => (claim.claim_status || claim.status) === 'approved').length,
        rejected: claims.filter((claim) => (claim.claim_status || claim.status) === 'rejected').length,
      }
    },
    cloud: async () => await invokeTierAccess({
        action: 'get_claims_statistics',
      }),
    fallback: { total: 0, pending: 0, approved: 0, rejected: 0 },
  })

export const getRecentClaims = async (limit = 10) => {
  return await routeRead({
    label: 'recent claims',
    local: async () => (await listBranchRecords('claims', { limit })).slice(0, limit),
    cloud: async () => {
      const response = await invokeTierAccess({
        action: 'get_recent_claims',
        limit,
      })

      return response.claims || []
    },
    fallback: [],
  })
}

export const searchClaims = async (searchTerm) => {
  const term = sanitizeSearchTerm(searchTerm)
  if (!term) {
    return getAllClaims()
  }

  return getAllClaims({ searchTerm: term })
}

// Unified NHIS pharmacy claim: generates CC code (if absent), saves, and submits to CLAIM-it.
// On the local path the branch server handles CC generation and submission directly.
// On the cloud path the claim is sent to the NHIA tier-access function for Supabase persistence and CLAIM-it forwarding.
export const submitNhisPharmacyClaim = async (claimData) => {
  assertRequiredText(claimData?.patientName, 'Patient name')
  assertRequiredText(claimData?.memberNumber, 'Member number')
  const isHospitalClaim = (claimData?.organizationType || '').toLowerCase() === 'hospital'
  if (isHospitalClaim) assertRequiredText(claimData?.diagnosis, 'Diagnosis')
  if (!claimData?.medicines?.length) {
    throw new Error('At least one medicine is required.')
  }

  const local = async () => {
    const result = await branchSubmitNhisPharmacyClaim(claimData)
    await tryLogAuditEvent({
      eventType: 'nhis_claim.submitted',
      entityType: 'nhia_claims',
      entityId: result?.id,
      action: 'create',
      details: {
        claim_number: result?.claim_number,
        member_number: claimData.memberNumber,
        total_amount: result?.total_amount,
        medicine_count: claimData.medicines.length,
      },
    })
    return result
  }

  const cloud = async () => {
    const response = await invokeTierAccess({
      action: 'submit_nhis_pharmacy_claim',
      claimData,
    })
    await tryLogAuditEvent({
      eventType: 'nhis_claim.submitted',
      entityType: 'nhis_claims',
      entityId: response?.claim?.id,
      action: 'create',
      details: {
        claim_number: response?.claim?.claim_number,
        member_number: claimData.memberNumber,
        total_amount: response?.claim?.total_amount,
        medicine_count: claimData.medicines.length,
      },
    })
    return response?.claim || response
  }

  return await routeWrite({ label: 'NHIS pharmacy claim', local, cloud })
}
