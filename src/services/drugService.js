import { supabase } from '../lib/supabase'
import { assertNonNegativeNumber, assertRequiredText, normalizeText, sanitizeSearchTerm } from '../utils/validation'
import { invokeTierAccess } from './tierAccessService'
import { getBranchInventory } from './branchServerApi'
import { routeRead } from './apiRouter'
// ✅ NHIS PHARMACY LEVEL PATCH START
import { normalizeMedicineAccessLevel, normalizePharmacyLevel } from '../utils/nhisPharmacyLevel'
// ✅ NHIS PHARMACY LEVEL PATCH END

/**
 * Drug/Inventory Service
 * Handles all drug inventory operations
 */

export const DEFAULT_MEDICATION_BATCH_PREFIX = 'PDF-IMP-'
const DRUGS_PER_PAGE = 1000
const DEFAULT_SEARCH_LIMIT = 30
const MAX_SEARCH_LIMIT = 100

export const isDefaultCatalogDrug = (drug) =>
  String(drug?.batch_number || drug?.batch || '').toUpperCase().startsWith(DEFAULT_MEDICATION_BATCH_PREFIX)

const shouldShowDrugOutsideInventory = (drug) =>
  !isDefaultCatalogDrug(drug) || Number.parseFloat(drug?.quantity ?? 0) > 0

const shouldAlertForDrug = (drug) =>
  !isDefaultCatalogDrug(drug) || Number.parseFloat(drug?.quantity ?? 0) > 0

const isInactiveDrug = (drug) => String(drug?.status || 'active').toLowerCase() === 'inactive'

const assertSafeDrugName = (value) => {
  const name = assertRequiredText(value, 'Drug name')
  if (/[<>]/.test(name)) {
    throw new Error('Drug name cannot contain HTML or script characters.')
  }
  return name
}

const normalizeDrugSearchTokens = (value) =>
  sanitizeSearchTerm(value)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

