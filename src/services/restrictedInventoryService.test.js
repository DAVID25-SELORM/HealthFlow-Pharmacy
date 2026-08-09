import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('../lib/supabase', () => ({
  supabase: { rpc: mocks.rpc },
}))

import {
  getRestrictedInventory,
  getRestrictedInventoryAudit,
  updateRestrictedInventoryStatus,
} from './restrictedInventoryService'

describe('restrictedInventoryService', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads restricted stock through the audited organization-scoped RPC', async () => {
    mocks.rpc.mockResolvedValue({ data: [{ id: 'item-1' }], error: null })

    await expect(getRestrictedInventory(' org-1 ')).resolves.toEqual([{ id: 'item-1' }])
    expect(mocks.rpc).toHaveBeenCalledWith('get_restricted_inventory', {
      p_organization_id: 'org-1',
    })
  })

  it('loads one item audit trail through the audited RPC', async () => {
    mocks.rpc.mockResolvedValue({ data: [{ action: 'viewed' }], error: null })

    await getRestrictedInventoryAudit('org-1', 'item-1')
    expect(mocks.rpc).toHaveBeenCalledWith('get_restricted_inventory_audit', {
      p_organization_id: 'org-1',
      p_restricted_inventory_id: 'item-1',
    })
  })

  it('requires an organization and a reason before making requests', async () => {
    await expect(getRestrictedInventory('')).rejects.toThrow('Select a Chemical Shop')
    await expect(updateRestrictedInventoryStatus('item-1', 'destroyed', '  '))
      .rejects.toThrow('Enter a reason')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('records status changes with a trimmed reason', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null })

    await updateRestrictedInventoryStatus('item-1', 'returned_to_supplier', ' Returned to wholesaler ')
    expect(mocks.rpc).toHaveBeenCalledWith('update_restricted_inventory_status', {
      p_restricted_inventory_id: 'item-1',
      p_status: 'returned_to_supplier',
      p_reason: 'Returned to wholesaler',
    })
  })
})
