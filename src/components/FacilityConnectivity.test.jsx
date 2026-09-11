import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FacilityConnectivity from './FacilityConnectivity'
import { getFacilityConnectivity } from '../services/facilityConnectivityService'
vi.mock('../services/facilityConnectivityService', () => ({ getFacilityConnectivity: vi.fn() }))
const row = { id: 'one', name: 'Test Pharmacy', accountStatus: 'active', connectivityStatus: 'ONLINE', recentStaff: 1, recentSessions: 2, recentServers: 0, registeredServers: 1, lastBrowserContact: '2026-09-11T00:00:00Z', lastServerContact: null }
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })
describe('Facility Connectivity', () => {
  it('separates recent contact from account status and includes never observed facilities', async () => {
    getFacilityConnectivity.mockResolvedValue({ checkedAt: '2026-09-11T00:00:00Z', facilities: [row, { ...row, id: 'two', name: 'Other', connectivityStatus: 'NEVER_CONNECTED', recentStaff: 0, recentSessions: 0, lastBrowserContact: null }] })
    render(<FacilityConnectivity />)
    expect(await screen.findByRole('cell', { name: 'Online', exact: true })).toBeInTheDocument()
    expect(screen.getByText('1 staff / 2 sessions')).toBeInTheDocument()
    expect(screen.getAllByText('Not yet observed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('active')).toHaveLength(2)
  })
  it('labels historical contact as no recent connection', async () => {
    getFacilityConnectivity.mockResolvedValue({ checkedAt: '2026-09-11T00:00:00Z', facilities: [{ ...row, connectivityStatus: 'OFFLINE', recentSessions: 0, recentStaff: 0 }] })
    render(<FacilityConnectivity />)
    expect(await screen.findByRole('cell', { name: 'Offline', exact: true })).toBeInTheDocument()
  })
  it('does not leave a green/recent result after a failed refresh', async () => {
    getFacilityConnectivity.mockResolvedValueOnce({ checkedAt: '2026-09-11T00:00:00Z', facilities: [row] }).mockRejectedValueOnce(new Error('private details'))
    render(<FacilityConnectivity />)
    await screen.findByRole('cell', { name: 'Online', exact: true })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connections' }))
    expect(await screen.findByText('Unknown — stale view')).toBeInTheDocument()
    expect(screen.queryByRole('cell', { name: 'Online', exact: true })).not.toBeInTheDocument()
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

const names = () => screen.getAllByRole('rowheader').map((cell) => cell.textContent)
it('keeps a browser-connected facility Online without a registered branch server', async () => {
  getFacilityConnectivity.mockResolvedValue({ checkedAt: '2026-09-11T00:00:00Z', facilities: [{ ...row, registeredServers: 0 }] })
  render(<FacilityConnectivity />)
  expect(await screen.findByRole('cell', { name: 'Online', exact: true })).toBeInTheDocument()
  expect(screen.getByText('No branch server registered')).toBeInTheDocument()
})
it('distinguishes a registered server awaiting its first contact', async () => {
  getFacilityConnectivity.mockResolvedValue({ checkedAt: '2026-09-11T00:00:00Z', facilities: [row] })
  render(<FacilityConnectivity />)
  expect(await screen.findByText('Awaiting first server contact')).toBeInTheDocument()
  expect(screen.queryByText('No branch server registered')).not.toBeInTheDocument()
})
it('retains canonical order through search/filter and refresh status transitions', async () => {
  const online = { ...row, id: 'a', name: 'Alpha' }
  const offline = { ...row, id: 'b', name: 'Beta', connectivityStatus: 'OFFLINE' }
  const never = { ...row, id: 'c', name: 'Gamma', connectivityStatus: 'NEVER_CONNECTED' }
  getFacilityConnectivity.mockResolvedValue({ checkedAt: '2026-09-11T00:00:00Z', facilities: [online, offline, never] })
  render(<FacilityConnectivity />)
  await screen.findByRole('rowheader', { name: 'Alpha' })
  expect(names()).toEqual(['Alpha', 'Beta', 'Gamma'])
  expect(screen.getByText('Online: 1')).toBeInTheDocument()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'a' } })
  expect(names()).toEqual(['Alpha', 'Beta', 'Gamma'])
  fireEvent.click(screen.getByRole('button', { name: 'Offline', exact: true }))
  expect(names()).toEqual(['Beta'])
  fireEvent.click(screen.getByRole('button', { name: 'All', exact: true }))
  getFacilityConnectivity.mockResolvedValue({ checkedAt: '2026-09-11T00:01:00Z', facilities: [{ ...offline, connectivityStatus: 'ONLINE' }, { ...online, connectivityStatus: 'RECENTLY_ACTIVE' }, never] })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh connections' }))
  await waitFor(() => expect(names()).toEqual(['Beta', 'Alpha', 'Gamma']))
  expect(screen.getByText('Recently Active: 1')).toBeInTheDocument()
})

it('repositions a changed status on controlled refresh without a page reload', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const first = { ...row, id: 'a', name: 'Alpha' }
  const second = { ...row, id: 'b', name: 'Beta', connectivityStatus: 'OFFLINE' }
  getFacilityConnectivity.mockResolvedValueOnce({ checkedAt: '2026-09-11T00:00:00Z', facilities: [first, second] })
    .mockResolvedValue({ checkedAt: '2026-09-11T00:00:30Z', facilities: [{ ...second, connectivityStatus: 'ONLINE' }, { ...first, connectivityStatus: 'OFFLINE' }] })
  render(<FacilityConnectivity />)
  await waitFor(() => expect(names()).toEqual(['Alpha', 'Beta']))
  await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
  expect(getFacilityConnectivity).toHaveBeenCalledTimes(1)
  expect(names()).toEqual(['Alpha', 'Beta'])
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(names()).toEqual(['Beta', 'Alpha'])
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bet' } })
  expect(names()).toEqual(['Beta'])
  fireEvent.click(screen.getByRole('button', { name: 'Offline', exact: true }))
  expect(screen.getByText('No facilities match your search and filter.')).toBeInTheDocument()
})
