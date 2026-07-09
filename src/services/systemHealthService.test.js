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

vi.mock('../utils/activeRole', () => ({
  getStoredActiveRole: vi.fn(() => ''),
}))

import { getSystemHealth } from './systemHealthService'
import { getStoredActiveRole } from '../utils/activeRole'

describe('getSystemHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getStoredActiveRole.mockReturnValue('')
    mocks.rows.clear()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://project-ref.supabase.co')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'publishable-key')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '{"ok":true}',
    })))
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'monitor@healthflow.test' } },
      error: null,
    })
    mocks.invokeTierAccess.mockImplementation(async ({ action }) => {
      if (action === 'get_activity_logs') {
        return {
          logs: [{
            id: 'log-1',
            event_type: 'sale.completed',
            entity_type: 'sales',
            created_at: '2026-06-27T10:00:00Z',
          }],
        }
      }
      return {
        ok: true,
        counts: { sales: 4, patients: 8, nhisClaims: 3 },
      }
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
      'Supabase Auth endpoint',
      'Supabase REST latency',
      'Authenticated session',
      'Reports and Edge Function',
      'Recent sale',
      'NHIS access',
      'Recent activity log',
      'Local branch server',
    ]))
    expect(mocks.invokeTierAccess).toHaveBeenCalledWith({ action: 'get_report_health' })
    expect(mocks.invokeTierAccess).toHaveBeenCalledWith({ action: 'get_activity_logs', limit: 1 })
    expect(health.status).toBe('warn')
  })

  it('skips report health for active roles without report access', async () => {
    const health = await getSystemHealth({ canViewReports: false })
    const reportCheck = health.checks.find((check) => check.label === 'Reports and Edge Function')

    expect(reportCheck).toMatchObject({
      status: 'warn',
      summary: 'Skipped',
    })
    expect(mocks.invokeTierAccess).not.toHaveBeenCalledWith({ action: 'get_report_health' })
    expect(mocks.invokeTierAccess).toHaveBeenCalledWith({ action: 'get_activity_logs', limit: 1 })
  })

  it('skips report health when stored active role is assistant even if permission options are missing', async () => {
    getStoredActiveRole.mockReturnValue('assistant')

    const health = await getSystemHealth()
    const reportCheck = health.checks.find((check) => check.label === 'Reports and Edge Function')

    expect(reportCheck).toMatchObject({
      status: 'warn',
      summary: 'Skipped',
    })
    expect(mocks.invokeTierAccess).not.toHaveBeenCalledWith({ action: 'get_report_health' })
    expect(mocks.invokeTierAccess).toHaveBeenCalledWith({ action: 'get_activity_logs', limit: 1 })
  })
})
