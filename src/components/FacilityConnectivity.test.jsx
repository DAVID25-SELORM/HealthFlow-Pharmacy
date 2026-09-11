import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FacilityConnectivity from './FacilityConnectivity'
import { getFacilityConnectivity } from '../services/facilityConnectivityService'
vi.mock('../services/facilityConnectivityService', () => ({ getFacilityConnectivity: vi.fn() }))
const row = { id: 'one', name: 'Test Pharmacy', accountStatus: 'active', recentStaff: 1, recentSessions: 2, recentServers: 0, registeredServers: 1, lastBrowserContact: '2026-09-11T00:00:00Z', lastServerContact: null }
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })
describe('Facility Connectivity', () => {
  it('separates recent contact from account status and includes never observed facilities', async () => {
    getFacilityConnectivity.mockResolvedValue({ checkedAt: '2026-09-11T00:00:00Z', facilities: [row, { ...row, id: 'two', name: 'Other', recentStaff: 0, recentSessions: 0, lastBrowserContact: null }] })
    render(<FacilityConnectivity />)
    expect(await screen.findByText('Recent connection')).toBeInTheDocument()
    expect(screen.getByText('1 staff / 2 sessions')).toBeInTheDocument()
    expect(screen.getAllByText('Not yet observed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('active')).toHaveLength(2)
  })
  it('labels historical contact as no recent connection', async () => {
    getFacilityConnectivity.mockResolvedValue({ checkedAt: '2026-09-11T00:00:00Z', facilities: [{ ...row, recentSessions: 0, recentStaff: 0 }] })
    render(<FacilityConnectivity />)
    expect(await screen.findByText('No recent connection')).toBeInTheDocument()
  })
  it('does not leave a green/recent result after a failed refresh', async () => {
    getFacilityConnectivity.mockResolvedValueOnce({ checkedAt: '2026-09-11T00:00:00Z', facilities: [row] }).mockRejectedValueOnce(new Error('private details'))
    render(<FacilityConnectivity />)
    await screen.findByText('Recent connection')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connections' }))
    expect(await screen.findByText('Unknown — stale view')).toBeInTheDocument()
    expect(screen.queryByText('Recent connection')).not.toBeInTheDocument()
    expect(screen.queryByText('private details')).not.toBeInTheDocument()
  })
  it('reports unavailable instead of zero facilities when the migration is missing', async () => {
    getFacilityConnectivity.mockRejectedValue(new Error('missing RPC'))
    render(<FacilityConnectivity />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection status unavailable')
    expect(screen.queryByText('No facilities found.')).not.toBeInTheDocument()
  })
  it('refreshes automatically and stops after unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getFacilityConnectivity.mockResolvedValue({ checkedAt: '2026-09-11T00:00:00Z', facilities: [] })
    const view = render(<FacilityConnectivity />)
    await waitFor(() => expect(getFacilityConnectivity).toHaveBeenCalledTimes(1))
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(getFacilityConnectivity).toHaveBeenCalledTimes(2)
    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(getFacilityConnectivity).toHaveBeenCalledTimes(2)
  })
})
