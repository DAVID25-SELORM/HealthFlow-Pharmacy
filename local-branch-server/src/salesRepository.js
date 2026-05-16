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

const insertSale = db.prepare(`
  INSERT INTO sales (
    id, sale_number, patient_id, total_amount, discount, net_amount,
    payment_method, payment_status, amount_paid, change_given, notes,
    sold_by, shift_id, organization_id, branch_id, sale_date, created_at, sync_status
  )
  VALUES (
    @id, @saleNumber, @patientId, @totalAmount, @discount, @netAmount,
    @paymentMethod, @paymentStatus, @amountPaid, @changeGiven, @notes,
    @soldBy, @shiftId, @organizationId, @branchId, @saleDate, @createdAt, @syncStatus
  )
`)

const insertSaleItem = db.prepare(`
  INSERT INTO sale_items (
    id, sale_id, drug_id, drug_name, quantity, unit_price, total_price, created_at
  )
  VALUES (
    @id, @saleId, @drugId, @drugName, @quantity, @unitPrice, @totalPrice, @createdAt
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
      shift_id: sale.shiftId,
      insurance_covered_amount: 0,
      insurance_top_up_amount: 0,
      insurance_top_up_payment_method: null,
      organization_id: sale.organizationId,
      branch_id: sale.branchId,
      items: items.map((item) => ({
        drugId: item.drug_id || item.drugId,
        name: item.drug_name || item.drugName,
        quantity: item.quantity,
        price: item.unit_price ?? item.unitPrice,
      })),
    },
  }
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

  const createdAt = nowIso()
  const saleId = createId()
  const saleNumber = saleData.saleNumber || createSaleNumber()
  const discount = toMoney(saleData.discount, 0)
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

  if (paymentMethod === 'cash' && amountPaid < netAmount) {
    throw new Error('Amount paid cannot be less than the sale total for cash payments.')
  }

  if (isInsuranceLikePayment) {
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
    notes: saleData.notes || null,
    soldBy: saleData.soldBy || null,
    shiftId: saleData.shiftId || null,
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
        shift_id: sale.shiftId,
        insurance_covered_amount: insuranceCoveredAmount,
        insurance_top_up_amount: insuranceTopUpAmount,
        insurance_top_up_payment_method: insuranceTopUpPaymentMethod,
        organization_id: sale.organizationId,
        branch_id: sale.branchId,
        items: normalizedItems.map((item) => ({
          drugId: item.drugId,
          name: item.drugName,
          quantity: item.quantity,
          price: item.unitPrice,
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
