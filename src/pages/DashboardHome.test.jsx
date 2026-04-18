import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardHome from './DashboardHome'

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: mocks.useAuth,
}))

vi.mock('./Dashboard', () => ({
  default: () => <div>Tenant Dashboard</div>,
}))

vi.mock('./SuperAdminDashboard', () => ({
  default: () => <div>Platform Dashboard</div>,
}))

describe('DashboardHome', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the platform dashboard for super admins', () => {
    mocks.useAuth.mockReturnValue({ role: 'super_admin' })

    render(<DashboardHome />)

    expect(screen.getByText('Platform Dashboard')).toBeInTheDocument()
    expect(screen.queryByText('Tenant Dashboard')).not.toBeInTheDocument()
  })

  it('renders the tenant dashboard for pharmacy roles', () => {
    mocks.useAuth.mockReturnValue({ role: 'admin' })

    render(<DashboardHome />)

    expect(screen.getByText('Tenant Dashboard')).toBeInTheDocument()
    expect(screen.queryByText('Platform Dashboard')).not.toBeInTheDocument()
  })
})
