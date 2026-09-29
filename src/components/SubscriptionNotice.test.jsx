import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import SubscriptionNotice from './SubscriptionNotice'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn() }))
vi.mock('../context/AuthContext', () => ({ useAuth: mocks.auth }))
vi.mock('../lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }))
const facilityAdmin = {
  role: 'admin', assignedRoles: ['admin'], user: { id: 'user-1' },
  profile: { organization_id: 'org-1', is_active: true }, organization: { id: 'org-1' }, loading: false,
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockReturnValue(facilityAdmin)
  mocks.rpc.mockResolvedValue({ data: { state: 'overdue' }, error: null })
})

it.each([
  { role: 'super_admin', organization: null, profile: { organization_id: null } },
  { loading: true }, { user: null },
  { profile: { organization_id: 'other-org' } },
  { profile: { organization_id: 'org-1', is_active: false } },
  { role: 'assistant', assignedRoles: ['assistant'] },
])('does not request a facility subscription without an eligible context: %j', (overrides) => {
  mocks.auth.mockReturnValue({ ...facilityAdmin, ...overrides })
  render(<SubscriptionNotice />)
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('loads a facility notice and clears it when switching to platform context', async () => {
  const { rerender } = render(<SubscriptionNotice />)
  await screen.findByText('Subscription overdue')
  expect(mocks.rpc).toHaveBeenCalledWith('get_my_subscription')
  mocks.auth.mockReturnValue({ ...facilityAdmin, role: 'super_admin', organization: null })
  rerender(<SubscriptionNotice />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(mocks.rpc).toHaveBeenCalledTimes(1)
})

it('waits for authentication loading to complete', async () => {
  mocks.auth.mockReturnValue({ ...facilityAdmin, loading: true })
  const { rerender } = render(<SubscriptionNotice />)
  mocks.auth.mockReturnValue(facilityAdmin)
  rerender(<SubscriptionNotice />)
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce())
  await screen.findByText('Subscription overdue')
})
