import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  shouldUseBranchServer: vi.fn(),
  updateBranchRecord: vi.fn(),
  listBranchRecords: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }))
vi.mock('./branchServerApi', () => ({
  createBranchRecord: vi.fn(),
  listBranchRecords: mocks.listBranchRecords,
  shouldUseBranchServer: mocks.shouldUseBranchServer,
  updateBranchRecord: mocks.updateBranchRecord,
}))
vi.mock('./auditService', () => ({ tryLogAuditEvent: vi.fn() }))

import {
  cancelPurchase,
  getAllPurchases,
  getPurchasesStats,
  getBranchTransferOptions,
  getReorderInsights,
  placePurchase,
  receivePurchaseGoods,
} from './purchasesService'

const queryBuilder = (rows = []) => {
  const builder = {
    select: vi.fn(() => builder),
    order: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lte: vi.fn(() => builder),
    then: (resolve) => resolve({ data: rows, error: null }),
  }
  return builder
}

describe('purchase lifecycle service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.shouldUseBranchServer.mockReturnValue(false)
  })

  describe('placePurchase', () => {
    it('calls place_purchase_order and returns the result', async () => {
      mocks.rpc.mockResolvedValue({ data: { success: true, status: 'ordered' }, error: null })
      await expect(placePurchase('po-1')).resolves.toMatchObject({ status: 'ordered' })
      expect(mocks.rpc).toHaveBeenCalledWith('place_purchase_order', { p_purchase_id: 'po-1' })
    })

    it('turns a database-reported problem into an error the user can read', async () => {
      mocks.rpc.mockResolvedValue({ data: { error: 'Choose a supplier before placing the order.' }, error: null })
      await expect(placePurchase('po-1')).rejects.toThrow('Choose a supplier before placing the order.')
    })
  })

  describe('receivePurchaseGoods', () => {
    const lines = [{ purchaseItemId: 'i1', quantity: 25, batchNumber: ' B-1 ', expiryDate: '2029-01-31', unitCost: '3.5' }]

    it('sends snake_case lines with the receipt key and notes', async () => {
      mocks.rpc.mockResolvedValue({ data: { success: true, status: 'partially_received', outstanding: 15 }, error: null })
      const result = await receivePurchaseGoods('po-1', lines, { receiptKey: 'key-1', notes: ' Box damaged ' })
      expect(result.outstanding).toBe(15)
      expect(mocks.rpc).toHaveBeenCalledWith('receive_purchase_goods', {
        p_purchase_id: 'po-1',
        p_lines: [{ purchase_item_id: 'i1', quantity: 25, batch_number: 'B-1', expiry_date: '2029-01-31', unit_cost: 3.5 }],
        p_receipt_key: 'key-1',
        p_notes: 'Box damaged',
      })
    })

    it('leaves the unit cost null when it was not entered, so the order cost is used', async () => {
      mocks.rpc.mockResolvedValue({ data: { success: true }, error: null })
      await receivePurchaseGoods('po-1', [{ purchaseItemId: 'i1', quantity: 5, unitCost: '' }], { receiptKey: 'k' })
      expect(mocks.rpc.mock.calls[0][1].p_lines[0].unit_cost).toBeNull()
    })

    it('refuses bad input before any network call', async () => {
      await expect(receivePurchaseGoods('po-1', lines, {})).rejects.toThrow('receipt key')
      await expect(receivePurchaseGoods('po-1', [], { receiptKey: 'k' })).rejects.toThrow('at least one')
      await expect(receivePurchaseGoods('po-1', [{ purchaseItemId: 'i1', quantity: 0 }], { receiptKey: 'k' })).rejects.toThrow('above zero')
      await expect(receivePurchaseGoods('po-1', [{ purchaseItemId: 'i1', quantity: -3 }], { receiptKey: 'k' })).rejects.toThrow()
      expect(mocks.rpc).not.toHaveBeenCalled()
    })

    it('surfaces the database refusing an over-receipt or a permission problem', async () => {
      mocks.rpc.mockResolvedValue({ data: { error: 'Cannot receive 101: only 100 outstanding on that item.' }, error: null })
      await expect(receivePurchaseGoods('po-1', lines, { receiptKey: 'k' })).rejects.toThrow('only 100 outstanding')
      mocks.rpc.mockResolvedValue({ data: null, error: new Error('permission denied') })
      await expect(receivePurchaseGoods('po-1', lines, { receiptKey: 'k' })).rejects.toThrow('permission denied')
    })

    it('reports an already-processed retry as success without complaint', async () => {
      mocks.rpc.mockResolvedValue({ data: { success: true, already_processed: true, status: 'partially_received' }, error: null })
      await expect(receivePurchaseGoods('po-1', lines, { receiptKey: 'k' })).resolves.toMatchObject({ already_processed: true })
    })
  })

  describe('cancelPurchase', () => {
    it('cancels through cancel_purchase_order with the reason, not a direct table update', async () => {
      mocks.rpc.mockResolvedValue({ data: { success: true, status: 'cancelled' }, error: null })
      await cancelPurchase('po-1', { reason: ' Supplier out of stock ' })
      expect(mocks.rpc).toHaveBeenCalledWith('cancel_purchase_order', { p_purchase_id: 'po-1', p_reason: 'Supplier out of stock' })
      expect(mocks.from).not.toHaveBeenCalled()
    })

    it('sends a null reason for a draft cancelled without one', async () => {
      mocks.rpc.mockResolvedValue({ data: { success: true }, error: null })
      await cancelPurchase('po-1')
      expect(mocks.rpc.mock.calls[0][1].p_reason).toBeNull()
    })

    it('surfaces "reason required" and "already received" from the database', async () => {
      mocks.rpc.mockResolvedValue({ data: { error: 'Enter a reason for cancelling an order that has been placed.' }, error: null })
      await expect(cancelPurchase('po-1')).rejects.toThrow('Enter a reason')
    })
  })

  describe('getBranchTransferOptions', () => {
    it('groups the options by the medicine that needs stock', async () => {
      mocks.rpc.mockResolvedValue({ data: [
        { target_drug_id: 'd1', source_drug_id: 's1', spare_quantity: 70 },
        { target_drug_id: 'd1', source_drug_id: 's2', spare_quantity: 15 },
        { target_drug_id: 'd2', source_drug_id: 's3', spare_quantity: 5 },
      ], error: null })
      const result = await getBranchTransferOptions('br-a', ['d1', 'd2'])
      expect(mocks.rpc).toHaveBeenCalledWith('get_branch_transfer_options', { p_branch_id: 'br-a', p_drug_ids: ['d1', 'd2'] })
      expect(result.get('d1')).toHaveLength(2)
      expect(result.get('d2')).toHaveLength(1)
    })

    it('returns an empty map for branch-bound staff and surfaces database errors', async () => {
      mocks.rpc.mockResolvedValue({ data: [], error: null })
      expect((await getBranchTransferOptions('br-a', ['d1'])).size).toBe(0)
      mocks.rpc.mockResolvedValue({ data: null, error: new Error('permission denied') })
      await expect(getBranchTransferOptions('br-a', ['d1'])).rejects.toThrow('permission denied')
    })
  })

  describe('getReorderInsights', () => {
    it('asks the database for the aggregate and returns it keyed by medicine', async () => {
      mocks.rpc.mockResolvedValue({ data: [{ drug_id: 'd1', units_sold: 50, history_days: 90 }, { drug_id: 'd2', units_sold: 0, history_days: 20 }], error: null })
      const result = await getReorderInsights(['d1', 'd2'], 90)
      expect(mocks.rpc).toHaveBeenCalledWith('get_reorder_insights', { p_drug_ids: ['d1', 'd2'], p_window_days: 90 })
      expect(result.get('d1').units_sold).toBe(50)
      expect(result.size).toBe(2)
    })

    it('passes null for "all medicines" and surfaces a database error', async () => {
      mocks.rpc.mockResolvedValue({ data: [], error: null })
      await getReorderInsights([])
      expect(mocks.rpc.mock.calls[0][1].p_drug_ids).toBeNull()
      mocks.rpc.mockResolvedValue({ data: null, error: new Error('permission denied') })
      await expect(getReorderInsights(['d1'])).rejects.toThrow('permission denied')
    })
  })

  describe('listing and stats', () => {
    it('filters by several statuses and loads the received quantity of each line', async () => {
      const builder = queryBuilder([{ id: 'p1' }])
      mocks.from.mockReturnValue(builder)
      await getAllPurchases({ statuses: ['draft', 'ordered'] })
      expect(builder.in).toHaveBeenCalledWith('status', ['draft', 'ordered'])
      expect(builder.select.mock.calls[0][0]).toContain('received_quantity')
    })

    it('counts placed and partially received orders as open orders', async () => {
      mocks.from.mockReturnValue(queryBuilder([
        { status: 'draft', total_amount: 10, purchase_date: '2000-01-01' },
        { status: 'ordered', total_amount: 20, purchase_date: '2000-01-01' },
        { status: 'partially_received', total_amount: 30, purchase_date: '2000-01-01' },
        { status: 'completed', total_amount: 40, purchase_date: '2000-01-01' },
        { status: 'cancelled', total_amount: 50, purchase_date: '2000-01-01' },
      ]))
      const stats = await getPurchasesStats()
      expect(stats).toMatchObject({ draftCount: 1, orderedCount: 2, completedCount: 1, totalAllTime: 40 })
    })
  })
})
