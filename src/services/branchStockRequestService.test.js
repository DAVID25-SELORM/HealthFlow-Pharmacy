import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))

vi.mock('../lib/supabase', () => ({ supabase: { rpc, from } }))

import {
  approveBranchStockRequest,
  canAskForStock,
  canCancelRequest,
  canDecideRequest,
  cancelBranchStockRequest,
  countStockWork,
  createBranchStockRequest,
  declineBranchStockRequest,
  listBranchStockRequests,
  requestNeedsMyAction,
  searchBranchStockForRequest,
  summarizeRequest,
} from './branchStockRequestService'
import { describeActor } from './branchTransferService'

const query = (result) => {
  const stub = {}
  ;['select', 'order', 'limit', 'eq', 'in'].forEach((name) => { stub[name] = vi.fn(() => stub) })
  stub.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return stub
}

const request = (overrides = {}) => ({
  id: 'r1',
  status: 'pending',
  requesting_branch_id: 'b1',
  source_branch_id: 'main',
  created_by: 'asker',
  items: [
    { id: 'i1', medicine_name: 'Paracetamol', quantity_requested: '40.00', quantity_approved: null },
    { id: 'i2', medicine_name: 'Amoxicillin', quantity_requested: '5.00', quantity_approved: null },
  ],
  ...overrides,
})

const admin = describeActor({ role: 'admin', profile: { id: 'a1', branch_id: null } })
const mainPharmacist = describeActor({ role: 'pharmacist', profile: { id: 'p1', branch_id: 'main' } })
const lapazManager = describeActor({ role: 'branch_manager', profile: { id: 'm1', branch_id: 'b1' } })
const lapazPharmacist = describeActor({ role: 'pharmacist', profile: { id: 'p2', branch_id: 'b1' } })
const temaManager = describeActor({ role: 'branch_manager', profile: { id: 'm2', branch_id: 'b2' } })
const orgStaff = describeActor({ role: 'pharmacist', profile: { id: 'p3', branch_id: null } })

