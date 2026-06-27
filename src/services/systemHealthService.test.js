import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  invokeTierAccess: vi.fn(),
  getBranchServerConfig: vi.fn(),
  getBranchServerHealth: vi.fn(),
  rows: new Map(),
}))

const createQuery = (table) => {
  const query = {
    select: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({
      data: mocks.rows.get(table) || null,
      error: null,
    })),
    then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve),
  }
  return query
}

vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  supabase: {
    auth: {
      getUser: mocks.getUser,
    },
    from: vi.fn((table) => createQuery(table)),
  },
}))

vi.mock('./tierAccessService', () => ({
  invokeTierAccess: mocks.invokeTierAccess,
}))

vi.mock('./branchServerApi', () => ({
  getBranchServerConfig: mocks.getBranchServerConfig,
  getBranchServerHealth: mocks.getBranchServerHealth,
}))

import { getSystemHealth } from './systemHealthService'

describe('getSystemHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.rows.clear()
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'monitor@healthflow.test' } },
      error: null,
    })
    mocks.invokeTierAccess.mockResolvedValue({
      ok: true,
      counts: { sales: 4, patients: 8, nhisClaims: 3 },
    })
    mocks.getBranchServerConfig.mockReturnValue({ enabled: false, token: '' })
    mocks.rows.set('sales', {
      id: 'sale-1',
      sale_number: 'SALE-001',
      sale_date: '2026-06-27T10:00:00Z',
      net_amount: 25,
      payment_status: 'completed',
    })
    mocks.rows.set('nhis_claims', {
      id: 'claim-1',
      claim_number: 'NHIS-001',
      status: 'served',
      created_at: '2026-06-27T09:00:00Z',
    })
    mocks.rows.set('audit_logs', {
      id: 'log-1',
      event_type: 'sale.completed',
      entity_type: 'sales',
      created_at: '2026-06-27T10:00:00Z',
    })
  })

  it('checks login, reports, sales, NHIS, and audit reads without mutations', async () => {
    const health = await getSystemHealth()
    const labels = health.checks.map((check) => check.label)

    expect(labels).toEqual(expect.arrayContaining([
      'Supabase connection',
      'Authenticated session',
      'Reports and Edge Function',
      'Recent sale',
      'NHIS access',
      'Recent activity log',
      'Local branch server',
    ]))
    expect(mocks.invokeTierAccess).toHaveBeenCalledWith({ action: 'get_report_health' })
    expect(health.status).toBe('warn')
  })
})
