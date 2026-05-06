import { supabase } from '../lib/supabase'
import { assertRequiredText, assertNonNegativeNumber, normalizeText } from '../utils/validation'
import { tryLogAuditEvent } from './auditService'

// ─── Suppliers ───────────────────────────────────────────────────────────────

export const getAllSuppliers = async () => {
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
  let query = supabase
    .from('purchases')
    .select(`
      *,
      purchase_items (
        id, drug_id, drug_name, quantity, unit,
        unit_cost, discount_percent, net_total,
        batch_number, expiry_date
      )
    `)
    .order('purchase_date', { ascending: false })
    .order('created_at', { ascending: false })

  if (filters.status && filters.status !== 'all') {
    query = query.eq('status', filters.status)
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
  const { data, error } = await supabase
    .from('purchases')
    .select(`
      *,
      purchase_items (
        id, drug_id, drug_name, quantity, unit,
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
 * @param {Array}  items        - [{ drugId, drugName, quantity, unit, unitCost, discountPercent, batchNumber, expiryDate }]
 * @returns the created purchase record
 */
export const createPurchase = async (purchaseData, items = []) => {
  if (!items.length) throw new Error('Add at least one item to the purchase.')

  const purchaseDate = purchaseData.purchaseDate || new Date().toISOString().split('T')[0]
  const totalAmount = items.reduce((sum, item) => sum + (item.netTotal || 0), 0)

  // Insert the purchase header
  const { data: purchase, error: purchaseError } = await supabase
    .from('purchases')
    .insert([{
      supplier_id:    purchaseData.supplierId   || null,
      supplier_name:  normalizeText(purchaseData.supplierName) || null,
      invoice_number: normalizeText(purchaseData.invoiceNumber) || null,
      purchase_date:  purchaseDate,
      total_amount:   totalAmount,
      status:         'draft',
      notes:          normalizeText(purchaseData.notes) || null,
    }])
    .select()
    .single()

  if (purchaseError) throw purchaseError

  // Insert line items
  const itemRows = items.map((item) => ({
    purchase_id:      purchase.id,
    drug_id:          item.drugId   || null,
    drug_name:        assertRequiredText(item.drugName, 'Drug name'),
    quantity:         assertNonNegativeNumber(item.quantity,  'Quantity'),
    unit:             normalizeText(item.unit) || 'unit',
    unit_cost:        assertNonNegativeNumber(item.unitCost,  'Unit cost'),
    discount_percent: item.discountPercent ? assertNonNegativeNumber(item.discountPercent, 'Discount') : 0,
    net_total:        assertNonNegativeNumber(item.netTotal,  'Net total'),
    batch_number:     normalizeText(item.batchNumber) || null,
    expiry_date:      item.expiryDate || null,
  }))

  const { error: itemsError } = await supabase
    .from('purchase_items')
    .insert(itemRows)

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
export const completePurchase = async (id) => {
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

export const cancelPurchase = async (id) => {
  const { data, error } = await supabase
    .from('purchases')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) throw error

  await tryLogAuditEvent({
    eventType: 'purchase.cancelled',
    entityType: 'purchases',
    entityId: id,
    action: 'cancel',
    details: {},
  })

  return data
}

export const getPurchasesStats = async () => {
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
    completedCount: rows.filter((r) => r.status === 'completed').length,
  }
}