describe('branchStockRequestService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rpc.mockResolvedValue({ data: { request_id: 'r1', request_number: 'REQ-000001', status: 'pending' }, error: null })
  })

  it('sends a request with validated lines', async () => {
    await createBranchStockRequest({
      sourceBranchId: ' main ',
      requestingBranchId: 'b1',
      items: [{ drugId: 'd1', quantity: '40' }, { drugId: 'd2', quantity: '2.5' }],
      notes: '  Weekend  ',
    })
    expect(rpc).toHaveBeenCalledWith('create_branch_stock_request', {
      p_source_branch_id: 'main',
      p_requesting_branch_id: 'b1',
      p_items: [{ drug_id: 'd1', quantity: '40' }, { drug_id: 'd2', quantity: '2.5' }],
      p_notes: 'Weekend',
    })
  })

  it('refuses bad requests before calling the database', async () => {
    const base = { sourceBranchId: 'main', requestingBranchId: 'b1', items: [{ drugId: 'd1', quantity: '1' }] }
    await expect(createBranchStockRequest({ ...base, sourceBranchId: '' })).rejects.toThrow('Choose the branch you are asking')
    await expect(createBranchStockRequest({ ...base, requestingBranchId: 'main' })).rejects.toThrow('two different branches')
    await expect(createBranchStockRequest({ ...base, items: [] })).rejects.toThrow('at least one medicine')
    await expect(createBranchStockRequest({ ...base, items: [{ drugId: 'd1', quantity: '0' }] })).rejects.toThrow('above zero')
    await expect(createBranchStockRequest({ ...base, items: [{ drugId: 'd1', quantity: '1.234' }] })).rejects.toThrow('2 decimals')
    await expect(createBranchStockRequest({ ...base, items: [{ drugId: '', quantity: '1' }] })).rejects.toThrow('choose a medicine')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('searches only after two characters and returns an empty list otherwise', async () => {
    expect(await searchBranchStockForRequest({ sourceBranchId: 'main', term: 'p' })).toEqual([])
    expect(rpc).not.toHaveBeenCalled()
    rpc.mockResolvedValueOnce({ data: [{ id: 'd1', name: 'Paracetamol' }], error: null })
    const rows = await searchBranchStockForRequest({ sourceBranchId: 'main', term: ' para ', limit: 5 })
    expect(rows).toEqual([{ id: 'd1', name: 'Paracetamol' }])
    expect(rpc).toHaveBeenCalledWith('search_branch_stock_for_request', { p_source_branch_id: 'main', p_term: 'para', p_limit: 5 })
  })

  it('approves every line as asked, or with lowered and dropped quantities', async () => {
    await approveBranchStockRequest({ requestId: 'r1' })
    expect(rpc).toHaveBeenLastCalledWith('approve_branch_stock_request', { p_request_id: 'r1', p_items: null, p_notes: null })
    await approveBranchStockRequest({
      requestId: 'r1',
      lines: [{ itemId: 'i1', quantityApproved: '30' }, { itemId: 'i2', quantityApproved: '0' }],
      notes: 'Only 30 spare',
    })
    expect(rpc).toHaveBeenLastCalledWith('approve_branch_stock_request', {
      p_request_id: 'r1',
      p_items: [{ item_id: 'i1', quantity_approved: '30' }, { item_id: 'i2', quantity_approved: '0' }],
      p_notes: 'Only 30 spare',
    })
    await expect(approveBranchStockRequest({ requestId: 'r1', lines: [{ itemId: 'i1', quantityApproved: '-1' }] })).rejects.toThrow('zero or more')
    await expect(approveBranchStockRequest({ requestId: '' })).rejects.toThrow('Choose a request')
  })

  it('needs a reason of at least 5 characters to decline or cancel', async () => {
    await expect(declineBranchStockRequest({ requestId: 'r1', reason: 'no' })).rejects.toThrow('at least 5')
    await expect(cancelBranchStockRequest({ requestId: 'r1', reason: '   ' })).rejects.toThrow('at least 5')
    await declineBranchStockRequest({ requestId: 'r1', reason: ' Need it for Tema ' })
    expect(rpc).toHaveBeenLastCalledWith('decline_branch_stock_request', { p_request_id: 'r1', p_reason: 'Need it for Tema' })
    await cancelBranchStockRequest({ requestId: 'r1', reason: 'Ordered elsewhere' })
    expect(rpc).toHaveBeenLastCalledWith('cancel_branch_stock_request', { p_request_id: 'r1', p_reason: 'Ordered elsewhere' })
  })

  it('surfaces the database message when the function refuses', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Not enough Paracetamol in stock: 3 available, 5 requested.' } })
    await expect(approveBranchStockRequest({ requestId: 'r1' })).rejects.toThrow('Not enough Paracetamol')
  })

  it('lists requests with their lines and the names of the people involved', async () => {
    const requests = query({ data: [{ id: 'r1', created_by: 'u1', resolved_by: null, items: [{ medicine_name: 'Zinc' }, { medicine_name: 'Amoxicillin' }] }], error: null })
    const users = query({ data: [{ id: 'u1', full_name: 'Kofi Boateng' }], error: null })
    from.mockImplementation((table) => (table === 'branch_stock_requests' ? requests : users))
    const [row] = await listBranchStockRequests()
    expect(row.created_by_name).toBe('Kofi Boateng')
    expect(row.resolved_by_name).toBe('')
    expect(row.items.map((item) => item.medicine_name)).toEqual(['Amoxicillin', 'Zinc'])
  })

  it('reports a failed load, and still lists when the names cannot be read', async () => {
    from.mockImplementation(() => query({ data: null, error: { message: 'relation does not exist' } }))
    await expect(listBranchStockRequests()).rejects.toThrow('relation does not exist')
    const requests = query({ data: [{ id: 'r1', created_by: 'u1', items: [] }], error: null })
    const users = query({ data: null, error: { message: 'denied' } })
    from.mockImplementation((table) => (table === 'branch_stock_requests' ? requests : users))
    expect((await listBranchStockRequests())[0].created_by_name).toBe('')
  })

  it('totals a request', () => {
    expect(summarizeRequest(request())).toEqual({ lines: 2, totalRequested: 45, totalApproved: 0 })
    const approved = request({ status: 'approved', items: [{ quantity_requested: '40', quantity_approved: '30' }, { quantity_requested: '5', quantity_approved: '0' }] })
    expect(summarizeRequest(approved).totalApproved).toBe(30)
  })

  describe('countStockWork (the notification bell)', () => {
    const counting = (results) => {
      const calls = []
      from.mockImplementation((table) => {
        const stub = query(results[table] ?? { count: 0, error: null })
        stub.table = table
        calls.push(stub)
        return stub
      })
      return calls
    }

    it('counts every pending request and transfer for an administrator', async () => {
      const calls = counting({ branch_stock_requests: { count: 3, error: null }, branch_stock_transfers: { count: 2, error: null } })
      expect(await countStockWork(admin)).toEqual({ requestsToDecide: 3, transfersToConfirm: 2 })
      expect(calls.map((c) => c.table).sort()).toEqual(['branch_stock_requests', 'branch_stock_transfers'])
      expect(calls.every((c) => c.eq.mock.calls.length === 1 && c.eq.mock.calls[0][0] === 'status')).toBe(true) // no branch filter
    })

    it('limits a branch manager to requests for their own branch and transfers arriving at it', async () => {
      const calls = counting({ branch_stock_requests: { count: 1, error: null }, branch_stock_transfers: { count: 4, error: null } })
      expect(await countStockWork(lapazManager)).toEqual({ requestsToDecide: 1, transfersToConfirm: 4 })
      expect(calls.find((c) => c.table === 'branch_stock_requests').eq).toHaveBeenCalledWith('source_branch_id', 'b1')
      expect(calls.find((c) => c.table === 'branch_stock_transfers').eq).toHaveBeenCalledWith('destination_branch_id', 'b1')
    })

    it('does not look for transfers to confirm for staff who are not managers', async () => {
      const calls = counting({ branch_stock_requests: { count: 2, error: null } })
      expect(await countStockWork(mainPharmacist)).toEqual({ requestsToDecide: 2, transfersToConfirm: 0 })
      expect(calls.map((c) => c.table)).toEqual(['branch_stock_requests'])
    })

    it('treats staff with no branch as able to decide anywhere', async () => {
      const calls = counting({ branch_stock_requests: { count: 5, error: null } })
      expect((await countStockWork(orgStaff)).requestsToDecide).toBe(5)
      expect(calls[0].eq).toHaveBeenCalledTimes(1)
    })

    it('gives zeros, never an error, when a query fails or throws', async () => {
      counting({ branch_stock_requests: { count: null, error: { message: 'relation does not exist' } }, branch_stock_transfers: { count: 2, error: null } })
      expect(await countStockWork(admin)).toEqual({ requestsToDecide: 0, transfersToConfirm: 2 })
      from.mockImplementation(() => { throw new Error('boom') })
      expect(await countStockWork(admin)).toEqual({ requestsToDecide: 0, transfersToConfirm: 0 })
      expect(await countStockWork(null)).toEqual({ requestsToDecide: 0, transfersToConfirm: 0 })
    })
  })

  describe('who sees which buttons', () => {
    it('lets the asked branch, administrators and staff with no branch decide', () => {
      expect(canDecideRequest(mainPharmacist, request())).toBe(true)
      expect(canDecideRequest(admin, request())).toBe(true)
      expect(canDecideRequest(orgStaff, request())).toBe(true)
      expect(requestNeedsMyAction(mainPharmacist, request())).toBe(true)
    })

    it('does not let the asking branch, or another branch, decide', () => {
      expect(canDecideRequest(lapazManager, request())).toBe(false)
      expect(canDecideRequest(temaManager, request())).toBe(false)
      expect(requestNeedsMyAction(lapazManager, request())).toBe(false)
    })

    it('stops everyone once the request is closed', () => {
      for (const status of ['approved', 'declined', 'cancelled']) {
        expect(canDecideRequest(admin, request({ status }))).toBe(false)
        expect(canCancelRequest(admin, request({ status }))).toBe(false)
      }
    })

    it('lets the asker, the asking branch manager and administrators cancel', () => {
      expect(canCancelRequest(lapazPharmacist, request({ created_by: 'p2' }))).toBe(true)
      expect(canCancelRequest(lapazManager, request())).toBe(true)
      expect(canCancelRequest(admin, request())).toBe(true)
      expect(canCancelRequest(lapazPharmacist, request())).toBe(false)
      expect(canCancelRequest(temaManager, request())).toBe(false)
      expect(canCancelRequest(mainPharmacist, request())).toBe(false)
    })

    it('shows Request stock to branch-bound staff only', () => {
      expect(canAskForStock(lapazManager)).toBe(true)
      expect(canAskForStock(mainPharmacist)).toBe(true)
      expect(canAskForStock(admin)).toBe(false)
      expect(canAskForStock(orgStaff)).toBe(false)
    })
  })
})
