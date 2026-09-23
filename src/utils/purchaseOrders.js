// Purchase-order lifecycle helpers shared by the Purchases page and its modals.
//
//   draft -> ordered -> partially_received -> completed (fully received)
//   draft / ordered / partially_received -> cancelled
//
// 'completed' is the "fully received" state (kept so existing purchases keep working).

export const PURCHASE_STATUS_LABELS = {
  draft: 'Draft',
  ordered: 'Ordered',
  partially_received: 'Partially received',
  completed: 'Received',
  cancelled: 'Cancelled',
}

export const getPurchaseStatusLabel = (status) => PURCHASE_STATUS_LABELS[status] || status || 'Draft'

// Statuses a purchase can be tabbed/filtered by on the Purchases page.
export const PURCHASE_STATUS_TABS = ['all', 'draft', 'ordered', 'partially_received', 'completed', 'cancelled']

export const canPlaceOrder = (purchase) => purchase?.status === 'draft'
export const canReceiveGoods = (purchase) =>
  purchase?.status === 'ordered' || purchase?.status === 'partially_received'
export const canCancelOrder = (purchase) =>
  purchase?.status === 'draft' || canReceiveGoods(purchase)
// A reason is only required once the order has actually been placed with a supplier.
export const cancellationNeedsReason = (purchase) => purchase?.status !== 'draft'

const toNumber = (value) => Number.parseFloat(value) || 0

export const getOrderedQuantity = (item) => toNumber(item?.quantity)
export const getReceivedQuantity = (item) => toNumber(item?.received_quantity)
export const getOutstandingQuantity = (item) =>
  Math.max(0, getOrderedQuantity(item) - getReceivedQuantity(item))

export const getOrderTotals = (purchase) => {
  const items = purchase?.purchase_items || []
  return items.reduce(
    (totals, item) => ({
      ordered: totals.ordered + getOrderedQuantity(item),
      received: totals.received + getReceivedQuantity(item),
      outstanding: totals.outstanding + getOutstandingQuantity(item),
    }),
    { ordered: 0, received: 0, outstanding: 0 }
  )
}

// Rows for the receive form: one per item that still has something outstanding,
// defaulting the received quantity to everything outstanding and the cost/batch/expiry
// to what the order recorded. Staff change them to match the delivery note.
export const buildInitialReceiptLines = (purchase) =>
  (purchase?.purchase_items || [])
    .filter((item) => getOutstandingQuantity(item) > 0)
    .map((item) => ({
      key: `${item.id}-0`,
      itemId: item.id,
      quantity: String(getOutstandingQuantity(item)),
      batchNumber: item.batch_number || '',
      expiryDate: item.expiry_date || '',
      unitCost: item.unit_cost == null ? '' : String(item.unit_cost),
    }))

// Returns { errors: string[], lines: [...] } where lines are only those with a quantity.
// The database re-checks all of this; this is for immediate, readable feedback.
export const validateReceiptLines = (formLines, purchase) => {
  const errors = []
  const items = new Map((purchase?.purchase_items || []).map((item) => [item.id, item]))
  const filled = formLines.filter((line) => String(line.quantity).trim() !== '' && toNumber(line.quantity) !== 0)

  if (filled.length === 0) errors.push('Enter the quantity received for at least one item.')

  const totals = new Map()
  for (const line of filled) {
    const quantity = Number.parseFloat(line.quantity)
    const item = items.get(line.itemId)
    if (!item) {
      errors.push('A line does not belong to this order.')
      continue
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push(`${item.drug_name}: quantity must be above zero.`)
      continue
    }
    if (line.unitCost !== '' && !(Number.parseFloat(line.unitCost) >= 0)) {
      errors.push(`${item.drug_name}: unit cost must be zero or more.`)
    }
    totals.set(line.itemId, (totals.get(line.itemId) || 0) + quantity)
  }

  for (const [itemId, total] of totals) {
    const item = items.get(itemId)
    const outstanding = getOutstandingQuantity(item)
    if (total > outstanding) {
      errors.push(`${item.drug_name}: receiving ${total} but only ${outstanding} is outstanding.`)
    }
  }

  return { errors, lines: filled }
}

export const toReceiptPayload = (validLines) =>
  validLines.map((line) => ({
    purchaseItemId: line.itemId,
    quantity: Number.parseFloat(line.quantity),
    batchNumber: line.batchNumber,
    expiryDate: line.expiryDate,
    unitCost: line.unitCost,
  }))

// One key per receiving session: a retry or double click re-sends the same key, and the
// database refuses to post the same receipt twice.
export const createReceiptKey = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `receipt-${Date.now()}-${Math.random().toString(16).slice(2)}`
