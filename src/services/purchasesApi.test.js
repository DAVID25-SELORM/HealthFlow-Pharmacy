import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cancelPurchase: vi.fn(),
  completePurchase: vi.fn(),
  createPurchase: vi.fn(),
  createSupplier: vi.fn(),
  getAllPurchases: vi.fn(),
  getAllSuppliers: vi.fn(),
  getConnectivityState: vi.fn(),
  getOfflinePurchasesSummary: vi.fn(),
  getPurchaseCompletionDetails: vi.fn(),
  getPurchasesStats: vi.fn(),
  placePurchase: vi.fn(),
  receivePurchaseGoods: vi.fn(),
  getPurchaseReceipts: vi.fn(),
  getUserDisplayName: vi.fn(),
  queueOfflinePurchaseDraft: vi.fn(),
  refreshConnectivityState: vi.fn(),
  subscribeOfflinePurchasesQueue: vi.fn(),
  syncOfflinePurchases: vi.fn(),
}))

vi.mock('./purchasesService', () => ({
  cancelPurchase: mocks.cancelPurchase,
  completePurchase: mocks.completePurchase,
  createPurchase: mocks.createPurchase,
  createSupplier: mocks.createSupplier,
  getAllPurchases: mocks.getAllPurchases,
  getAllSuppliers: mocks.getAllSuppliers,
  getPurchaseCompletionDetails: mocks.getPurchaseCompletionDetails,
  getPurchasesStats: mocks.getPurchasesStats,
  placePurchase: mocks.placePurchase,
  receivePurchaseGoods: mocks.receivePurchaseGoods,
  getPurchaseReceipts: mocks.getPurchaseReceipts,
  getUserDisplayName: mocks.getUserDisplayName,
}))

vi.mock('./offlinePurchasesQueue', () => ({
  getOfflinePurchasesSummary: mocks.getOfflinePurchasesSummary,
  queueOfflinePurchaseDraft: mocks.queueOfflinePurchaseDraft,
  subscribeOfflinePurchasesQueue: mocks.subscribeOfflinePurchasesQueue,
  syncOfflinePurchases: mocks.syncOfflinePurchases,
}))

vi.mock('./connectivityService', () => ({
  getConnectivityState: mocks.getConnectivityState,
  refreshConnectivityState: mocks.refreshConnectivityState,
}))

import {
  cancelPurchaseDraft,
  completePurchaseDraft,
  createPurchaseDraft,
  getOpenOrderQuantitiesByDrug,
  placePurchaseOrder,
  receivePurchaseOrderGoods,
} from './purchasesApi'

describe('purchasesApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getConnectivityState.mockReturnValue({
      internetAvailable: true,
      branchServerAvailable: false,
    })
    mocks.refreshConnectivityState.mockResolvedValue({
      internetAvailable: true,
      branchServerAvailable: false,
    })
  })

  it('creates a draft with a stable client id', async () => {
    mocks.createPurchase.mockImplementation(async (purchase) => purchase)

    const result = await createPurchaseDraft(
      { supplierName: 'Supplier' },
      [{ drugName: 'Medicine' }],
      { organizationId: 'org-1' }
    )

    expect(result.id).toBeTruthy()
    expect(mocks.createPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ id: result.id }),
      [{ drugName: 'Medicine' }]
    )
  })

  it('queues a draft after a genuine offline network failure', async () => {
    mocks.createPurchase.mockRejectedValue(new TypeError('Failed to fetch'))
    mocks.refreshConnectivityState.mockResolvedValue({
      internetAvailable: false,
      branchServerAvailable: false,
    })
    mocks.queueOfflinePurchaseDraft.mockResolvedValue({
      id: 'queue-1',
      status: 'pending',
    })

    await expect(
      createPurchaseDraft(
        { id: 'purchase-1', supplierName: 'Supplier', branchId: 'branch-1' },
        [{ drugName: 'Medicine' }],
        { organizationId: 'org-1', createdBy: 'user-1' }
      )
    ).resolves.toEqual({
      id: 'purchase-1',
      offlineQueued: true,
      queueId: 'queue-1',
      syncStatus: 'pending',
    })
  })

  it('queues a network outage even when the browser still reports online', async () => {
    mocks.createPurchase.mockRejectedValue(new TypeError('Failed to fetch'))
    mocks.refreshConnectivityState.mockResolvedValue({
      internetAvailable: true,
      branchServerAvailable: false,
    })
    mocks.queueOfflinePurchaseDraft.mockResolvedValue({
      id: 'queue-2',
      status: 'pending',
    })

    const result = await createPurchaseDraft(
      { id: 'purchase-2' },
      [{ drugName: 'Medicine' }],
      { organizationId: 'org-1' }
    )

    expect(result.offlineQueued).toBe(true)
  })

  it('does not queue validation errors while offline', async () => {
    const error = new Error('Add at least one item to the purchase.')
    mocks.createPurchase.mockRejectedValue(error)
    mocks.refreshConnectivityState.mockResolvedValue({
      internetAvailable: false,
      branchServerAvailable: false,
    })

    await expect(
      createPurchaseDraft({}, [], { organizationId: 'org-1' })
    ).rejects.toBe(error)
    expect(mocks.queueOfflinePurchaseDraft).not.toHaveBeenCalled()
  })

  it('blocks completion and cancellation without internet', async () => {
    mocks.refreshConnectivityState.mockResolvedValue({
      internetAvailable: false,
      branchServerAvailable: true,
    })

    await expect(
      completePurchaseDraft('purchase-1', { canApprove: true })
    ).rejects.toThrow('requires internet')
    await expect(cancelPurchaseDraft('purchase-1')).rejects.toThrow(
      'requires internet'
    )
    expect(mocks.completePurchase).not.toHaveBeenCalled()
    expect(mocks.cancelPurchase).not.toHaveBeenCalled()
  })
})

