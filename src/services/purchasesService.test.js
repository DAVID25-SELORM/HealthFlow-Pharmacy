import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  shouldUseBranchServer: vi.fn(),
  updateBranchRecord: vi.fn(),
  tryLogAuditEvent: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: vi.fn(),
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

import { completePurchase } from './purchasesService'

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
