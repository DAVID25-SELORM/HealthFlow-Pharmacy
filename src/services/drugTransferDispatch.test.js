import { beforeEach, describe, expect, it, vi } from 'vitest'

const { from, dispatchBranchTransfer } = vi.hoisted(() => ({ from: vi.fn(), dispatchBranchTransfer: vi.fn() }))

vi.mock('../lib/supabase', () => ({
  getCachedSupabaseSession: vi.fn().mockReturnValue({}),
  supabase: { from },
}))
vi.mock('./tierAccessService', () => ({ invokeTierAccess: vi.fn() }))
vi.mock('./branchServerApi', () => ({ getBranchInventory: vi.fn(), deleteBranchInventoryDrug: vi.fn() }))
vi.mock('./apiRouter', () => ({ routeRead: vi.fn(), routeWrite: vi.fn() }))
vi.mock('./branchTransferService', () => ({ dispatchBranchTransfer }))

import { transferDrugToBranch } from './drugService'

const drugLookup = (result) => {
  const stub = {}
  ;['select', 'eq'].forEach((name) => { stub[name] = vi.fn(() => stub) })
  stub.maybeSingle = vi.fn().mockResolvedValue(result)
  return stub
}

describe('transferDrugToBranch (shared by Inventory and the Reorder Centre)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dispatchBranchTransfer.mockResolvedValue({ transfer_number: 'TRF-000007', status: 'pending' })
  })

  it('dispatches a confirmed transfer from the branch the medicine is stocked in', async () => {
    const lookup = drugLookup({ data: { branch_id: 'main' }, error: null })
    from.mockReturnValue(lookup)

    const result = await transferDrugToBranch({ drugId: 'drug-1', destinationBranchId: 'branch-2', quantity: '12', notes: ' top-up ' })

    expect(from).toHaveBeenCalledWith('drugs')
    expect(lookup.eq).toHaveBeenCalledWith('id', 'drug-1')
    expect(dispatchBranchTransfer).toHaveBeenCalledWith({
      sourceBranchId: 'main',
      destinationBranchId: 'branch-2',
      items: [{ drugId: 'drug-1', quantity: 12 }],
      notes: 'top-up',
    })
    expect(result.transfer_number).toBe('TRF-000007')
  })

  it('does not use the old instant transfer function', async () => {
    from.mockReturnValue(drugLookup({ data: { branch_id: 'main' }, error: null }))
    await transferDrugToBranch({ drugId: 'drug-1', destinationBranchId: 'branch-2', quantity: 1 })
    const { supabase } = await import('../lib/supabase')
    expect(supabase.rpc).toBeUndefined()
  })

  it('refuses a medicine that is not assigned to a branch', async () => {
    from.mockReturnValue(drugLookup({ data: { branch_id: null }, error: null }))
    await expect(transferDrugToBranch({ drugId: 'drug-1', destinationBranchId: 'branch-2', quantity: 1 }))
      .rejects.toThrow('not assigned to a branch')
    expect(dispatchBranchTransfer).not.toHaveBeenCalled()
  })

  it('passes a lookup failure through', async () => {
    from.mockReturnValue(drugLookup({ data: null, error: new Error('offline') }))
    await expect(transferDrugToBranch({ drugId: 'drug-1', destinationBranchId: 'branch-2', quantity: 1 }))
      .rejects.toThrow('offline')
  })

  it('still validates the quantity', async () => {
    from.mockReturnValue(drugLookup({ data: { branch_id: 'main' }, error: null }))
    await expect(transferDrugToBranch({ drugId: 'drug-1', destinationBranchId: 'branch-2', quantity: 'abc' }))
      .rejects.toThrow()
    expect(dispatchBranchTransfer).not.toHaveBeenCalled()
  })
})
