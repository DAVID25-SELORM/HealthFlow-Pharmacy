import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  shouldUseBranchServer: vi.fn(),
  updateBranchRecord: vi.fn(),
  tryLogAuditEvent: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
  },
}))

vi.mock('./branchServerApi', () => ({
  createBranchRecord: vi.fn(),
  listBranchRecords: vi.fn(),
  shouldUseBranchServer: mocks.shouldUseBranchServer,
  updateBranchRecord: mocks.updateBranchRecord,
}))

vi.mock('./auditService', () => ({
  tryLogAuditEvent: mocks.tryLogAuditEvent,
}))

import { completePurchase, createPurchase } from './purchasesService'

describe('purchasesService.completePurchase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.shouldUseBranchServer.mockReturnValue(false)
    mocks.rpc.mockResolvedValue({ data: { success: true, items_updated: 2 }, error: null })
    mocks.tryLogAuditEvent.mockResolvedValue(undefined)
  })

  it('blocks purchase completion without approval permission', async () => {
    await expect(completePurchase('purchase-1')).rejects.toThrow(
      'You do not have permission to approve purchases.'
    )
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('completes a purchase when approval permission is present', async () => {
    await expect(
      completePurchase('purchase-1', { canApprove: true })
    ).resolves.toEqual({ success: true, items_updated: 2 })

    expect(mocks.rpc).toHaveBeenCalledWith('complete_purchase', {
      p_purchase_id: 'purchase-1',
    })
  })
})

describe('purchasesService.createPurchase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.shouldUseBranchServer.mockReturnValue(false)
  })

  const validItem = {
    drugName: 'Paracetamol',
    quantity: 10,
    unit: 'tablet',
    unitCost: 1,
    discountPercent: 0,
    netTotal: 10,
  }

  it('validates all items before writing the purchase header', async () => {
    await expect(
      createPurchase({}, [{ ...validItem, quantity: -1 }])
    ).rejects.toThrow('Quantity')
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('returns an existing client-id purchase instead of inserting a duplicate', async () => {
    const existingPurchase = {
      id: 'purchase-1',
      status: 'draft',
      purchase_items: [{ id: 'item-1' }],
    }
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: existingPurchase, error: null })),
    }
    mocks.from.mockReturnValue(query)

    await expect(
      createPurchase({ id: 'purchase-1' }, [validItem])
    ).resolves.toEqual(existingPurchase)

    expect(mocks.from).toHaveBeenCalledTimes(1)
    expect(mocks.from).toHaveBeenCalledWith('purchases')
  })
})
