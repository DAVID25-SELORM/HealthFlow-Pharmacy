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
import { getNhisNotYetSubmittedSummary, getReceivables, getReceivablesSummary, recordClaimPayment } from './receivablesService'

const makeQuery = (response) => {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    gte: vi.fn(() => query),
    lte: vi.fn(() => query),
    order: vi.fn(() => query),
    range: vi.fn(() => query),
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
    const nhisReceivablesQuery = queueTable('nhis_claims', makeQuery({
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
          nhis_claim_medicines: [{ total_amount: 10 }],
          nhis_claim_services: [{ total_amount: 37.08 }],
          nhis_claim_payments: [{ paid_amount: 10 }],
        },
      ],
      error: null,
    }))

    const receivables = await getReceivables()

    expect(nhisReceivablesQuery.select).not.toHaveBeenCalledWith(expect.stringContaining('medicine_count'))
    expect(nhisReceivablesQuery.select).not.toHaveBeenCalledWith(expect.stringContaining('service_count'))
    expect(receivables).toHaveLength(1)
    expect(receivables[0]).toMatchObject({
      source_type: 'nhis_claim',
      source_id: 'nhis-claim-1',
      insurance_provider: 'NHIS',
      approved_amount: 47.08,
      totalPaid: 10,
      outstanding: 37.08,
      medicine_count: 1,
      service_count: 1,
      nhisBreakdown: {
        medicineAmount: 10,
        serviceAmount: 37.08,
        medicineCount: 1,
        serviceCount: 1,
        claimType: 'Hospital tariff + medicines',
      },
    })
  })

  const submitted = (id) => ({
    id: `claim-${id}`, status: 'submitted', total_amount: 10, service_date_from: '2026-05-14', branch_id: 'branch-1',
    nhis_claim_medicines: [], nhis_claim_services: [], nhis_claim_payments: [],
  })
  const served = (id, extra = {}) => ({ id: `served-${id}`, total_amount: 10.1, nhis_claim_payments: [], ...extra })
  const thousand = (make) => Array.from({ length: 1000 }, (_, index) => make(index))

  it('totals every submitted claim, not just the first 1,000', async () => {
    queueTable('claims', makeQuery({ data: [], error: null }))
    const first = queueTable('nhis_claims', makeQuery({ data: thousand(submitted), error: null }))
    const second = queueTable('nhis_claims', makeQuery({ data: [submitted('last')], error: null }))

    const summary = await getReceivablesSummary()

    expect(first.range).toHaveBeenCalledWith(0, 999)
    expect(second.range).toHaveBeenCalledWith(1000, 1999)
    expect(summary.count).toBe(1001)
    expect(summary.totalOutstanding).toBe(10010)
    expect(summary.missing).toEqual([])
  })

  it('names a source that could not be loaded instead of totalling without saying so', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    queueTable('claims', makeQuery({ data: [], error: null }))
    queueTable('nhis_claims', makeQuery({ data: thousand(submitted), error: null }))
    queueTable('nhis_claims', makeQuery({ data: null, error: new Error('timed out') }))

    const summary = await getReceivablesSummary()

    expect(summary.missing).toEqual(['NHIS claims'])
    expect(summary.count).toBe(0)
  })

  it('totals served claims that are not yet submitted across every page, less anything paid', async () => {
    const first = queueTable('nhis_claims', makeQuery({ data: thousand((index) => served(index)), error: null }))
    queueTable('nhis_claims', makeQuery({
      data: [served('part-paid', { total_amount: 50, nhis_claim_payments: [{ paid_amount: 20 }] }), served('overpaid', { total_amount: 5, nhis_claim_payments: [{ paid_amount: 9 }] })],
      error: null,
    }))

    const summary = await getNhisNotYetSubmittedSummary()

    expect(first.eq).toHaveBeenCalledWith('status', 'served')
    expect(first.eq).toHaveBeenCalledTimes(1)
    expect(summary).toEqual({ total: 10130, count: 1002 })
  })

  it('limits the not-yet-submitted figure to the chosen branch', async () => {
    const query = queueTable('nhis_claims', makeQuery({ data: [], error: null }))

    expect(await getNhisNotYetSubmittedSummary('branch-2')).toEqual({ total: 0, count: 0 })
    expect(query.eq).toHaveBeenCalledWith('branch_id', 'branch-2')
  })

  it('fails the not-yet-submitted figure outright if any page fails', async () => {
    queueTable('nhis_claims', makeQuery({ data: thousand((index) => served(index)), error: null }))
    queueTable('nhis_claims', makeQuery({ data: null, error: new Error('timed out') }))

    await expect(getNhisNotYetSubmittedSummary()).rejects.toThrow('timed out')
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
