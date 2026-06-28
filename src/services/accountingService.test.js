import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(),
  },
}))

vi.mock('./expenseService', () => ({ getExpenseSummary: vi.fn() }))
vi.mock('./receivablesService', () => ({ getReceivablesSummary: vi.fn() }))
vi.mock('./cashbookService', () => ({ getCashbookSummary: vi.fn() }))

import { supabase } from '../lib/supabase'
import { getExpenseSummary } from './expenseService'
import { getReceivablesSummary } from './receivablesService'
import { getCashbookSummary } from './cashbookService'
import { getAccountingOverview } from './accountingService'

describe('accountingService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getExpenseSummary.mockResolvedValue({
      totalExpenses: 30,
      byCategory: {},
      byPaymentMethod: {},
      rows: [],
    })
    getReceivablesSummary.mockResolvedValue({
      totalOutstanding: 0,
      totalApproved: 0,
      totalPaid: 0,
      byInsurer: [],
      byAgeBucket: {},
      count: 0,
    })
    getCashbookSummary.mockResolvedValue({
      sessions: [],
      totalVariance: 0,
      surpluses: 0,
      shortages: 0,
    })
  })

  it('uses the database aggregate and normalizes numeric JSON values', async () => {
    supabase.rpc.mockResolvedValue({
      data: {
        revenue: '150.50',
        cogs: '80.25',
        count: 3,
        byMethod: { cash: '100.50', momo: 50 },
      },
      error: null,
    })

    const result = await getAccountingOverview('2026-06-01', '2026-06-30', 'branch-1')

    expect(supabase.rpc).toHaveBeenCalledWith('get_accounting_sales_summary', {
      p_start_date: '2026-06-01',
      p_end_date: '2026-06-30',
      p_branch_id: 'branch-1',
    })
    expect(result.sales).toEqual({
      revenue: 150.5,
      cogs: 80.25,
      count: 3,
      byMethod: { cash: 100.5, momo: 50 },
    })
    expect(result.grossProfit).toBe(70.25)
    expect(result.netOperatingProfit).toBe(40.25)
  })
})
