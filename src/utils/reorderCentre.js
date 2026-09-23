// Shared logic for the Reorder Centre and the Inventory page's Reorder actions.
// Kept separate from drugService's calculateDrugStatus, which also factors in
// expiry and drives the Inventory status badge/filter — that calculation is
// unchanged by this file. Stock severity here is a purchasing-urgency signal,
// not a replacement for it.
import { isDefaultCatalogDrug } from '../services/drugService'

export const STOCK_SEVERITY = {
  OUT_OF_STOCK: 'out_of_stock',
  CRITICAL: 'critical',
  LOW: 'low',
  OK: 'ok',
}

// A drug is "critical" once it falls to this fraction of its reorder level.
// Documented here rather than hidden in a formula; not yet an org setting.
export const CRITICAL_STOCK_RATIO = 0.25

const STOCK_SEVERITY_META = {
  [STOCK_SEVERITY.OUT_OF_STOCK]: { label: 'Out of stock', badgeClass: 'severity-out-of-stock' },
  [STOCK_SEVERITY.CRITICAL]: { label: 'Critical', badgeClass: 'severity-critical' },
  [STOCK_SEVERITY.LOW]: { label: 'Low stock', badgeClass: 'severity-low' },
  [STOCK_SEVERITY.OK]: { label: 'OK', badgeClass: 'severity-ok' },
}

export const getStockSeverityLabel = (severity) => STOCK_SEVERITY_META[severity]?.label || 'OK'
export const getStockSeverityBadgeClass = (severity) =>
  STOCK_SEVERITY_META[severity]?.badgeClass || 'severity-ok'

// A catalog reference row that has never actually been stocked (quantity 0,
// placeholder batch) is not something to reorder — same exclusion drugService
// already applies to low-stock alerts and the Inventory status badge.
export const isReorderRelevantDrug = (drug) =>
  String(drug?.status || 'active').toLowerCase() !== 'inactive' &&
  (!isDefaultCatalogDrug(drug) || Number.parseFloat(drug?.quantity ?? 0) > 0)

export const getReorderLevel = (drug) => Number.parseFloat(drug?.reorder_level ?? 10) || 0

// target_stock_level is optional. When unset, fall back to the reorder level for
// this one calculation only — the fallback is never written back to the drug.
export const getEffectiveTargetStockLevel = (drug) => {
  const target = Number.parseFloat(drug?.target_stock_level)
  if (Number.isFinite(target)) return target
  return getReorderLevel(drug)
}

export const getStockSeverity = (drug) => {
  if (!isReorderRelevantDrug(drug)) return STOCK_SEVERITY.OK
  const quantity = Number.parseFloat(drug?.quantity ?? 0) || 0
  const reorderLevel = getReorderLevel(drug)
  if (quantity <= 0) return STOCK_SEVERITY.OUT_OF_STOCK
  if (quantity <= reorderLevel * CRITICAL_STOCK_RATIO) return STOCK_SEVERITY.CRITICAL
  if (quantity <= reorderLevel) return STOCK_SEVERITY.LOW
  return STOCK_SEVERITY.OK
}

export const needsReorderAttention = (drug) => getStockSeverity(drug) !== STOCK_SEVERITY.OK

// suggested = max(0, target - current - already on order). Never negative.
export const getSuggestedReorderQuantity = (drug, alreadyOnOrder = 0) => {
  const target = getEffectiveTargetStockLevel(drug)
  const quantity = Number.parseFloat(drug?.quantity ?? 0) || 0
  const outstanding = Number.parseFloat(alreadyOnOrder) || 0
  return Math.max(0, Math.ceil(target - quantity - outstanding))
}

// The one line-item shape both Inventory's Reorder actions and the Reorder
// Centre send to Purchases via location.state.reorderItems (see Purchases.jsx).
// A single definition so the two pages can never quietly drift apart.
export const buildReorderLineItem = (drug, alreadyOnOrder = 0, supplierOverride) => ({
  drugId: drug.id,
  drugName: drug.name,
  brandName: drug.brand_name || '',
  genericName: drug.generic_name || '',
  unit: drug.unit || 'tablet',
  unitCost: drug.cost_price || drug.price || '',
  saleOnReturn: Boolean(drug.sale_on_return),
  supplier: supplierOverride !== undefined ? supplierOverride : (drug.supplier || ''),
  alreadyOnOrder,
  suggestedQuantity: getSuggestedReorderQuantity(drug, alreadyOnOrder),
})

export const getEstimatedReorderValue = (drug, suggestedQuantity) => {
  const unitCost = Number.parseFloat(drug?.cost_price) || Number.parseFloat(drug?.price) || 0
  return unitCost * (Number.parseFloat(suggestedQuantity) || 0)
}

// One purchase order per supplier — mixing suppliers into one order is not
// something the current purchase workflow supports, and the spec asks that it
// not be forced. Items with no supplier on file are grouped separately so
// staff can assign one before an order can be created for them.
export const NO_SUPPLIER_GROUP_KEY = '__supplier_required__'

export const groupReorderItemsBySupplier = (items) => {
  const groups = new Map()
  for (const item of items) {
    const supplierName = String(item.supplier || '').trim()
    const key = supplierName || NO_SUPPLIER_GROUP_KEY
    if (!groups.has(key)) groups.set(key, { supplier: supplierName || null, items: [] })
    groups.get(key).items.push(item)
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.supplier) return 1
    if (!b.supplier) return -1
    return a.supplier.localeCompare(b.supplier)
  })
}
