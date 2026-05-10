import { createId, db, json, nowIso } from './db.js'
import { config } from './config.js'

const toMoney = (value, fallback = 0) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.round(parsed * 100) / 100
}

const assertRequiredText = (value, label) => {
  const normalized = String(value || '').trim()
  if (!normalized) {
    throw new Error(`${label} is required.`)
  }

  return normalized
}

const assertPositiveQuantity = (value, label) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be greater than zero.`)
  }

  return parsed
}

const createClaimNumber = () => {
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, '')
  const randomPart = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `BCL-${datePart}-${randomPart}`
}

const insertClaim = db.prepare(`
  INSERT INTO claims (
    id, claim_number, linked_local_sale_id, linked_local_sale_number,
    patient_id, patient_name, insurance_provider, insurance_id, service_date,
    total_amount, claim_status, prescription_url, notes, submitted_by,
    organization_id, branch_id, submitted_at, created_at, sync_status
  )
  VALUES (
    @id, @claimNumber, @linkedLocalSaleId, @linkedLocalSaleNumber,
    @patientId, @patientName, @insuranceProvider, @insuranceId, @serviceDate,
    @totalAmount, 'pending', @prescriptionUrl, @notes, @submittedBy,
    @organizationId, @branchId, @submittedAt, @createdAt, 'pending'
  )
`)

const insertClaimItem = db.prepare(`
  INSERT INTO claim_items (
    id, claim_id, drug_id, drug_name, quantity, unit_price, total_price, created_at
  )
  VALUES (
    @id, @claimId, @drugId, @drugName, @quantity, @unitPrice, @totalPrice, @createdAt
  )
`)

const insertOutbox = db.prepare(`
  INSERT INTO sync_outbox (
    id, event_type, entity_type, entity_id, payload_json, status, created_at, updated_at
  )
  VALUES (
    @id, @eventType, @entityType, @entityId, @payloadJson, 'pending', @createdAt, @updatedAt
  )
`)

export const createLocalClaim = db.transaction((claimData, linkedSale = {}) => {
  if (!Array.isArray(claimData?.items) || claimData.items.length === 0) {
    throw new Error('At least one claim item is required.')
  }

  const createdAt = nowIso()
  const claimId = createId()
  const claimNumber = claimData.claimNumber || createClaimNumber()
  let totalAmount = 0

  const items = claimData.items.map((item) => {
    const drugId = item.drugId || item.id
    if (!drugId) {
      throw new Error('Each claim item must include a drugId.')
    }

    const quantity = assertPositiveQuantity(item.quantity, 'Claim item quantity')
    const unitPrice = toMoney(item.price ?? item.unitPrice, 0)
    if (unitPrice < 0) {
      throw new Error('Claim item price cannot be negative.')
    }

    const totalPrice = toMoney(quantity * unitPrice)
    totalAmount = toMoney(totalAmount + totalPrice)

    return {
      id: createId(),
      claimId,
      drugId,
      drugName: assertRequiredText(item.name, 'Claim item name'),
      quantity,
      unitPrice,
      totalPrice,
      createdAt,
    }
  })

  const claim = {
    id: claimId,
    claimNumber,
    linkedLocalSaleId: linkedSale.id || null,
    linkedLocalSaleNumber: linkedSale.saleNumber || null,
    patientId: claimData.patientId || null,
    patientName: assertRequiredText(claimData.patientName, 'Patient name'),
    insuranceProvider: assertRequiredText(claimData.insuranceProvider, 'Insurance provider'),
    insuranceId: assertRequiredText(claimData.insuranceId, 'Insurance ID'),
    serviceDate: claimData.serviceDate || createdAt.slice(0, 10),
    totalAmount,
    prescriptionUrl: claimData.prescriptionUrl || null,
    notes: claimData.notes || null,
    submittedBy: claimData.submittedBy || null,
    organizationId: claimData.organizationId || linkedSale.organizationId || config.organizationId,
    branchId: claimData.branchId || linkedSale.branchId || config.branchId,
    submittedAt: claimData.submittedAt || createdAt,
    createdAt,
  }

  insertClaim.run(claim)
  for (const item of items) {
    insertClaimItem.run(item)
  }

  const syncPayload = {
    local_claim_id: claimId,
    local_claim_number: claimNumber,
    linked_local_sale_id: claim.linkedLocalSaleId,
    linked_local_sale_number: claim.linkedLocalSaleNumber,
    claim_payload: {
      patient_id: claim.patientId,
      patient_name: claim.patientName,
      insurance_provider: claim.insuranceProvider,
      insurance_id: claim.insuranceId,
      service_date: claim.serviceDate,
      claim_status: 'pending',
      prescription_url: claim.prescriptionUrl,
      notes: claim.notes
        ? `${claim.notes}\nLocal claim reference: ${claimNumber}`
        : `Local claim reference: ${claimNumber}`,
      submitted_by: claim.submittedBy,
      submitted_at: claim.submittedAt,
      organization_id: claim.organizationId,
      branch_id: claim.branchId,
      items: items.map((item) => ({
        drugId: item.drugId,
        name: item.drugName,
        quantity: item.quantity,
        price: item.unitPrice,
      })),
    },
  }

  insertOutbox.run({
    id: createId(),
    eventType: 'claim.submitted',
    entityType: 'claims',
    entityId: claimId,
    payloadJson: json(syncPayload),
    createdAt,
    updatedAt: createdAt,
  })

  return {
    claim: { ...claim, items },
    claimNumber,
  }
})
