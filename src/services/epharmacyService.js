import { invokeTierAccess } from './tierAccessService'

export const EPHARMACY_SALE_CLASSES = [
  { value: 'otc', label: 'OTC' },
  { value: 'prescription', label: 'Prescription' },
  { value: 'restricted', label: 'Restricted' },
  { value: 'controlled', label: 'Controlled' },
  { value: 'narcotic', label: 'Narcotic' },
]

export const EPHARMACY_BLOCKED_CLASSES = new Set(['restricted', 'controlled', 'narcotic'])
export const EPHARMACY_REVIEW_CLASSES = new Set(['prescription', 'restricted', 'controlled', 'narcotic'])

export const EPHARMACY_STATUS_LABELS = {
  pending_review: 'Pending Review',
  approved: 'Approved',
  rejected: 'Rejected',
  paid: 'Paid',
  packed: 'Packed',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}

export const normalizeEpharmacySaleClass = (value) => {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '_')
  return EPHARMACY_SALE_CLASSES.some((item) => item.value === normalized) ? normalized : 'otc'
}

export const formatEpharmacyStatus = (status) =>
  EPHARMACY_STATUS_LABELS[status] || String(status || 'pending_review').replace(/_/g, ' ')

export const isEpharmacyRestrictedClass = (saleClass) =>
  EPHARMACY_BLOCKED_CLASSES.has(normalizeEpharmacySaleClass(saleClass))

export const requiresEpharmacyReview = (saleClass, explicitRequirement = false) =>
  Boolean(explicitRequirement) || EPHARMACY_REVIEW_CLASSES.has(normalizeEpharmacySaleClass(saleClass))

export const getEpharmacySurplusQuantity = (drug = {}) => {
  const quantity = Number(drug.quantity || 0)
  const reorderLevel = Number(drug.reorder_level || drug.reorderLevel || 0)
  return Math.max(0, quantity - Math.max(0, reorderLevel))
}

export const isEpharmacyListingAvailable = (listing = {}) => {
  const saleClass = normalizeEpharmacySaleClass(listing.sale_class || listing.epharmacy_sale_class)
  const expiryDate = listing.expiry_date ? new Date(`${listing.expiry_date}T23:59:59`) : null
  const isExpired = !expiryDate || Number.isNaN(expiryDate.getTime()) || expiryDate.getTime() < Date.now()

  return (
    !isExpired &&
    !isEpharmacyRestrictedClass(saleClass) &&
    Boolean(listing.epharmacy_interfacility_visible ?? true) &&
    getEpharmacySurplusQuantity(listing) > 0
  )
}

export const getEpharmacyMarketplace = async (filters = {}) => {
  return await invokeTierAccess({
    action: 'get_epharmacy_marketplace',
    searchTerm: String(filters.searchTerm || '').trim(),
    facilityId: String(filters.facilityId || '').trim(),
    limit: filters.limit || 120,
  })
}

export const saveEpharmacyProfile = async (profile) => {
  return await invokeTierAccess({
    action: 'save_epharmacy_profile',
    profile,
  })
}

export const updateEpharmacyListingControls = async (drugId, controls) => {
  const saleClass = normalizeEpharmacySaleClass(controls.saleClass)
  const isPublishing =
    Boolean(controls.visible) ||
    Boolean(controls.interfacilityVisible) ||
    Boolean(controls.customerVisible)

  if (isPublishing && isEpharmacyRestrictedClass(saleClass)) {
    throw new Error('Restricted, controlled, and narcotic medicines cannot be published for online ordering.')
  }

  return await invokeTierAccess({
    action: 'update_epharmacy_listing_controls',
    drugId,
    controls: {
      ...controls,
      saleClass,
      requiresPrescription: requiresEpharmacyReview(saleClass, controls.requiresPrescription),
    },
  })
}

export const createEpharmacyOrder = async (order) => {
  const items = Array.isArray(order.items) ? order.items : []
  if (!items.length) {
    throw new Error('Add at least one medicine to the order.')
  }

  return await invokeTierAccess({
    action: 'create_epharmacy_order',
    order: {
      ...order,
      items: items.map((item) => ({
        drugId: item.drugId,
        quantity: Number(item.quantity || 0),
      })),
    },
  })
}

export const updateEpharmacyOrderStatus = async ({
  orderId,
  status,
  note = '',
  rejectionReason = '',
}) => {
  return await invokeTierAccess({
    action: 'update_epharmacy_order_status',
    orderId,
    status,
    note,
    rejectionReason,
  })
}