const drugMatchesSearch = (drug, term) => {
  const normalizedTerm = sanitizeSearchTerm(term)
  if (!normalizedTerm) {
    return true
  }

  const haystack = [
    drug?.name,
    drug?.batch_number,
    drug?.batch,
    drug?.category,
    drug?.description,
    drug?.supplier,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (haystack.includes(normalizedTerm)) {
    return true
  }

  const tokens = normalizeDrugSearchTokens(normalizedTerm)
  return tokens.some((token) => haystack.includes(token))
}

const filterSearchRows = (rows, { term = '', includeCatalog = false, inStockOnly = false, limit = DEFAULT_SEARCH_LIMIT } = {}) =>
  (rows || [])
    .filter((drug) => !isInactiveDrug(drug))
    .filter((drug) => includeCatalog || shouldShowDrugOutsideInventory(drug))
    .filter((drug) => !inStockOnly || Number.parseFloat(drug?.quantity ?? 0) > 0)
    .filter((drug) => drugMatchesSearch(drug, term))
    .slice(0, limit)

const getAllDrugsDirectly = async (branchId = null) => {
  const rows = []
  let from = 0

  while (true) {
    const to = from + DRUGS_PER_PAGE - 1
    let query = supabase
      .from('drugs')
      .select('*')
      .order('name')
      .order('id')

    if (branchId) {
      query = query.eq('branch_id', branchId)
    }

    const { data, error } = await query.range(from, to)

    if (error) {
      throw error
    }

    rows.push(...(data || []))

    if (!data || data.length < DRUGS_PER_PAGE) {
      break
    }

    from += DRUGS_PER_PAGE
  }

  return rows.filter((drug) => !isInactiveDrug(drug))
}

const getAllDrugsViaTierAccess = async (includeCatalog = false, branchId = null) => {
  const payload = {
    action: 'get_drugs',
    includeCatalog,
  }

  if (branchId) {
    payload.branchId = branchId
  }

  const response = await invokeTierAccess(payload)

  return (response.drugs || []).filter((drug) => !isInactiveDrug(drug))
}

// Get all drugs
export const getAllDrugs = async (options = {}) => {
  const includeCatalog = Boolean(options.includeCatalog)
  const useTierAccess = Boolean(options.useTierAccess)
  const branchId = normalizeText(options.branchId) || null

  // ✅ OFFLINE-FIRST PATCH START
  return await routeRead({
    label: 'inventory',
    local: async () => await getBranchInventory({ limit: 20000 }),
    cloud: async () => {
      if (includeCatalog || useTierAccess || branchId) {
        return getAllDrugsViaTierAccess(includeCatalog, branchId)
      }

      const drugs = await getAllDrugsDirectly(branchId)
      return drugs.filter(shouldShowDrugOutsideInventory)
    },
    fallback: [],
  })
  // ✅ OFFLINE-FIRST PATCH END
}

const getSearchLimit = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SEARCH_LIMIT
  }

  return Math.min(parsed, MAX_SEARCH_LIMIT)
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
  const name = assertSafeDrugName(drugData.name)
  const batchNumber = normalizeText(drugData.batchNumber) || null

  const response = await invokeTierAccess({
    action: 'create_drug',
    drug: {
      name,
      batchNumber,
      expiryDate: drugData.expiryDate,
      quantity: assertNonNegativeNumber(drugData.quantity, 'Quantity'),
      price: assertNonNegativeNumber(drugData.price, 'Price'),
      costPrice: assertNonNegativeNumber(drugData.costPrice || 0, 'Cost price'),
      nhisCode: normalizeText(drugData.nhisCode) || null,
      nhisPrice:
        drugData.nhisPrice === undefined || drugData.nhisPrice === null || drugData.nhisPrice === ''
          ? null
          : assertNonNegativeNumber(drugData.nhisPrice, 'NHIS price'),
      nhisUnit: normalizeText(drugData.nhisUnit) || null,
      isNhisListed: Boolean(drugData.isNhisListed),
      // ✅ NHIS PHARMACY LEVEL PATCH START
      medicineAccessLevel: normalizeMedicineAccessLevel(drugData.medicineAccessLevel) || null,
      requiredPharmacyLevel: normalizePharmacyLevel(drugData.requiredPharmacyLevel) || null,
      // ✅ NHIS PHARMACY LEVEL PATCH END
      supplier: normalizeText(drugData.supplier) || null,
      category: normalizeText(drugData.category) || null,
      description: normalizeText(drugData.description) || null,
      reorderLevel: assertNonNegativeNumber(drugData.reorderLevel || 10, 'Reorder level'),
      unit: normalizeText(drugData.unit) || 'tablet',
      saleOnReturn: Boolean(drugData.saleOnReturn),
      branchId: normalizeText(drugData.branchId) || null,
    },
  })

  if (!response?.drug?.id) {
    throw new Error('Drug was not created correctly. Please try again.')
  }

  return {
    ...response.drug,
    _saveAction: response.action || 'create',
  }
}

// Update drug
export const updateDrug = async (id, drugData) => {
  const name = assertSafeDrugName(drugData.name)
  const batchNumber = normalizeText(drugData.batchNumber) || null
  const payload = {
    name,
    batchNumber,
    expiryDate: drugData.expiryDate,
    quantity: assertNonNegativeNumber(drugData.quantity, 'Quantity'),
    price: assertNonNegativeNumber(drugData.price, 'Price'),
    supplier: normalizeText(drugData.supplier) || null,
    saleOnReturn: Boolean(drugData.saleOnReturn),
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
    payload.unit = normalizeText(drugData.unit) || 'tablet'
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'nhisCode')) {
    payload.nhisCode = normalizeText(drugData.nhisCode) || null
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'nhisPrice')) {
    payload.nhisPrice =
      drugData.nhisPrice === undefined || drugData.nhisPrice === null || drugData.nhisPrice === ''
        ? null
        : assertNonNegativeNumber(drugData.nhisPrice, 'NHIS price')
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'nhisUnit')) {
    payload.nhisUnit = normalizeText(drugData.nhisUnit) || null
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'isNhisListed')) {
    payload.isNhisListed = Boolean(drugData.isNhisListed)
  }

  // ✅ NHIS PHARMACY LEVEL PATCH START
  if (Object.prototype.hasOwnProperty.call(drugData, 'medicineAccessLevel')) {
    payload.medicineAccessLevel = normalizeMedicineAccessLevel(drugData.medicineAccessLevel) || null
  }

  if (Object.prototype.hasOwnProperty.call(drugData, 'requiredPharmacyLevel')) {
    payload.requiredPharmacyLevel = normalizePharmacyLevel(drugData.requiredPharmacyLevel) || null
  }
  // ✅ NHIS PHARMACY LEVEL PATCH END

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