describe('getOpenOrderQuantitiesByDrug (open orders)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks only for purchases that are still open', async () => {
    mocks.getAllPurchases.mockResolvedValue([])
    await getOpenOrderQuantitiesByDrug()
    expect(mocks.getAllPurchases).toHaveBeenCalledWith({ statuses: ['draft', 'ordered', 'partially_received'] })
  })

  it('counts a draft in full and sums across open purchases', async () => {
    mocks.getAllPurchases.mockResolvedValue([
      { purchase_number: 'PO-1', status: 'draft', purchase_items: [{ drug_id: 'drug-1', quantity: 20 }, { drug_id: 'drug-2', quantity: 5 }] },
      { purchase_number: 'PO-2', status: 'ordered', purchase_items: [{ drug_id: 'drug-1', quantity: 10, received_quantity: 0 }] },
    ])
    const result = await getOpenOrderQuantitiesByDrug()
    expect(result.get('drug-1').quantity).toBe(30)
    expect(result.get('drug-2').quantity).toBe(5)
    expect(result.has('drug-3')).toBe(false)
  })

  it('subtracts what has already been received, so only the outstanding quantity counts', async () => {
    mocks.getAllPurchases.mockResolvedValue([
      { purchase_number: 'PO-3', status: 'partially_received', purchase_items: [{ drug_id: 'drug-1', quantity: 100, received_quantity: 60 }] },
    ])
    expect((await getOpenOrderQuantitiesByDrug()).get('drug-1').quantity).toBe(40)
  })

  it('ignores fully received lines, cancelled or completed purchases, and lines with no medicine', async () => {
    mocks.getAllPurchases.mockResolvedValue([
      { purchase_number: 'PO-4', status: 'partially_received', purchase_items: [{ drug_id: 'drug-1', quantity: 10, received_quantity: 10 }, { drug_id: null, quantity: 5 }] },
      { purchase_number: 'PO-5', status: 'cancelled', purchase_items: [{ drug_id: 'drug-2', quantity: 50 }] },
      { purchase_number: 'PO-6', status: 'completed', purchase_items: [{ drug_id: 'drug-3', quantity: 50, received_quantity: 50 }] },
    ])
    expect((await getOpenOrderQuantitiesByDrug()).size).toBe(0)
  })
})

describe('placing and receiving orders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.refreshConnectivityState.mockResolvedValue({ internetAvailable: true, branchServerAvailable: false })
  })

  it('places and receives through the service when online', async () => {
    mocks.placePurchase.mockResolvedValue({ status: 'ordered' })
    mocks.receivePurchaseGoods.mockResolvedValue({ status: 'partially_received' })
    await placePurchaseOrder('po-1')
    await receivePurchaseOrderGoods('po-1', [{ purchaseItemId: 'i1', quantity: 5 }], { receiptKey: 'k' })
    expect(mocks.placePurchase).toHaveBeenCalledWith('po-1')
    expect(mocks.receivePurchaseGoods).toHaveBeenCalledWith('po-1', [{ purchaseItemId: 'i1', quantity: 5 }], { receiptKey: 'k' })
  })

  it('never queues a stock-posting or status action offline', async () => {
    mocks.refreshConnectivityState.mockResolvedValue({ internetAvailable: false, branchServerAvailable: true })
    await expect(placePurchaseOrder('po-1')).rejects.toThrow('requires internet')
    await expect(receivePurchaseOrderGoods('po-1', [{}], { receiptKey: 'k' })).rejects.toThrow('requires internet')
    expect(mocks.placePurchase).not.toHaveBeenCalled()
    expect(mocks.receivePurchaseGoods).not.toHaveBeenCalled()
  })

  it('passes the cancellation reason through', async () => {
    mocks.cancelPurchase.mockResolvedValue({ status: 'cancelled' })
    await cancelPurchaseDraft('po-1', { reason: 'Supplier out of stock' })
    expect(mocks.cancelPurchase).toHaveBeenCalledWith('po-1', { reason: 'Supplier out of stock' })
  })
})
