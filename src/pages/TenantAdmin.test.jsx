import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TenantAdmin from './TenantAdmin'

const mocks = vi.hoisted(() => ({
  checkSubdomainAvailable: vi.fn(),
  createPharmacyTenant: vi.fn(),
  getOrganizationUsers: vi.fn(),
  getTenantAdminDashboard: vi.fn(),
  notify: vi.fn(),
  updateOrganizationDetails: vi.fn(),
  updateOrganizationStatus: vi.fn(),
  updateOrganizationUser: vi.fn(),
  updateSubscriptionTier: vi.fn(),
}))

vi.mock('../context/NotificationContext', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

vi.mock('../services/tenantAdminService', () => ({
  getTenantAdminDashboard: mocks.getTenantAdminDashboard,
  createPharmacyTenant: mocks.createPharmacyTenant,
  updateOrganizationStatus: mocks.updateOrganizationStatus,
  updateSubscriptionTier: mocks.updateSubscriptionTier,
  updateOrganizationDetails: mocks.updateOrganizationDetails,
  updateOrganizationUser: mocks.updateOrganizationUser,
  getOrganizationUsers: mocks.getOrganizationUsers,
  checkSubdomainAvailable: mocks.checkSubdomainAvailable,
}))

describe('TenantAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
  })

  it('reopens the saved organization detail panel after a same-tab refresh', async () => {
    window.sessionStorage.setItem('healthflow.tenantAdmin.expandedOrgId', JSON.stringify('org-1'))

    mocks.getTenantAdminDashboard.mockResolvedValue({
      organizations: [
        {
          id: 'org-1',
          name: 'Alpha Pharmacy',
          subdomain: 'alpha',
          status: 'active',
          subscription_tier: 'pro',
          created_at: '2026-04-01T09:00:00.000Z',
          email: 'hello@alpha.test',
        },
      ],
      userCounts: { 'org-1': 2 },
      branchCounts: { 'org-1': 1 },
    })
    mocks.getOrganizationUsers.mockResolvedValue([
      {
        id: 'user-1',
        full_name: 'Alice Mensah',
        email: 'alice@alpha.test',
        role: 'admin',
        is_active: true,
        created_at: '2026-04-03T10:00:00.000Z',
      },
    ])

    render(<TenantAdmin />)

    await waitFor(() => {
      expect(screen.getByText('Users in Alpha Pharmacy')).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(mocks.getOrganizationUsers).toHaveBeenCalledWith('org-1')
      expect(screen.getByText('Alice Mensah')).toBeInTheDocument()
    })
  })
})