export const transferDrugToBranch = async ({
  drugId,
  destinationBranchId,
  quantity,
  notes = '',
}) => {
  const { data, error } = await supabase.rpc('transfer_drug_to_branch', {
    p_drug_id: assertRequiredText(drugId, 'Drug'),
    p_destination_branch_id: assertRequiredText(destinationBranchId, 'Destination branch'),
    p_quantity: assertNonNegativeNumber(quantity, 'Transfer quantity'),
    p_notes: normalizeText(notes) || null,
  })

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }

  return data
}

// Search drugs
export const searchDrugs = async (searchTerm, options = {}) => {
  const term = sanitizeSearchTerm(searchTerm)
  const limit = getSearchLimit(options.limit)
  const includeCatalog = Boolean(options.includeCatalog)
  const useTierAccess = Boolean(options.useTierAccess)
  const inStockOnly = Boolean(options.inStockOnly)
  const tokens = normalizeDrugSearchTokens(term)
  const branchId = normalizeText(options.branchId) || null

  if (useTierAccess) {
    const loadMatches = async (queryTerm) => {
      const payload = {
        action: 'get_drugs',
        includeCatalog,
        searchTerm: queryTerm,
        limit,
        inStockOnly,
      }

      if (branchId) {
        payload.branchId = branchId
      }

      const response = await invokeTierAccess(payload)

      return filterSearchRows(response.drugs || [], {
        term,
        includeCatalog,
        inStockOnly,
        limit,
      })
    }

    const matches = await loadMatches(term)
    if (matches.length > 0 || tokens.length <= 1) {
      return matches
    }

    return loadMatches(tokens[0])
  }

  let query = supabase
    .from('drugs')
    .select('*')
    .eq('status', 'active')
    .order('name')
    .order('id')
    .limit(limit)

  if (term) {
    const searchParts = [term, ...tokens]
      .map((part) => part.replace(/[%_,]/g, ''))
      .filter(Boolean)
      .flatMap((part) => [
        `name.ilike.%${part}%`,
        `batch_number.ilike.%${part}%`,
        `category.ilike.%${part}%`,
        `description.ilike.%${part}%`,
        `supplier.ilike.%${part}%`,
      ])

    query = query.or([...new Set(searchParts)].join(','))
  }

  if (inStockOnly) {
    query = query.gt('quantity', 0)
  }

  if (branchId) {
    query = query.eq('branch_id', branchId)
  }

  const { data, error } = await query

  if (error) {
    throw error
  }

  return filterSearchRows(data || [], {
    term,
    includeCatalog,
    inStockOnly,
    limit,
  })
}

// Get low stock drugs
export const getLowStockDrugs = async () => {
  // ✅ OFFLINE-FIRST PATCH START
  return await routeRead({
    label: 'low stock alerts',
    local: async () => {
      const rows = await getBranchInventory({ limit: 20000 })
      return rows.filter((drug) =>
        shouldAlertForDrug(drug) &&
        Number.parseFloat(drug?.quantity ?? 0) <= Number.parseFloat(drug?.reorder_level ?? drug?.reorderLevel ?? 10)
      )
    },
    cloud: async () => {
      const { data, error } = await supabase
        .from('low_stock_drugs')
        .select('*')

      if (error) throw error
      return (data || []).filter(shouldAlertForDrug)
    },
    fallback: [],
  })
  // ✅ OFFLINE-FIRST PATCH END
}

// Get expiring drugs (within 30 days)
export const getExpiringDrugs = async () => {
  // ✅ OFFLINE-FIRST PATCH START
  return await routeRead({
    label: 'expiring inventory alerts',
    local: async () => {
      const today = new Date()
      const soon = new Date(today)
      soon.setDate(soon.getDate() + 30)
      return (await getBranchInventory({ limit: 20000 })).filter((drug) => {
        if (!shouldAlertForDrug(drug) || !drug?.expiry_date) return false
        const expiry = new Date(drug.expiry_date)
        return expiry >= today && expiry <= soon
      })
    },
    cloud: async () => {
      const { data, error } = await supabase
        .from('expiring_soon_drugs')
        .select('*')

      if (error) throw error
      return (data || []).filter(shouldAlertForDrug)
    },
    fallback: [],
  })
  // ✅ OFFLINE-FIRST PATCH END
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
