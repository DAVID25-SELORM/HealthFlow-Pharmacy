import { supabase } from '../lib/supabase'
import { assertRequiredText, assertNonNegativeNumber, normalizeText } from '../utils/validation'
import { tryLogAuditEvent } from './auditService'
import {
  createBranchRecord,
  listBranchRecords,
  shouldUseBranchServer,
  updateBranchRecord,
} from './branchServerApi'

// ─── Suppliers ───────────────────────────────────────────────────────────────

export const getAllSuppliers = async () => {
  if (shouldUseBranchServer()) {
    return await listBranchRecords('suppliers')
  }

  const { data, error } = await supabase
    .from('suppliers')
    .select('*')
    .eq('is_active', true)
    .order('name')

  if (error) throw error
  return data || []
}

export const createSupplier = async (supplierData) => {
  const name = assertRequiredText(supplierData.name, 'Supplier name')

  if (shouldUseBranchServer()) {
    return await createBranchRecord('suppliers', {
      name,
      contact_person: normalizeText(supplierData.contactPerson) || null,
      phone: normalizeText(supplierData.phone) || null,
      email: normalizeText(supplierData.email) || null,
      address: normalizeText(supplierData.address) || null,
      notes: normalizeText(supplierData.notes) || null,
      is_active: true,
    })
  }

  const { data, error } = await supabase
    .from('suppliers')
    .insert([{
      name,
      contact_person: normalizeText(supplierData.contactPerson) || null,
      phone:          normalizeText(supplierData.phone)         || null,
      email:          normalizeText(supplierData.email)         || null,
      address:        normalizeText(supplierData.address)       || null,
      notes:          normalizeText(supplierData.notes)         || null,
    }])
    .select()
    .single()

  if (error) throw error

  await tryLogAuditEvent({
    eventType: 'supplier.created',
    entityType: 'suppliers',
    entityId: data.id,
    action: 'create',
    details: { name: data.name },
  })

  return data
}

