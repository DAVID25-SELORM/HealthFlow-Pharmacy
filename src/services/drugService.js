import { supabase } from '../lib/supabase'
import { assertNonNegativeNumber, assertRequiredText, normalizeText, sanitizeSearchTerm } from '../utils/validation'

/**
 * Drug/Inventory Service
 * Handles all drug inventory operations
 */

// Get all drugs
export const getAllDrugs = async () => {
  const { data, error } = await supabase
    .from('drugs')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
  
  if (error) throw error
  return data
}

// Get drug by ID
export const getDrugById = async (id) => {
  const { data, error } = await supabase
    .from('drugs')
    .select('*')
    .eq('id', id)
    .single()
  
  if (error) throw error
  return data
}

// Add new drug
export const addDrug = async (drugData) => {
  const name = assertRequiredText(drugData.name, 'Drug name')
  const batchNumber = assertRequiredText(drugData.batchNumber, 'Batch number')

  const { data, error } = await supabase
    .from('drugs')
    .insert([
      {
        name,
        batch_number: batchNumber,
        expiry_date: drugData.expiryDate,
        quantity: assertNonNegativeNumber(drugData.quantity, 'Quantity'),
        price: assertNonNegativeNumber(drugData.price, 'Price'),
        cost_price: assertNonNegativeNumber(drugData.costPrice || 0, 'Cost price'),
        supplier: normalizeText(drugData.supplier) || null,
        category: normalizeText(drugData.category) || null,
        description: normalizeText(drugData.description) || null,
        reorder_level: assertNonNegativeNumber(drugData.reorderLevel || 10, 'Reorder level'),
        unit: normalizeText(drugData.unit) || 'tablets',
      }
    ])
    .select()
  
  if (error) throw error
  return data[0]
}

// Update drug
export const updateDrug = async (id, drugData) => {
  const name = assertRequiredText(drugData.name, 'Drug name')
  const batchNumber = assertRequiredText(drugData.batchNumber, 'Batch number')
  const payload = {
    name,
    batch_number: batchNumber,
    expiry_date: drugData.expiryDate,
    quantity: assertNonNegativeNumber(drugData.quantity, 'Quantity'),
    price: assertNonNegativeNumber(drugData.price, 'Price'),
    supplier: normalizeText(drugData.supplier) || null,
    updated_at: new Date().toISOString()
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'costPrice')) {
    payload.cost_price = assertNonNegativeNumber(drugData.costPrice || 0, 'Cost price')
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'category')) {
    payload.category = normalizeText(drugData.category) || null
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'description')) {
    payload.description = normalizeText(drugData.description) || null
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'reorderLevel')) {
    payload.reorder_level = assertNonNegativeNumber(drugData.reorderLevel || 10, 'Reorder level')
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'unit')) {
    payload.unit = normalizeText(drugData.unit) || 'tablets'
  }

  const { data, error } = await supabase
    .from('drugs')
    .update(payload)
    .eq('id', id)
    .select()
  
  if (error) throw error
  return data[0]
}

// Delete drug (soft delete by setting status to inactive)
export const deleteDrug = async (id) => {
  const { data, error } = await supabase
    .from('drugs')
    .update({ status: 'inactive' })
    .eq('id', id)
    .select()
  
  if (error) throw error
  return data[0]
}

// Search drugs
export const searchDrugs = async (searchTerm) => {
  const term = sanitizeSearchTerm(searchTerm)
  if (!term) {
    return getAllDrugs()
  }

  const { data, error } = await supabase
    .from('drugs')
    .select('*')
    .eq('status', 'active')
    .or(`name.ilike.%${term}%,batch_number.ilike.%${term}%`)
    .order('name')
  
  if (error) throw error
  return data
}

// Get low stock drugs
export const getLowStockDrugs = async () => {
  const { data, error } = await supabase
    .from('low_stock_drugs')
    .select('*')
  
  if (error) throw error
  return data
}

// Get expiring drugs (within 30 days)
export const getExpiringDrugs = async () => {
  const { data, error } = await supabase
    .from('expiring_soon_drugs')
    .select('*')
  
  if (error) throw error
  return data
}

// Get expired drugs
export const getExpiredDrugs = async () => {
  const { data, error } = await supabase
    .from('expired_drugs')
    .select('*')
  
  if (error) throw error
  return data
}

// Calculate drug status based on quantity and expiry
export const calculateDrugStatus = (drug) => {
  const today = new Date()
  const expiryDate = new Date(drug.expiry_date)
  const daysUntilExpiry = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24))
  
  // Check if expired
  if (daysUntilExpiry < 0) {
    return 'expired'
  }
  
  // Check if expiring soon (within 30 days)
  if (daysUntilExpiry <= 30) {
    return 'expiring'
  }
  
  // Check if low stock
  const reorderLevel = drug.reorder_level || 10
  if (drug.quantity <= reorderLevel) {
    return 'low'
  }
  
  return 'good'
}
