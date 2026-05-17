import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}))

vi.mock('./auditService', () => ({
  tryLogAuditEvent: vi.fn(),
}))

vi.mock('./branchService', () => ({
  getUserBranchIdsByUserIds: vi.fn(),
}))

vi.mock('./cashbookService', () => ({
  recordCashbookMovementIfSessionOpen: vi.fn(),
}))

import { supabase } from '../lib/supabase'
import { getUserBranchIdsByUserIds } from './branchService'
import { recordCashbookMovementIfSessionOpen } from './cashbookService'
import { getReceivables, recordClaimPayment } from './receivablesService'

const makeQuery = (response) => {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    gte: vi.fn(() => query),
    lte: vi.fn(() => query),
    order: vi.fn(() => query),
    insert: vi.fn(() => query),
    update: vi.fn(() => query),
    single: vi.fn(() => Promise.resolve(response)),
    then: (resolve, reject) => Promise.resolve(response).then(resolve, reject),
  }

  return query
}

const tableQueues = new Map()

const queueTable = (tableName, query) => {
  const queue = tableQueues.get(tableName) || []
  queue.push(query)
  tableQueues.set(tableName, queue)
  return query
}

describe('receivablesService NHIS accounting flow', () => {
  beforeEach(() => {
    tableQueues.clear()
    supabase.from.mockReset()
    supabase.from.mockImplementation((tableName) => {
      const queue = tableQueues.get(tableName) || []
      const query = queue.shift()
      if (!query) {
        throw new Error(`Unexpected Supabase table query: ${tableName}`)
      }
      return query
    })
    getUserBranchIdsByUserIds.mockResolvedValue({})
    recordCashbookMovementIfSessionOpen.mockResolvedValue(null)
  })

  it('builds NHIS receivables from the full claim total and existing payments', async () => {
    queueTable('claims', makeQuery({ data: [], error: null }))
    queueTable('nhis_claims', makeQuery({
      data: [
        {
          id: 'nhis-claim-1',
          branch_id: 'branch-1',
          claim_number: 'NHIS-000001',
          status: 'submitted',
          total_amount: 47.08,
          service_date_from: '2026-05-14',
          surname: 'Mensah',
          other_names: 'Ama',
          member_no: '12345678',
          hin: null,
          created_by: 'user-1',
          created_at: '2026-05-14T10:00:00Z',
          nhis_claim_payments: [{ paid_amount: 10 }],
        },
      ],
      error: null,
    }))

    const receivables = await getReceivables()

    expect(receivables).toHaveLength(1)
    expect(receivables[0]).toMatchObject({
      source_type: 'nhis_claim',
      source_id: 'nhis-claim-1',
      insurance_provider: 'NHIS',
      approved_amount: 47.08,
      totalPaid: 10,
      outstanding: 37.08,
    })
  })

  it('records a full NHIS cash payment, marks the claim paid, and syncs cashbook', async () => {
    const contextQuery = queueTable('nhis_claims', makeQuery({
      data: {
        id: 'nhis-claim-1',
        organization_id: 'org-1',
        branch_id: 'branch-1',
        claim_number: 'NHIS-000001',
        total_amount: 47.08,
        status: 'submitted',
        surname: 'Mensah',
        other_names: 'Ama',
        member_no: '12345678',
        hin: null,
        created_by: 'user-1',
        nhis_claim_payments: [],
      },
      error: null,
    }))
    const insertQuery = queueTable('nhis_claim_payments', makeQuery({
      data: {
        id: 'payment-1',
        branch_id: 'branch-1',
        paid_amount: 47.08,
        payment_method: 'cash',
        created_by: 'user-1',
        nhis_claims: { claim_number: 'NHIS-000001' },
      },
      error: null,
    }))
    const statusQuery = queueTable('nhis_claims', makeQuery({ error: null }))

    const payment = await recordClaimPayment({
      sourceType: 'nhis_claim',
      claimId: 'nhis-claim-1',
      paidAmount: 47.08,
      paymentMethod: 'cash',
      paymentDate: '2026-05-17',
      createdBy: 'user-1',
    })

    expect(contextQuery.select).toHaveBeenCalledWith(expect.stringContaining('nhis_claim_payments'))
    expect(insertQuery.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        organization_id: 'org-1',
        nhis_claim_id: 'nhis-claim-1',
        insurer_name: 'NHIS',
        approved_amount: 47.08,
        paid_amount: 47.08,
        payment_method: 'cash',
        branch_id: 'branch-1',
      }),
    ])
    expect(statusQuery.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'paid' }))
    expect(recordCashbookMovementIfSessionOpen).toHaveBeenCalledWith(expect.objectContaining({
      branchId: 'branch-1',
      entryType: 'deposit',
      sourceType: 'nhis_claim_payment',
      sourceId: 'payment-1',
      amount: 47.08,
      direction: 'in',
    }))
    expect(payment.id).toBe('payment-1')
  })

  it('blocks NHIS overpayments before inserting accounting rows', async () => {
    queueTable('nhis_claims', makeQuery({
      data: {
        id: 'nhis-claim-1',
        organization_id: 'org-1',
        branch_id: 'branch-1',
        claim_number: 'NHIS-000001',
        total_amount: 47.08,
        status: 'submitted',
        created_by: 'user-1',
        nhis_claim_payments: [{ paid_amount: 20 }],
      },
      error: null,
    }))

    await expect(recordClaimPayment({
      sourceType: 'nhis_claim',
      claimId: 'nhis-claim-1',
      paidAmount: 27.09,
    })).rejects.toThrow('Paid amount cannot exceed the outstanding approved amount.')

    expect(supabase.from).toHaveBeenCalledTimes(1)
  })
})