export const updateSupplier = async (id, supplierData) => {
  const name = assertRequiredText(supplierData.name, 'Supplier name')

  if (shouldUseBranchServer()) {
    return await updateBranchRecord('suppliers', id, {
      name,
      contact_person: normalizeText(supplierData.contactPerson) || null,
      phone: normalizeText(supplierData.phone) || null,
      email: normalizeText(supplierData.email) || null,
      address: normalizeText(supplierData.address) || null,
      notes: normalizeText(supplierData.notes) || null,
    })
  }

  const { data, error } = await supabase
    .from('suppliers')
    .update({
      name,
      contact_person: normalizeText(supplierData.contactPerson) || null,
      phone:          normalizeText(supplierData.phone)         || null,
      email:          normalizeText(supplierData.email)         || null,
      address:        normalizeText(supplierData.address)       || null,
      notes:          normalizeText(supplierData.notes)         || null,
      updated_at:     new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

// ─── Purchases ───────────────────────────────────────────────────────────────

export const getAllPurchases = async (filters = {}) => {
  if (shouldUseBranchServer()) {
    const rows = await listBranchRecords('purchases', filters)
    return Array.isArray(filters.statuses)
      ? (rows || []).filter((row) => filters.statuses.includes(row.status))
      : rows
  }

  let query = supabase
    .from('purchases')
    .select(`
      *,
      purchase_items (
        id, drug_id, drug_name, brand_name, generic_name, sale_on_return, quantity, unit,
        unit_cost, discount_percent, net_total,
        batch_number, expiry_date, received_quantity
      )
    `)
    .order('purchase_date', { ascending: false })
    .order('created_at', { ascending: false })

  if (filters.status && filters.status !== 'all') {
    query = query.eq('status', filters.status)
  }

  if (Array.isArray(filters.statuses) && filters.statuses.length) {
    query = query.in('status', filters.statuses)
  }

  if (filters.supplierId) {
    query = query.eq('supplier_id', filters.supplierId)
  }

  if (filters.startDate) {
    query = query.gte('purchase_date', filters.startDate)
  }

  if (filters.endDate) {
    query = query.lte('purchase_date', filters.endDate)
  }

  const { data, error } = await query
  if (error) throw error
  return data || []
}

export const getPurchaseById = async (id) => {
  if (shouldUseBranchServer()) {
    const purchases = await listBranchRecords('purchases', { id, limit: 1 })
    if (!purchases.length) {
      throw new Error('Purchase not found in local branch server.')
    }
    return purchases[0]
  }

  const { data, error } = await supabase
    .from('purchases')
    .select(`
      *,
      purchase_items (
        id, drug_id, drug_name, brand_name, generic_name, sale_on_return, quantity, unit,
        unit_cost, discount_percent, net_total,
        batch_number, expiry_date
      )
    `)
    .eq('id', id)
    .single()

  if (error) throw error
  return data
}

/**
 * Creates a purchase order with items in a draft state.
 * @param {object} purchaseData - { supplierId, supplierName, invoiceNumber, purchaseDate, notes }
 * @param {Array}  items        - [{ drugId, drugName, brandName, genericName, saleOnReturn, quantity, unit, unitCost, discountPercent, batchNumber, expiryDate }]
 * @returns the created purchase record
 */
export const createPurchase = async (purchaseData, items = []) => {
  if (!items.length) throw new Error('Add at least one item to the purchase.')

  const purchaseDate = purchaseData.purchaseDate || new Date().toISOString().split('T')[0]
  const totalAmount = items.reduce((sum, item) => sum + (item.netTotal || 0), 0)
  const purchaseId = normalizeText(purchaseData.id) || null
  const itemRows = items.map((item) => ({
    drug_id:          item.drugId   || null,
    drug_name:        assertRequiredText(item.drugName, 'Drug name'),
    brand_name:       normalizeText(item.brandName) || null,
    generic_name:     normalizeText(item.genericName) || null,
    sale_on_return:   Boolean(item.saleOnReturn),
    quantity:         assertNonNegativeNumber(item.quantity,  'Quantity'),
    unit:             normalizeText(item.unit) || 'unit',
    unit_cost:        assertNonNegativeNumber(item.unitCost,  'Unit cost'),
    discount_percent: item.discountPercent ? assertNonNegativeNumber(item.discountPercent, 'Discount') : 0,
    net_total:        assertNonNegativeNumber(item.netTotal,  'Net total'),
    batch_number:     normalizeText(item.batchNumber) || null,
    expiry_date:      item.expiryDate || null,
  }))

  if (shouldUseBranchServer()) {
    return await createBranchRecord('purchases', {
      ...(purchaseId ? { id: purchaseId } : {}),
      supplier_id: purchaseData.supplierId || null,
      supplier_name: normalizeText(purchaseData.supplierName) || null,
      branch_id: normalizeText(purchaseData.branchId) || null,
      invoice_number: normalizeText(purchaseData.invoiceNumber) || null,
      purchase_date: purchaseDate,
      total_amount: totalAmount,
      status: 'draft',
      notes: normalizeText(purchaseData.notes) || null,
      purchase_items: itemRows,
    })
  }

  let purchase = null
  if (purchaseId) {
    const { data: existingPurchase, error: existingError } = await supabase
      .from('purchases')
      .select('*, purchase_items (*)')
      .eq('id', purchaseId)
      .maybeSingle()
    if (existingError) throw existingError
    if (existingPurchase?.purchase_items?.length) {
      return existingPurchase
    }
    purchase = existingPurchase || null
  }

  if (!purchase) {
    const purchaseRow = {
      ...(purchaseId ? { id: purchaseId } : {}),
      supplier_id:    purchaseData.supplierId   || null,
      supplier_name:  normalizeText(purchaseData.supplierName) || null,
      branch_id:      normalizeText(purchaseData.branchId) || null,
      invoice_number: normalizeText(purchaseData.invoiceNumber) || null,
      purchase_date:  purchaseDate,
      total_amount:   totalAmount,
      status:         'draft',
      notes:          normalizeText(purchaseData.notes) || null,
    }
    const { data: createdPurchase, error: purchaseError } = await supabase
      .from('purchases')
      .insert([purchaseRow])
      .select()
      .single()

    if (purchaseError) throw purchaseError
    purchase = createdPurchase
  }

  const purchaseItemRows = itemRows.map((item) => ({
    ...item,
    purchase_id:      purchase.id,
  }))

  const { error: itemsError } = await supabase
    .from('purchase_items')
    .insert(purchaseItemRows)

  if (itemsError) throw itemsError

  await tryLogAuditEvent({
    eventType: 'purchase.created',
    entityType: 'purchases',
    entityId: purchase.id,
    action: 'create',
    details: {
      purchase_number: purchase.purchase_number,
      supplier_name:   purchase.supplier_name,
      item_count:      items.length,
      total_amount:    totalAmount,
    },
  })

  return purchase
}

/**
 * Finalises a draft purchase: updates drug stock and marks status = 'completed'.
 * Calls the complete_purchase Postgres RPC to guarantee atomicity.
 */
export const completePurchase = async (id, { canApprove = false } = {}) => {
  if (!canApprove) {
    throw new Error('You do not have permission to approve purchases.')
  }

  if (shouldUseBranchServer()) {
    return await updateBranchRecord('purchases', id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
  }

  const { data, error } = await supabase.rpc('complete_purchase', { p_purchase_id: id })

  if (error) throw error
  if (data?.error) throw new Error(data.error)

  await tryLogAuditEvent({
    eventType: 'purchase.completed',
    entityType: 'purchases',
    entityId: id,
    action: 'complete',
    details: { items_updated: data?.items_updated },
  })

  return data
}

const buildPurchaseItemCompletionDetails = (purchase, items, source = 'purchase_items') =>
  items.map((item) => ({
    id: item.id || `${purchase.id}-${item.drug_id || item.drug_name}`,
    drug_id: item.drug_id || null,
    drug_name: item.drug_name || 'Unknown item',
    quantity_added: Number(item.quantity || 0),
    previous_quantity: null,
    new_quantity: null,
    unit_cost: item.unit_cost,
    batch_number: item.batch_number,
    expiry_date: item.expiry_date,
    brand_name: item.brand_name,
    generic_name: item.generic_name,
    sale_on_return: Boolean(item.sale_on_return),
    source,
  }))

export const getPurchaseCompletionDetails = async (purchase) => {
  if (!purchase?.id || !['completed', 'partially_received'].includes(purchase.status)) {
    return []
  }

  const items = Array.isArray(purchase.purchase_items) ? purchase.purchase_items : []

  if (shouldUseBranchServer()) {
    return buildPurchaseItemCompletionDetails(purchase, items, 'branch')
  }

  const { data, error } = await supabase
    .from('stock_movements')
    .select('id, drug_id, quantity, previous_quantity, new_quantity, notes, created_at')
    .eq('reference_id', purchase.id)
    .eq('movement_type', 'purchase')
    .order('created_at', { ascending: true })

  if (error) {
    return buildPurchaseItemCompletionDetails(purchase, items, 'purchase_items_fallback')
  }

  if (!data?.length) {
    return buildPurchaseItemCompletionDetails(purchase, items, 'purchase_items_fallback')
  }

  return (data || []).map((movement) => {
    const item = items.find((row) => row.drug_id === movement.drug_id) || {}
    return {
      id: movement.id,
      drug_id: movement.drug_id,
      drug_name: item.drug_name || 'Inventory item',
      quantity_added: Number(movement.quantity || item.quantity || 0),
      previous_quantity: movement.previous_quantity,
      new_quantity: movement.new_quantity,
      unit_cost: item.unit_cost,
      batch_number: item.batch_number,
      expiry_date: item.expiry_date,
      brand_name: item.brand_name,
      generic_name: item.generic_name,
      sale_on_return: Boolean(item.sale_on_return),
      completed_at: movement.created_at,
      source: 'stock_movements',
    }
  })
}

// Cancelling goes through cancel_purchase_order(), which enforces who may cancel, which
// statuses can be cancelled, requires a reason once an order has been placed, and audits it.
export const cancelPurchase = async (id, { reason = '' } = {}) => {
  if (shouldUseBranchServer()) {
    return await updateBranchRecord('purchases', id, {
      status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
  }

  const { data, error } = await supabase.rpc('cancel_purchase_order', {
    p_purchase_id: id,
    p_reason: normalizeText(reason) || null,
  })

  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data
}

// Draft -> ordered. Does not touch stock.
export const placePurchase = async (id) => {
  const { data, error } = await supabase.rpc('place_purchase_order', { p_purchase_id: id })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data
}

/**
 * Records goods that have actually arrived. lines: [{ purchaseItemId, quantity, batchNumber,
 * expiryDate, unitCost }]. receiptKey makes a retried call harmless (stock is never posted twice).
 * Status becomes partially_received, or completed once nothing is outstanding.
 */
export const receivePurchaseGoods = async (id, lines, { receiptKey, notes = '' } = {}) => {
  const key = normalizeText(receiptKey)
  if (!key) throw new Error('A receipt key is required.')
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('Enter at least one received item.')

  const payload = lines.map((line) => ({
    purchase_item_id: assertRequiredText(line.purchaseItemId, 'Item'),
    quantity: assertNonNegativeNumber(line.quantity, 'Received quantity'),
    batch_number: normalizeText(line.batchNumber) || null,
    expiry_date: line.expiryDate || null,
    unit_cost: line.unitCost === '' || line.unitCost == null ? null : assertNonNegativeNumber(line.unitCost, 'Unit cost'),
  }))
  if (payload.some((line) => !(line.quantity > 0))) {
    throw new Error('Each received quantity must be above zero.')
  }

  const { data, error } = await supabase.rpc('receive_purchase_goods', {
    p_purchase_id: id,
    p_lines: payload,
    p_receipt_key: key,
    p_notes: normalizeText(notes) || null,
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data
}

// Display name for the printed PO's "created by". Best effort: a missing name never blocks printing.
export const getUserDisplayName = async (userId) => {
  if (!userId) return ''
  const { data } = await supabase.from('users').select('full_name').eq('id', userId).maybeSingle()
  return data?.full_name || ''
}

export const getPurchaseReceipts = async (purchaseId) => {
  const { data, error } = await supabase
    .from('purchase_receipts')
    .select('id, purchase_item_id, drug_id, received_quantity, batch_number, expiry_date, unit_cost, received_at, notes, receipt_key, received_by_user:received_by (full_name)')
    .eq('purchase_id', purchaseId)
    .order('received_at', { ascending: true })
  if (error) throw error
  return data || []
}

export const getPurchasesStats = async () => {
  if (shouldUseBranchServer()) {
    const rows = await getAllPurchases()
    return {
      totalThisMonth: rows
        .filter((r) => r.status === 'completed')
        .reduce((s, r) => s + Number(r.total_amount || 0), 0),
      totalAllTime: rows
        .filter((r) => r.status === 'completed')
        .reduce((s, r) => s + Number(r.total_amount || 0), 0),
      draftCount: rows.filter((r) => r.status === 'draft').length,
      orderedCount: rows.filter((r) => r.status === 'ordered' || r.status === 'partially_received').length,
      completedCount: rows.filter((r) => r.status === 'completed').length,
    }
  }

  const now = new Date()
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString().split('T')[0]

  const { data, error } = await supabase
    .from('purchases')
    .select('status, total_amount, purchase_date')

  if (error) throw error

  const rows = data || []
  return {
    totalThisMonth: rows
      .filter((r) => r.status === 'completed' && r.purchase_date >= firstOfMonth)
      .reduce((s, r) => s + Number(r.total_amount || 0), 0),
    totalAllTime: rows
      .filter((r) => r.status === 'completed')
      .reduce((s, r) => s + Number(r.total_amount || 0), 0),
    draftCount: rows.filter((r) => r.status === 'draft').length,
    orderedCount: rows.filter((r) => r.status === 'ordered' || r.status === 'partially_received').length,
    completedCount: rows.filter((r) => r.status === 'completed').length,
  }
}
