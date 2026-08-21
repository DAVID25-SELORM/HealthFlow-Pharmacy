import { createId, db, json, nowIso } from './db.js'
import { config } from './config.js'

const VALID_PAYMENT_METHODS = new Set(['cash', 'momo', 'insurance', 'nhia', 'card'])

const toMoney = (value, fallback = 0) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.round(parsed * 100) / 100
}

const assertPositiveQuantity = (value, label) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be greater than zero.`)
  }

  return parsed
}

const createSaleNumber = () => {
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, '')
  const randomPart = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `BR-${datePart}-${randomPart}`
}

const getDrugForUpdate = db.prepare('SELECT * FROM drugs WHERE id = ?')
const getOpenPosSessionForUser = db.prepare(`
  SELECT * FROM local_pos_sessions
  WHERE user_id = ? AND status = 'open'
  ORDER BY opened_at DESC
  LIMIT 1
`)
const getOpenPosSessionById = db.prepare(`
  SELECT * FROM local_pos_sessions
  WHERE id = ? AND user_id = ? AND branch_id = ? AND status = 'open'
`)
const insertPosSession = db.prepare(`
  INSERT INTO local_pos_sessions (
    id, user_id, organization_id, branch_id, opening_cash,
    expected_cash, status, opened_at
  ) VALUES (
    @id, @userId, @organizationId, @branchId, @openingCash,
    @openingCash, 'open', @openedAt
  )
`)
const closePosSession = db.prepare(`
  UPDATE local_pos_sessions
  SET status = 'closed', counted_cash = @countedCash, notes = @notes, closed_at = @closedAt
  WHERE id = @id AND user_id = @userId AND status = 'open'
`)

const insertSale = db.prepare(`
  INSERT INTO sales (
    id, sale_number, patient_id, total_amount, discount, net_amount,
    payment_method, payment_status, amount_paid, change_given, notes,
    sold_by, shift_id, organization_id, branch_id, sale_date, created_at, sync_status,
    insurance_covered_amount, insurance_top_up_amount, insurance_top_up_payment_method,
    nhis_covered_amount, nhis_top_up_amount, private_non_nhis_amount,
    nhis_policy_adjustment_amount, nhis_top_up_policy, patient_payment_method
  )
  VALUES (
    @id, @saleNumber, @patientId, @totalAmount, @discount, @netAmount,
    @paymentMethod, @paymentStatus, @amountPaid, @changeGiven, @notes,
    @soldBy, @shiftId, @organizationId, @branchId, @saleDate, @createdAt, @syncStatus
    , @insuranceCoveredAmount, @insuranceTopUpAmount, @insuranceTopUpPaymentMethod
    , @nhisCoveredAmount, @nhisTopUpAmount, @privateNonNhisAmount
    , @nhisPolicyAdjustmentAmount, @nhisTopUpPolicy, @patientPaymentMethod
  )
`)

const insertSaleItem = db.prepare(`
  INSERT INTO sale_items (
    id, sale_id, drug_id, drug_name, quantity, unit_price, total_price, created_at,
    nhis_settlement, nhis_covered_amount, patient_top_up_amount, private_amount, policy_adjustment_amount
  )
  VALUES (
    @id, @saleId, @drugId, @drugName, @quantity, @unitPrice, @totalPrice, @createdAt,
    @nhisSettlement, @nhisCoveredAmount, @patientTopUpAmount, @privateAmount, @policyAdjustmentAmount
  )
`)

const updateDrugQuantity = db.prepare(`
  UPDATE drugs
  SET quantity = ?, updated_at = ?, sync_status = 'pending'
  WHERE id = ?
