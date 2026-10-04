import { render, screen, waitFor } from '@testing-library/react'
import { vi, it, expect, beforeEach } from 'vitest'
import SubscriptionNotice from './SubscriptionNotice'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
vi.mock('../context/AuthContext', () => ({ useAuth: vi.fn() }))
vi.mock('../lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))
vi.mock('./PlatformBilling', () => ({ default: () => <div>Platform billing available</div> }))
beforeEach(() => vi.clearAllMocks())
it('does not request a facility subscription for an unassigned platform account', () => {
 useAuth.mockReturnValue({ role: 'super_admin', profile: { organization_id: null } })
 render(<SubscriptionNotice />)
 expect(supabase.rpc).not.toHaveBeenCalled()
 expect(screen.getByText('Platform billing available')).toBeInTheDocument()
})
it('loads a facility notice and removes it when facility membership changes', async () => {
 useAuth.mockReturnValue({ role: 'admin', profile: { organization_id: 'facility' } })
 supabase.rpc.mockResolvedValue({ data: { state: 'overdue' } })
 const { rerender } = render(<SubscriptionNotice />)
 await screen.findByText('Subscription overdue')
 expect(supabase.rpc).toHaveBeenCalledWith('get_my_subscription')
 useAuth.mockReturnValue({ role: 'super_admin', profile: { organization_id: null } })
 rerender(<SubscriptionNotice />)
 await waitFor(() => expect(screen.queryByText('Subscription overdue')).not.toBeInTheDocument())
})
