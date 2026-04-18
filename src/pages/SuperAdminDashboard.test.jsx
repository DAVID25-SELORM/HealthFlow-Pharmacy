import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SuperAdminDashboard from './SuperAdminDashboard'

const mocks = vi.hoisted(() => ({
  getTenantAdminDashboard: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('../services/tenantAdminService', () => ({
  getTenantAdminDashboard: mocks.getTenantAdminDashboard,
}))

describe('SuperAdminDashboard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-04-18T12:00:00+01:00'))
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders platform metrics and setup alerts from the tenant snapshot', async () => {
    mocks.getTenantAdminDashboard.mockResolvedValue({
      organizations: [
        {
          id: 'org-1',
          name: 'Alpha Pharmacy',
          status: 'active',
          subscription_tier: 'pro',
          created_at: '2026-04-01T09:00:00.000Z',
          updated_at: '2026-04-18T08:30:00.000Z',
          subscription_ends_at: '2026-04-21T00:00:00.000Z',
          email: 'hello@alpha.test',
          phone: '+233 000 111 222',
        },
        {
          id: 'org-2',
          name: 'Beta Pharmacy',
          status: 'trial',
          subscription_tier: 'basic',
          created_at: '2026-04-16T10:00:00.000Z',
          updated_at: '2026-04-17T14:15:00.000Z',
          trial_ends_at: '2026-04-25T00:00:00.000Z',
          email: null,
          phone: '+233 000 111 333',
        },
      ],
      userCounts: {
        'org-1': 5,
        'org-2': 1,
      },
      branchCounts: {
        'org-1': 2,
        'org-2': 0,
      },
    })

    render(<SuperAdminDashboard />)

    await waitFor(() => {
      expect(screen.getByText('Platform command center')).toBeInTheDocument()
    })

    expect(screen.getByText('Total Pharmacies')).toBeInTheDocument()
    expect(screen.getByText('Platform Users')).toBeInTheDocument()
    expect(screen.getByText('Renewal watchlist')).toBeInTheDocument()
    expect(screen.getAllByText('Alpha Pharmacy').length).toBeGreaterThan(0)
    expect(screen.getByText('Beta Pharmacy needs its first branch.')).toBeInTheDocument()
    expect(screen.getByText('Beta Pharmacy is missing a contact email or phone number.')).toBeInTheDocument()
  })
})
