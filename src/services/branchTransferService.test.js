import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))

vi.mock('../lib/supabase', () => ({ supabase: { rpc, from } }))

import {
  TRANSFER_STATUS,
  canCancelTransfer,
  canReceiveTransfer,
  canSendFromBranch,
  cancelBranchTransfer,
  describeActor,
  dispatchBranchTransfer,
  listBranchTransfers,
  receiveBranchTransfer,
  rejectBranchTransfer,
  summarizeTransfer,
} from './branchTransferService'

// A chainable, awaitable query stub: every method returns the same object, awaiting it gives `result`.
const query = (result) => {
  const stub = {}
  ;['select', 'order', 'limit', 'eq', 'in', 'maybeSingle'].forEach((name) => { stub[name] = vi.fn(() => stub) })
  stub.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return stub
}

const transfer = (overrides = {}) => ({
  id: 't1',
  status: 'pending',
  source_branch_id: 'main',
  destination_branch_id: 'b1',
  created_by: 'sender',
  items: [
    { id: 'i1', medicine_name: 'Paracetamol', quantity_sent: '30.00', quantity_received: null },
    { id: 'i2', medicine_name: 'Amoxicillin', quantity_sent: '10.00', quantity_received: null },
  ],
  ...overrides,
})

describe('branchTransferService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rpc.mockResolvedValue({ data: { transfer_id: 't1', transfer_number: 'TRF-000001', status: 'pending' }, error: null })
  })

  describe('dispatchBranchTransfer', () => {
    it('sends the lines to the database function with normalized quantities', async () => {
      const result = await dispatchBranchTransfer({
        sourceBranchId: ' main ',
        destinationBranchId: 'b1',
        items: [{ drugId: 'd1', quantity: 30 }, { drugId: 'd2', quantity: '2.5' }],
        notes: '  weekly top-up ',
      })
      expect(result.transfer_number).toBe('TRF-000001')
      expect(rpc).toHaveBeenCalledWith('create_branch_stock_transfer', {
        p_source_branch_id: 'main',
        p_destination_branch_id: 'b1',
        p_items: [{ drug_id: 'd1', quantity: '30' }, { drug_id: 'd2', quantity: '2.5' }],
        p_notes: 'weekly top-up',
      })
    })

    it.each([
      [{ sourceBranchId: '', destinationBranchId: 'b1', items: [{ drugId: 'd', quantity: 1 }] }, 'stock is leaving'],
      [{ sourceBranchId: 'a', destinationBranchId: '', items: [{ drugId: 'd', quantity: 1 }] }, 'going to'],
      [{ sourceBranchId: 'a', destinationBranchId: 'a', items: [{ drugId: 'd', quantity: 1 }] }, 'two different branches'],
      [{ sourceBranchId: 'a', destinationBranchId: 'b', items: [] }, 'at least one medicine'],
      [{ sourceBranchId: 'a', destinationBranchId: 'b', items: [{ drugId: '', quantity: 1 }] }, 'choose a medicine'],
      [{ sourceBranchId: 'a', destinationBranchId: 'b', items: [{ drugId: 'd', quantity: 0 }] }, 'above zero'],
      [{ sourceBranchId: 'a', destinationBranchId: 'b', items: [{ drugId: 'd', quantity: -2 }] }, 'above zero'],
      [{ sourceBranchId: 'a', destinationBranchId: 'b', items: [{ drugId: 'd', quantity: '1.234' }] }, '2 decimals'],
      [{ sourceBranchId: 'a', destinationBranchId: 'b', items: [{ drugId: 'd', quantity: '1e3' }] }, 'above zero'],
    ])('rejects bad input before calling the database (%#)', async (input, message) => {
      await expect(dispatchBranchTransfer(input)).rejects.toThrow(new RegExp(message, 'i'))
      expect(rpc).not.toHaveBeenCalled()
    })

    it('refuses more than 100 lines', async () => {
      const items = Array.from({ length: 101 }, (_, i) => ({ drugId: `d${i}`, quantity: 1 }))
      await expect(dispatchBranchTransfer({ sourceBranchId: 'a', destinationBranchId: 'b', items })).rejects.toThrow('at most 100')
    })

    it('surfaces the database error message', async () => {
      rpc.mockResolvedValue({ data: null, error: { message: 'Not enough Paracetamol in stock: 5 available, 30 requested.' } })
      await expect(dispatchBranchTransfer({ sourceBranchId: 'a', destinationBranchId: 'b', items: [{ drugId: 'd', quantity: 30 }] }))
        .rejects.toThrow('Not enough Paracetamol')
    })
  })

  describe('receiveBranchTransfer', () => {
    it('accepts everything when no lines are given', async () => {
      await receiveBranchTransfer({ transferId: 't1' })
      expect(rpc).toHaveBeenCalledWith('receive_branch_stock_transfer', { p_transfer_id: 't1', p_items: null, p_notes: null })
    })

    it('sends the counted quantity of every line', async () => {
      await receiveBranchTransfer({
        transferId: 't1',
        lines: [{ itemId: 'i1', quantityReceived: '25' }, { itemId: 'i2', quantityReceived: 10 }],
        notes: 'one pack damaged',
      })
      expect(rpc).toHaveBeenCalledWith('receive_branch_stock_transfer', {
        p_transfer_id: 't1',
        p_items: [{ item_id: 'i1', quantity_received: '25' }, { item_id: 'i2', quantity_received: '10' }],
        p_notes: 'one pack damaged',
      })
    })

    it('allows zero for a line but rejects blanks and negatives', async () => {
      await receiveBranchTransfer({ transferId: 't1', lines: [{ itemId: 'i1', quantityReceived: '0' }, { itemId: 'i2', quantityReceived: '4' }] })
      expect(rpc).toHaveBeenCalledTimes(1)
      await expect(receiveBranchTransfer({ transferId: 't1', lines: [{ itemId: 'i1', quantityReceived: '' }] })).rejects.toThrow('zero or more')
      await expect(receiveBranchTransfer({ transferId: 't1', lines: [{ itemId: 'i1', quantityReceived: '-1' }] })).rejects.toThrow('zero or more')
      expect(rpc).toHaveBeenCalledTimes(1)
    })
  })

  describe.each([
    ['reject', rejectBranchTransfer, 'reject_branch_stock_transfer'],
    ['cancel', cancelBranchTransfer, 'cancel_branch_stock_transfer'],
  ])('%s', (_name, action, rpcName) => {
    it('needs a reason of at least 5 characters', async () => {
      await expect(action({ transferId: 't1', reason: 'no' })).rejects.toThrow('at least 5')
      expect(rpc).not.toHaveBeenCalled()
      await action({ transferId: 't1', reason: '  Wrong strength sent ' })
      expect(rpc).toHaveBeenCalledWith(rpcName, { p_transfer_id: 't1', p_reason: 'Wrong strength sent' })
    })
  })

  describe('listBranchTransfers', () => {
    it('loads transfers with their lines and attaches staff names', async () => {
      const rows = [
        { ...transfer(), created_by: 'u1', resolved_by: 'u2', items: [{ medicine_name: 'Zinc' }, { medicine_name: 'Amoxicillin' }] },
      ]
      const transfers = query({ data: rows, error: null })
      const users = query({ data: [{ id: 'u1', full_name: 'Ama Mensah' }, { id: 'u2', full_name: 'Kofi Boateng' }], error: null })
      from.mockImplementation((table) => (table === 'branch_stock_transfers' ? transfers : users))

      const [row] = await listBranchTransfers()
      expect(transfers.select).toHaveBeenCalledWith('*, items:branch_stock_transfer_items(*)')
      expect(row.created_by_name).toBe('Ama Mensah')
      expect(row.resolved_by_name).toBe('Kofi Boateng')
      expect(row.items.map((item) => item.medicine_name)).toEqual(['Amoxicillin', 'Zinc'])
    })

    it('still lists transfers when staff names cannot be read', async () => {
      const transfers = query({ data: [transfer()], error: null })
      const users = query({ data: null, error: { message: 'denied' } })
      from.mockImplementation((table) => (table === 'branch_stock_transfers' ? transfers : users))
      const [row] = await listBranchTransfers()
      expect(row.created_by_name).toBe('')
    })

    it('reports a load failure', async () => {
      from.mockImplementation(() => query({ data: null, error: { message: 'boom' } }))
      await expect(listBranchTransfers()).rejects.toThrow('boom')
    })
  })

  describe('summarizeTransfer', () => {
    it('totals what was sent and flags a short receipt', () => {
      const received = transfer({
        status: 'received',
        items: [
          { id: 'i1', quantity_sent: '30', quantity_received: '25' },
          { id: 'i2', quantity_sent: '10', quantity_received: '10' },
        ],
      })
      expect(summarizeTransfer(received)).toEqual({ lines: 2, totalSent: 40, totalReceived: 35, shortfall: 5, hasDiscrepancy: true })
      expect(summarizeTransfer(transfer())).toEqual({ lines: 2, totalSent: 40, totalReceived: 0, shortfall: 0, hasDiscrepancy: false })
    })

    it('does not call a rejected transfer a discrepancy', () => {
      expect(summarizeTransfer(transfer({ status: 'rejected' })).hasDiscrepancy).toBe(false)
    })
  })

  describe('who sees which buttons', () => {
    const admin = describeActor({ role: 'admin', profile: { id: 'a1' } })
    const managerB1 = describeActor({ role: 'branch_manager', profile: { id: 'm1', branch_id: 'b1' } })
    const managerB2 = describeActor({ role: 'branch_manager', profile: { id: 'm2', branch_id: 'b2' } })
    const managerOrg = describeActor({ role: 'branch_manager', profile: { id: 'm3', branch_id: null } })
    const sender = describeActor({ role: 'pharmacist', profile: { id: 'sender', branch_id: 'main' } })
    const otherPharmacist = describeActor({ role: 'pharmacist', profile: { id: 'p2', branch_id: 'b1' } })
    const extraRole = describeActor({ role: 'pharmacist', assignedRoles: ['pharmacist', 'branch_manager'], profile: { id: 'x', branch_id: 'b1' } })

    it('lets an administrator, or the manager of the receiving branch, confirm receipt', () => {
      expect(canReceiveTransfer(admin, transfer())).toBe(true)
      expect(canReceiveTransfer(managerB1, transfer())).toBe(true)
      expect(canReceiveTransfer(managerOrg, transfer())).toBe(true)
      expect(canReceiveTransfer(extraRole, transfer())).toBe(true)
    })

    it('keeps everyone else out', () => {
      expect(canReceiveTransfer(managerB2, transfer())).toBe(false)
      expect(canReceiveTransfer(sender, transfer())).toBe(false)
      expect(canReceiveTransfer(otherPharmacist, transfer())).toBe(false)
    })

    it('stops receiving once the transfer is settled', () => {
      Object.values(TRANSFER_STATUS).filter((status) => status !== 'pending').forEach((status) => {
        expect(canReceiveTransfer(admin, transfer({ status }))).toBe(false)
        expect(canCancelTransfer(admin, transfer({ status }))).toBe(false)
      })
    })

    it('lets the sender, an administrator or the sending branch manager cancel', () => {
      expect(canCancelTransfer(sender, transfer())).toBe(true)
      expect(canCancelTransfer(admin, transfer())).toBe(true)
      expect(canCancelTransfer(describeActor({ role: 'branch_manager', profile: { id: 'mm', branch_id: 'main' } }), transfer())).toBe(true)
      expect(canCancelTransfer(otherPharmacist, transfer())).toBe(false)
      expect(canCancelTransfer(managerB1, transfer())).toBe(false)
    })

    it('limits branch-bound staff to sending from their own branch', () => {
      expect(canSendFromBranch(sender, 'main')).toBe(true)
      expect(canSendFromBranch(sender, 'b1')).toBe(false)
      expect(canSendFromBranch(admin, 'b1')).toBe(true)
      expect(canSendFromBranch(managerOrg, 'b2')).toBe(true)
    })
  })
})
