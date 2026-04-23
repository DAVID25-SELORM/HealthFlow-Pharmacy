import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Dashboard from './Dashboard'

const mocks = vi.hoisted(() => ({
  getAllSales: vi.fn(),
  getExpiringDrugs: vi.fn(),
  getLowStockDrugs: vi.fn(),
  getRecentClaims: vi.fn(),
  getRecentSales: vi.fn(),
  isSupabaseConfigured: vi.fn(),
  navigate: vi.fn(),
  useAuth: vi.fn(),
  useTenant: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: mocks.useAuth,
}))

vi.mock('../context/TenantContext', () => ({
  useTenant: mocks.useTenant,
}))

vi.mock('../services/salesService', () => ({
  getAllSales: mocks.getAllSales,
  getRecentSales: mocks.getRecentSales,
}))

vi.mock('../services/drugService', () => ({
  getLowStockDrugs: mocks.getLowStockDrugs,
  getExpiringDrugs: mocks.getExpiringDrugs,
}))

vi.mock('../services/claimsService', () => ({
  getRecentClaims: mocks.getRecentClaims,
}))

vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: mocks.isSupabaseConfigured,
}))

describe('Dashboard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-04-16T12:00:00+01:00'))
    vi.clearAllMocks()
    window.sessionStorage.clear()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    mocks.useAuth.mockReturnValue({ role: 'admin' })
    mocks.useTenant.mockReturnValue({ tierLimits: { hasClaims: true } })
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.getLowStockDrugs.mockResolvedValue([])
    mocks.getExpiringDrugs.mockResolvedValue([])
    mocks.getRecentClaims.mockResolvedValue([])
    mocks.getRecentSales.mockResolvedValue([])
    mocks.getAllSales.mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('shows live data with an error state when one dashboard source fails', async () => {
    mocks.getAllSales.mockResolvedValue([
      {
        id: 'sale-history-1',
        sale_date: '2026-04-16T09:15:00+01:00',
        net_amount: '42.50',
      },
    ])
    mocks.getRecentSales.mockResolvedValue([
      {
        id: 'sale-1',
        net_amount: '42.50',
        patients: { full_name: 'Alice Mensah' },
      },
    ])
    mocks.getRecentClaims.mockRejectedValue(new Error('claims unavailable'))

    render(<Dashboard />)

    await waitFor(() => {
      expect(
        screen.getByText('Some dashboard data could not be loaded. Showing available live records only.')
      ).toBeInTheDocument()
    })

    expect(screen.getByText("Today's Sales")).toBeInTheDocument()
    expect(screen.getAllByText('GHS 42.50').length).toBeGreaterThan(0)
    expect(screen.getByText('Alice Mensah')).toBeInTheDocument()
    expect(screen.getByText('No claims yet')).toBeInTheDocument()
  })

  it('buckets sales into the correct local day for the daily chart', async () => {
    mocks.getAllSales.mockResolvedValue([
      {
        id: 'sale-history-2',
        sale_date: '2026-04-16T12:00:00+01:00',
        net_amount: '75.00',
      },
    ])

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByTitle('Apr 16: GHS 75.00')).toBeInTheDocument()
    })

    expect(screen.queryByTitle('Apr 15: GHS 75.00')).not.toBeInTheDocument()
  })

  it('restores the saved chart tab for the current browser tab', async () => {
    window.sessionStorage.setItem('healthflow.dashboard.chartMode', JSON.stringify('weekly'))

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText(/the weekly trend will appear here automatically/i)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Daily' }))

    expect(window.sessionStorage.getItem('healthflow.dashboard.chartMode')).toBe(
      JSON.stringify('daily')
    )
  })
})
