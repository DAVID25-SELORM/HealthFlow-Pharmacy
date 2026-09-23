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

describe('getOpenOrderQuantitiesByDrug (Reorder Centre phase 1)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sums quantity per drug across every open (draft) purchase', async () => {
    mocks.getAllPurchases.mockResolvedValue([
      {
        purchase_number: 'PO-000001',
        purchase_items: [
          { drug_id: 'drug-1', quantity: 20 },
          { drug_id: 'drug-2', quantity: 5 },
        ],
      },
      {
        purchase_number: 'PO-000002',
        purchase_items: [{ drug_id: 'drug-1', quantity: 10 }],
      },
    ])

    const result = await getOpenOrderQuantitiesByDrug()

    expect(mocks.getAllPurchases).toHaveBeenCalledWith({ status: 'draft' })
    expect(result.get('drug-1').quantity).toBe(30)
    expect(result.get('drug-2').quantity).toBe(5)
    expect(result.has('drug-3')).toBe(false)
  })

  it('ignores line items with no drug_id and returns an empty map when there are no drafts', async () => {
    mocks.getAllPurchases.mockResolvedValue([
      { purchase_number: 'PO-000003', purchase_items: [{ drug_id: null, quantity: 5 }] },
    ])

    const result = await getOpenOrderQuantitiesByDrug()
    expect(result.size).toBe(0)
  })
})