`)

const insertStockMovement = db.prepare(`
  INSERT INTO stock_movements (
    id, drug_id, movement_type, quantity, previous_quantity, new_quantity,
    reference_id, notes, created_by, created_at, sync_status
  )
  VALUES (
    @id, @drugId, 'sale', @quantity, @previousQuantity, @newQuantity,
    @referenceId, @notes, @createdBy, @createdAt, 'pending'
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

const selectSaleById = db.prepare('SELECT * FROM sales WHERE id = ?')

const updateSalePaid = db.prepare(`
  UPDATE sales
  SET payment_status = 'completed',
      amount_paid = net_amount,
      change_given = 0,
      notes = ?,
      sync_status = 'pending',
      last_sync_error = NULL
  WHERE id = ?
`)

const selectSaleCompletedOutbox = db.prepare(`
  SELECT id
  FROM sync_outbox
  WHERE entity_type = 'sales'
    AND entity_id = ?
    AND event_type = 'sale.completed'
  LIMIT 1
`)

const getRecentSalesStatement = db.prepare(`
  SELECT *
  FROM sales
  ORDER BY sale_date DESC
  LIMIT ?
`)

const getSaleItemsStatement = db.prepare(`
  SELECT *
  FROM sale_items
  WHERE sale_id = ?
  ORDER BY created_at ASC
`)

const normalizeSaleRow = (row) => row
  ? {
      id: row.id,
      saleNumber: row.sale_number,
      patientId: row.patient_id,
      totalAmount: row.total_amount,
      discount: row.discount,
      netAmount: row.net_amount,
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      amountPaid: row.amount_paid,
      changeGiven: row.change_given,
      insuranceCoveredAmount: row.insurance_covered_amount,
      insuranceTopUpAmount: row.insurance_top_up_amount,
      insuranceTopUpPaymentMethod: row.insurance_top_up_payment_method,
      nhisCoveredAmount: row.nhis_covered_amount,
      nhisTopUpAmount: row.nhis_top_up_amount,
      privateNonNhisAmount: row.private_non_nhis_amount,
      nhisPolicyAdjustmentAmount: row.nhis_policy_adjustment_amount,
      nhisTopUpPolicy: row.nhis_top_up_policy,
      patientPaymentMethod: row.patient_payment_method,
      notes: row.notes,
      soldBy: row.sold_by,
      shiftId: row.shift_id,
      organizationId: row.organization_id,
      branchId: row.branch_id,
      saleDate: row.sale_date,
      createdAt: row.created_at,
      syncStatus: row.sync_status,
      items: getSaleItemsStatement.all(row.id),
    }
  : null

const buildSaleSyncPayload = ({ sale, items, paymentReference = '' }) => {
  const notes = [sale.notes, paymentReference ? `Payment reference: ${paymentReference}` : '']
    .filter(Boolean)
    .join('\n')

  return {
    local_sale_id: sale.id,
    local_sale_number: sale.saleNumber,
    sale_payload: {
      patient_id: sale.patientId,
      payment_method: sale.paymentMethod === 'nhia' ? 'insurance' : sale.paymentMethod,
      payment_status: 'completed',
      amount_paid: sale.netAmount,
      change_given: sale.paymentMethod === 'cash' ? sale.changeGiven || 0 : 0,
      notes: notes ? `${notes}\nLocal reference: ${sale.saleNumber}` : `Local reference: ${sale.saleNumber}`,
      sold_by: sale.soldBy,
      sale_date: sale.saleDate,
      discount: sale.discount,
      shift_id: null,
      insurance_covered_amount: sale.insuranceCoveredAmount || 0,
      insurance_top_up_amount: sale.insuranceTopUpAmount || 0,
      insurance_top_up_payment_method: sale.insuranceTopUpPaymentMethod || null,
      nhis_covered_amount: sale.nhisCoveredAmount || 0,
      nhis_top_up_amount: sale.nhisTopUpAmount || 0,
      private_non_nhis_amount: sale.privateNonNhisAmount || 0,
      nhis_policy_adjustment_amount: sale.nhisPolicyAdjustmentAmount || 0,
      nhis_top_up_policy: sale.nhisTopUpPolicy || null,
      patient_payment_method: sale.patientPaymentMethod || null,
      organization_id: sale.organizationId,
      branch_id: sale.branchId,
      items: items.map((item) => ({
        drugId: item.drug_id || item.drugId,
        name: item.drug_name || item.drugName,
        quantity: item.quantity,
        price: item.unit_price ?? item.unitPrice,
        nhis_settlement: item.nhis_settlement ?? item.nhisSettlement ?? null,
        nhis_covered_amount: item.nhis_covered_amount ?? item.nhisCoveredAmount ?? 0,
        patient_top_up_amount: item.patient_top_up_amount ?? item.patientTopUpAmount ?? 0,
        private_amount: item.private_amount ?? item.privateAmount ?? 0,
        policy_adjustment_amount: item.policy_adjustment_amount ?? item.policyAdjustmentAmount ?? 0,
      })),
    },
  }
}

const toPublicPosSession = (row) => row
  ? {
      id: row.id,
      userId: row.user_id,
      organizationId: row.organization_id,
      branchId: row.branch_id,
      openingCash: Number(row.opening_cash || 0),
      expectedCash: Number(row.expected_cash || 0),
      status: row.status,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
    }
  : null

export const getOpenLocalPosSession = ({ userId }) =>
  toPublicPosSession(getOpenPosSessionForUser.get(String(userId || '').trim()))

export const openLocalPosSession = ({ userId, organizationId, branchId, openingCash = 0 }) => {
  const normalizedUserId = String(userId || '').trim()
  const normalizedBranchId = String(branchId || '').trim()
  if (!normalizedUserId || !normalizedBranchId) {
    throw new Error('A user and branch are required to open a POS shift.')
  }

  const existing = getOpenPosSessionForUser.get(normalizedUserId)
  if (existing) return toPublicPosSession(existing)

  const session = {
    id: createId(),
    userId: normalizedUserId,
    organizationId: String(organizationId || config.organizationId || '').trim() || null,
    branchId: normalizedBranchId,
    openingCash: toMoney(openingCash, 0),
    openedAt: nowIso(),
  }
  if (session.openingCash < 0) {
    throw new Error('Opening cash cannot be negative.')
  }
  insertPosSession.run(session)
  return toPublicPosSession(getOpenPosSessionForUser.get(normalizedUserId))
}

export const closeLocalPosSession = ({ id, userId, countedCash = 0, notes = '' }) => {
  const result = closePosSession.run({
    id: String(id || '').trim(),
    userId: String(userId || '').trim(),
    countedCash: toMoney(countedCash, 0),
    notes: String(notes || '').trim() || null,
    closedAt: nowIso(),
  })
  if (result.changes !== 1) {
    throw new Error('Open POS shift not found for this user.')
  }
  return { id, status: 'closed' }
}

export const createLocalSale = db.transaction((saleData) => {
  if (!Array.isArray(saleData?.items) || saleData.items.length === 0) {
    throw new Error('At least one sale item is required.')
  }

  const paymentMethod = String(saleData.paymentMethod || '').trim().toLowerCase()
  if (!VALID_PAYMENT_METHODS.has(paymentMethod)) {
    throw new Error('Payment method must be cash, momo, insurance, nhia, or card.')
  }
  const syncPaymentMethod = paymentMethod === 'nhia' ? 'insurance' : paymentMethod
  const isInsuranceLikePayment = paymentMethod === 'insurance' || paymentMethod === 'nhia'
  const paymentStatus =
    String(saleData.paymentStatus || '').trim().toLowerCase() === 'pending_payment'
      ? 'pending_payment'
      : 'completed'

  const soldBy = String(saleData.soldBy || '').trim()
  const branchId = String(saleData.branchId || config.branchId || '').trim()
  const shiftId = String(saleData.shiftId || '').trim()
  if (!soldBy || !branchId || !shiftId) {
    throw new Error('Open a POS shift before completing sales.')
  }
  if (!getOpenPosSessionById.get(shiftId, soldBy, branchId)) {
    throw new Error('The POS shift is not open for this user and branch.')
  }

  const createdAt = nowIso()
  const saleId = createId()
  const saleNumber = saleData.saleNumber || createSaleNumber()
  const discount = toMoney(saleData.discount, 0)
  const settlementByDrugId = new Map(
    (Array.isArray(saleData.nhisSettlementLines) ? saleData.nhisSettlementLines : [])
      .map((line) => [String(line.drugId || line.id || ''), line])
  )
  let totalAmount = 0

  const normalizedItems = saleData.items.map((item) => {
    const drugId = item.drugId || item.id
    if (!drugId) {
      throw new Error('Each sale item must include a drugId.')
    }

    const drug = getDrugForUpdate.get(drugId)
    if (!drug) {
      throw new Error(`Drug ${drugId} is not available in the local inventory.`)
    }

    const quantity = assertPositiveQuantity(item.quantity, 'Item quantity')
    const unitPrice = toMoney(item.price ?? item.unitPrice ?? drug.price, 0)
    if (unitPrice < 0) {
      throw new Error('Item price cannot be negative.')
    }

    const currentQuantity = Number(drug.quantity || 0)
    if (currentQuantity < quantity) {
      throw new Error(`${drug.name} has insufficient local stock.`)
    }

    const totalPrice = toMoney(quantity * unitPrice)
    totalAmount = toMoney(totalAmount + totalPrice)

    const settlement = settlementByDrugId.get(String(drugId)) || {}
    return {
      id: createId(),
      saleId,
      drugId,
      drugName: item.name || drug.name,
      quantity,
      unitPrice,
      totalPrice,
      previousQuantity: currentQuantity,
      newQuantity: currentQuantity - quantity,
      nhisSettlement: settlement.nhisSettlement || null,
      nhisCoveredAmount: toMoney(settlement.nhisCoveredAmount, 0),
      patientTopUpAmount: toMoney(settlement.patientTopUpAmount, 0),
      privateAmount: toMoney(settlement.privateAmount, 0),
      policyAdjustmentAmount: toMoney(settlement.policyAdjustmentAmount, 0),
    }
  })

  const netAmount = toMoney(totalAmount - discount)
  if (discount < 0 || netAmount < 0) {
    throw new Error('Discount cannot be negative or greater than the sale total.')
  }

  const amountPaid = paymentStatus === 'pending_payment'
    ? 0
    : paymentMethod === 'cash'
    ? toMoney(saleData.amountPaid, netAmount)
    : paymentMethod === 'nhia'
    ? toMoney(saleData.amountPaid, 0)
    : netAmount
  const changeGiven = paymentStatus === 'pending_payment'
    ? 0
    : paymentMethod === 'cash'
    ? toMoney(saleData.change ?? 0, 0)
    : 0
  const insuranceCoveredAmount =
    isInsuranceLikePayment ? toMoney(saleData.insuranceCoveredAmount ?? netAmount, 0) : 0
  const insuranceTopUpAmount =
    isInsuranceLikePayment ? toMoney(saleData.insuranceTopUpAmount, 0) : 0
  const insuranceTopUpPaymentMethod =
    isInsuranceLikePayment && insuranceTopUpAmount > 0
      ? String(saleData.insuranceTopUpPaymentMethod || '').trim().toLowerCase()
      : null
  const nhisCoveredAmount = paymentMethod === 'nhia'
    ? toMoney(saleData.nhisCoveredAmount, 0)
    : 0
  const nhisTopUpAmount = paymentMethod === 'nhia'
    ? toMoney(saleData.nhisTopUpAmount, 0)
    : 0
  const privateNonNhisAmount = paymentMethod === 'nhia'
    ? toMoney(saleData.privateNonNhisAmount, 0)
    : 0
  const nhisPolicyAdjustmentAmount = paymentMethod === 'nhia'
    ? toMoney(saleData.nhisPolicyAdjustmentAmount, 0)
    : 0
  const nhisTopUpPolicy = paymentMethod === 'nhia'
    ? String(saleData.nhisTopUpPolicy || '').trim().toLowerCase() || null
    : null
  const patientPaymentMethod = paymentMethod === 'nhia' && (nhisTopUpAmount + privateNonNhisAmount) > 0
    ? String(saleData.patientPaymentMethod || '').trim().toLowerCase()
    : null

  if (paymentMethod === 'cash' && amountPaid < netAmount) {
    throw new Error('Amount paid cannot be less than the sale total for cash payments.')
  }

  if (paymentMethod === 'nhia') {
    if (Math.abs(nhisCoveredAmount + nhisTopUpAmount + privateNonNhisAmount + nhisPolicyAdjustmentAmount - netAmount) > 0.01) {
      throw new Error('NHIA settlement buckets must add up to the sale total.')
    }
    if ((nhisTopUpAmount + privateNonNhisAmount) > 0 && !['cash', 'momo', 'card'].includes(patientPaymentMethod)) {
      throw new Error('A patient payment method is required for NHIA top-up or private medicines.')
    }
  } else if (isInsuranceLikePayment) {
    if (Math.abs(insuranceCoveredAmount + insuranceTopUpAmount - netAmount) > 0.01) {
      throw new Error('Insurance/NHIA cover and patient top-up must add up to the sale total.')
    }

    if (
      insuranceTopUpAmount > 0 &&
      !['cash', 'momo', 'card'].includes(insuranceTopUpPaymentMethod)
    ) {
      throw new Error('Insurance top-up payment method is required.')
    }
  }

  const sale = {
    id: saleId,
    saleNumber,
    patientId: saleData.patientId || null,
    totalAmount,
    discount,
    netAmount,
    paymentMethod,
    paymentStatus,
    amountPaid,
    changeGiven,
    insuranceCoveredAmount,
    insuranceTopUpAmount,
    insuranceTopUpPaymentMethod,
    nhisCoveredAmount,
    nhisTopUpAmount,
    privateNonNhisAmount,
    nhisPolicyAdjustmentAmount,
    nhisTopUpPolicy,
    patientPaymentMethod,
    notes: saleData.notes || null,
    soldBy,
    shiftId,
    organizationId: saleData.organizationId || config.organizationId,
    branchId: saleData.branchId || config.branchId,
    saleDate: saleData.saleDate || createdAt,
    createdAt,
    syncStatus: paymentStatus === 'pending_payment' ? 'pending_payment' : 'pending',
  }

  insertSale.run(sale)

  for (const item of normalizedItems) {
    insertSaleItem.run({ ...item, createdAt })
    updateDrugQuantity.run(item.newQuantity, createdAt, item.drugId)
    insertStockMovement.run({
      id: createId(),
      drugId: item.drugId,
      quantity: -item.quantity,
      previousQuantity: item.previousQuantity,
      newQuantity: item.newQuantity,
      referenceId: saleId,
      notes: `Local sale ${saleNumber}`,
      createdBy: sale.soldBy,
      createdAt,
    })
  }

  if (paymentStatus === 'completed') {
    const syncPayload = {
      local_sale_id: saleId,
      local_sale_number: saleNumber,
      sale_payload: {
        patient_id: sale.patientId,
        payment_method: syncPaymentMethod,
        payment_status: 'completed',
        amount_paid: amountPaid,
        change_given: changeGiven,
        notes: sale.notes ? `${sale.notes}\nLocal reference: ${saleNumber}` : `Local reference: ${saleNumber}`,
        sold_by: sale.soldBy,
        sale_date: sale.saleDate,
        discount,
        shift_id: null,
        insurance_covered_amount: insuranceCoveredAmount,
        insurance_top_up_amount: insuranceTopUpAmount,
        insurance_top_up_payment_method: insuranceTopUpPaymentMethod,
        nhis_covered_amount: nhisCoveredAmount,
        nhis_top_up_amount: nhisTopUpAmount,
        private_non_nhis_amount: privateNonNhisAmount,
        nhis_policy_adjustment_amount: nhisPolicyAdjustmentAmount,
        nhis_top_up_policy: nhisTopUpPolicy,
        patient_payment_method: patientPaymentMethod,
        organization_id: sale.organizationId,
        branch_id: sale.branchId,
        items: normalizedItems.map((item) => ({
          drugId: item.drugId,
          name: item.drugName,
          quantity: item.quantity,
          price: item.unitPrice,
          nhis_settlement: item.nhisSettlement,
          nhis_covered_amount: item.nhisCoveredAmount,
          patient_top_up_amount: item.patientTopUpAmount,
          private_amount: item.privateAmount,
          policy_adjustment_amount: item.policyAdjustmentAmount,
          nhis_settlement: item.nhisSettlement,
          nhis_covered_amount: item.nhisCoveredAmount,
          patient_top_up_amount: item.patientTopUpAmount,
          private_amount: item.privateAmount,
          policy_adjustment_amount: item.policyAdjustmentAmount,
        })),
      },
    }

    insertOutbox.run({
      id: createId(),
      eventType: 'sale.completed',
      entityType: 'sales',
      entityId: saleId,
      payloadJson: json(syncPayload),
      createdAt,
      updatedAt: createdAt,
    })
  }

  return {
    sale: { ...sale, items: normalizedItems },
    saleNumber,
  }
})

export const getRecentLocalSales = (limit = 20) =>
  getRecentSalesStatement.all(Math.min(Math.max(Number(limit) || 20, 1), 100)).map((sale) => ({
    ...sale,
    items: getSaleItemsStatement.all(sale.id),
  }))

export const getLocalSale = (id) => normalizeSaleRow(selectSaleById.get(id))

export const markLocalSalePaidAndQueueSync = db.transaction(({ saleId, paymentReference = '' } = {}) => {
  const existing = normalizeSaleRow(selectSaleById.get(saleId))
  if (!existing) {
    throw new Error('Sale for payment attempt was not found.')
  }

  if (existing.paymentStatus === 'completed') {
    return existing
  }

  const notes = existing.notes || null
  updateSalePaid.run(notes, saleId)
  const paidSale = normalizeSaleRow(selectSaleById.get(saleId))

  if (!selectSaleCompletedOutbox.get(saleId)) {
    const timestamp = nowIso()
    insertOutbox.run({
      id: createId(),
      eventType: 'sale.completed',
      entityType: 'sales',
      entityId: saleId,
      payloadJson: json(buildSaleSyncPayload({
        sale: paidSale,
        items: paidSale.items,
        paymentReference,
      })),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  }

  return paidSale
})
