import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TenantProvider, useTenant } from './TenantContext'

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
}))

vi.mock('./AuthContext', () => ({
  useAuth: mocks.useAuth,
}))

const TenantProbe = () => {
  const tenant = useTenant()

  return (
    <dl>
      <dt>Plan</dt>
      <dd>{tenant.planCode}</dd>
      <dt>Reports</dt>
      <dd>{tenant.tierLimits.hasReports ? 'yes' : 'no'}</dd>
      <dt>Purchases</dt>
      <dd>{tenant.canUsePurchases ? 'yes' : 'no'}</dd>
      <dt>NHIS</dt>
      <dd>{tenant.canUseNhis ? 'yes' : 'no'}</dd>
      <dt>Offline installer</dt>
      <dd>{tenant.canUseOfflineInstaller ? 'yes' : 'no'}</dd>
    </dl>
  )
}

describe('TenantContext', () => {
  it('gives platform Super Admin report access without enabling tenant modules', () => {
    mocks.useAuth.mockReturnValue({
      organization: null,
      loading: false,
      role: 'super_admin',
    })

    render(
      <TenantProvider>
        <TenantProbe />
      </TenantProvider>
    )

    expect(screen.getByText('platform')).toBeInTheDocument()
    expect(screen.getByText('Reports').nextSibling).toHaveTextContent('yes')
    expect(screen.getByText('Purchases').nextSibling).toHaveTextContent('no')
    expect(screen.getByText('NHIS').nextSibling).toHaveTextContent('no')
    expect(screen.getByText('Offline installer').nextSibling).toHaveTextContent('no')
  })

  it('exposes the tenant offline installer privilege from the organization record', () => {
    mocks.useAuth.mockReturnValue({
      organization: {
        id: 'org-1',
        status: 'active',
        billing_status: 'active',
        subscription_tier: 'pro',
        can_use_offline_installer: true,
      },
      loading: false,
      role: 'admin',
    })

    render(
      <TenantProvider>
        <TenantProbe />
      </TenantProvider>
    )

    expect(screen.getByText('Offline installer').nextSibling).toHaveTextContent('yes')
  })
})
