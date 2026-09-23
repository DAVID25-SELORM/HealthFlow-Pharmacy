import { describe, expect, it } from 'vitest'
import {
  buildInitialReceiptLines,
  canCancelOrder,
  canPlaceOrder,
  canReceiveGoods,
  cancellationNeedsReason,
  getOrderTotals,
  getOutstandingQuantity,
  getPurchaseStatusLabel,
  toReceiptPayload,
  validateReceiptLines,
} from './purchaseOrders'

const purchase = (overrides = {}) => ({
  id: 'p1',
  status: 'ordered',
  purchase_items: [
    { id: 'i1', drug_name: 'Amoxicillin', quantity: 100, received_quantity: 60, unit_cost: 2.5, batch_number: 'B1', expiry_date: '2028-01-01' },
    { id: 'i2', drug_name: 'Ibuprofen', quantity: 10, received_quantity: 10, unit_cost: 1 },
    { id: 'i3', drug_name: 'Vitamin C', quantity: 20, received_quantity: 0, unit_cost: 0.5 },
  ],
  ...overrides,
})

describe('status rules', () => {
  it('labels the lifecycle, mapping the existing completed status to Received', () => {
    expect(getPurchaseStatusLabel('completed')).toBe('Received')
    expect(getPurchaseStatusLabel('partially_received')).toBe('Partially received')
    expect(getPurchaseStatusLabel('ordered')).toBe('Ordered')
  })

  it('only drafts can be placed; only placed, unfinished orders can be received', () => {
    expect(canPlaceOrder(purchase({ status: 'draft' }))).toBe(true)
    expect(canPlaceOrder(purchase({ status: 'ordered' }))).toBe(false)
    expect(canReceiveGoods(purchase({ status: 'draft' }))).toBe(false)
    expect(canReceiveGoods(purchase({ status: 'ordered' }))).toBe(true)
    expect(canReceiveGoods(purchase({ status: 'partially_received' }))).toBe(true)
    expect(canReceiveGoods(purchase({ status: 'completed' }))).toBe(false)
    expect(canReceiveGoods(purchase({ status: 'cancelled' }))).toBe(false)
  })

  it('cannot cancel a received or already-cancelled order, and needs a reason once placed', () => {
    expect(canCancelOrder(purchase({ status: 'draft' }))).toBe(true)
    expect(canCancelOrder(purchase({ status: 'partially_received' }))).toBe(true)
    expect(canCancelOrder(purchase({ status: 'completed' }))).toBe(false)
    expect(canCancelOrder(purchase({ status: 'cancelled' }))).toBe(false)
    expect(cancellationNeedsReason(purchase({ status: 'draft' }))).toBe(false)
    expect(cancellationNeedsReason(purchase({ status: 'ordered' }))).toBe(true)
  })
})

describe('ordered / received / outstanding', () => {
  it('computes outstanding as ordered minus received, never negative', () => {
    expect(getOutstandingQuantity({ quantity: 100, received_quantity: 60 })).toBe(40)
    expect(getOutstandingQuantity({ quantity: 10, received_quantity: 10 })).toBe(0)
    expect(getOutstandingQuantity({ quantity: 10, received_quantity: 12 })).toBe(0)
    expect(getOutstandingQuantity({ quantity: 10 })).toBe(10)
  })

  it('totals ordered, received and outstanding across an order', () => {
    expect(getOrderTotals(purchase())).toEqual({ ordered: 130, received: 70, outstanding: 60 })
  })
})

describe('buildInitialReceiptLines', () => {
  it('offers only items with something outstanding, defaulting to receive everything outstanding', () => {
    const lines = buildInitialReceiptLines(purchase())
    expect(lines.map((l) => l.itemId)).toEqual(['i1', 'i3'])
    expect(lines[0]).toMatchObject({ quantity: '40', batchNumber: 'B1', expiryDate: '2028-01-01', unitCost: '2.5' })
  })
})

describe('validateReceiptLines', () => {
  const line = (itemId, quantity, extra = {}) => ({ key: `${itemId}-${quantity}`, itemId, quantity, batchNumber: '', expiryDate: '', unitCost: '', ...extra })

  it('accepts a partial delivery', () => {
    const result = validateReceiptLines([line('i1', '25'), line('i3', '')], purchase())
    expect(result.errors).toEqual([])
    expect(result.lines).toHaveLength(1)
  })

  it('requires at least one quantity', () => {
    expect(validateReceiptLines([line('i1', ''), line('i3', '')], purchase()).errors[0]).toMatch(/at least one/)
  })

  it('rejects receiving more than is outstanding, including across split batches', () => {
    expect(validateReceiptLines([line('i1', '41')], purchase()).errors[0]).toMatch(/only 40 is outstanding/)
    const split = validateReceiptLines([line('i1', '25'), line('i1', '20', { key: 'i1-b' })], purchase())
    expect(split.errors[0]).toMatch(/receiving 45 but only 40/)
  })

  it('rejects negative quantities and costs', () => {
    expect(validateReceiptLines([line('i1', '-5')], purchase()).errors[0]).toMatch(/above zero/)
    expect(validateReceiptLines([line('i1', '5', { unitCost: '-1' })], purchase()).errors.join(' ')).toMatch(/unit cost/)
  })

  it('builds the payload the service expects', () => {
    const { lines } = validateReceiptLines([line('i1', '25', { batchNumber: 'B2', expiryDate: '2029-02-01', unitCost: '3' })], purchase())
    expect(toReceiptPayload(lines)).toEqual([{ purchaseItemId: 'i1', quantity: 25, batchNumber: 'B2', expiryDate: '2029-02-01', unitCost: '3' }])
  })
})
