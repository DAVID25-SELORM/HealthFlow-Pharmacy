import { supabase } from '../lib/supabase'
import { assertNonNegativeNumber, assertRequiredText, normalizeText, sanitizeSearchTerm } from '../utils/validation'
import { invokeTierAccess } from './tierAccessService'

/**
 * Drug/Inventory Service
 * Handles all drug inventory operations
 */

export const DEFAULT_MEDICATION_BATCH_PREFIX = 'PDF-IMP-'

export const isDefaultCatalogDrug = (drug) =>
  String(drug?.batch_number || drug?.batch || '').toUpperCase().startsWith(DEFAULT_MEDICATION_BATCH_PREFIX)

const shouldShowDrugOutsideInventory = (drug) =>
  !isDefaultCatalogDrug(drug) || Number.parseFloat(drug?.quantity ?? 0) > 0

const shouldAlertForDrug = (drug) =>
  !isDefaultCatalogDrug(drug) || Number.parseFloat(drug?.quantity ?? 0) > 0

const isInactiveDrug = (drug) => String(drug?.status || 'active').toLowerCase() === 'inactive'

const getAllDrugsDirectly = async () => {
  const { data, error } = await supabase.from('drugs').select('*').order('name')

  if (error) {
    throw error
  }

  return (data || []).filter((drug) => !isInactiveDrug(drug))
}

const getAllDrugsViaTierAccess = async (includeCatalog = false) => {
  const response = await invokeTierAccess({
    action: 'get_drugs',
    includeCatalog,
  })

  return (response.drugs || []).filter((drug) => !isInactiveDrug(drug))
}

// Get all drugs
export const getAllDrugs = async (options = {}) => {
  if (options.includeCatalog) {
    try {
      return await getAllDrugsViaTierAccess(true)
    } catch (error) {
      console.warn(
        'Tier access catalog lookup failed; falling back to direct inventory query.',
        error
      )
      return getAllDrugsDirectly()
    }
  }

  const drugs = await getAllDrugsDirectly()

  return drugs.filter(shouldShowDrugOutsideInventory)
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

  const response = await invokeTierAccess({
    action: 'create_drug',
    drug: {
      name,
      batchNumber,
      expiryDate: drugData.expiryDate,
      quantity: assertNonNegativeNumber(drugData.quantity, 'Quantity'),
      price: assertNonNegativeNumber(drugData.price, 'Price'),
      costPrice: assertNonNegativeNumber(drugData.costPrice || 0, 'Cost price'),
      supplier: normalizeText(drugData.supplier) || null,
      category: normalizeText(drugData.category) || null,
      description: normalizeText(drugData.description) || null,
      reorderLevel: assertNonNegativeNumber(drugData.reorderLevel || 10, 'Reorder level'),
      unit: normalizeText(drugData.unit) || 'tablets',
    },
  })

  return response.drug
}

// Update drug
export const updateDrug = async (id, drugData) => {
  const name = assertRequiredText(drugData.name, 'Drug name')
  const batchNumber = assertRequiredText(drugData.batchNumber, 'Batch number')
  const payload = {
    name,
    batchNumber,
    expiryDate: drugData.expiryDate,
    quantity: assertNonNegativeNumber(drugData.quantity, 'Quantity'),
    price: assertNonNegativeNumber(drugData.price, 'Price'),
    supplier: normalizeText(drugData.supplier) || null,
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'costPrice')) {
    payload.costPrice = assertNonNegativeNumber(drugData.costPrice || 0, 'Cost price')
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'category')) {
    payload.category = normalizeText(drugData.category) || null
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'description')) {
    payload.description = normalizeText(drugData.description) || null
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'reorderLevel')) {
    payload.reorderLevel = assertNonNegativeNumber(drugData.reorderLevel || 10, 'Reorder level')
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'unit')) {
    payload.unit = normalizeText(drugData.unit) || 'tablets'
  }

  const response = await invokeTierAccess({
    action: 'update_drug',
    drugId: id,
    drug: payload,
  })

  return response.drug
}

// Delete drug (soft delete by setting status to inactive)
export const deleteDrug = async (id) => {
  const response = await invokeTierAccess({
    action: 'delete_drug',
    drugId: id,
  })

  return response.drug
}

// Search drugs
export const searchDrugs = async (searchTerm) => {
  const term = sanitizeSearchTerm(searchTerm)
  if (!term) {
    return getAllDrugs()
  }

  const drugs = await getAllDrugs()
  return drugs.filter((drug) => {
    const name = String(drug.name || '').toLowerCase()
    const batchNumber = String(drug.batch_number || '').toLowerCase()
    return name.includes(term) || batchNumber.includes(term)
  })
}

// Get low stock drugs
export const getLowStockDrugs = async () => {
  const { data, error } = await supabase
    .from('low_stock_drugs')
    .select('*')
  
  if (error) throw error
  return (data || []).filter(shouldAlertForDrug)
}

// Get expiring drugs (within 30 days)
export const getExpiringDrugs = async () => {
  const { data, error } = await supabase
    .from('expiring_soon_drugs')
    .select('*')
  
  if (error) throw error
  return (data || []).filter(shouldAlertForDrug)
}

// Get expired drugs
export const getExpiredDrugs = async () => {
  const { data, error } = await supabase
    .from('expired_drugs')
    .select('*')
  
  if (error) throw error
  return (data || []).filter(shouldAlertForDrug)
}

// Calculate drug status based on quantity and expiry
export const calculateDrugStatus = (drug) => {
  if (isDefaultCatalogDrug(drug) && Number.parseFloat(drug.quantity ?? 0) <= 0) {
    return 'catalog'
  }

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
