import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FacilityContactReporter from './FacilityContactReporter'
import { useAuth } from '../context/AuthContext'
import { startFacilityContactReporting } from '../services/facilityConnectivityService'
vi.mock('../context/AuthContext', () => ({ useAuth: vi.fn() }))
vi.mock('../services/facilityConnectivityService', () => ({ startFacilityContactReporting: vi.fn() }))
afterEach(() => vi.clearAllMocks())
const staff = { user: { id: 'one' }, organization: { id: 'org' }, role: 'admin', session: { access_token: 'test' }, loading: false }
describe('contact reporter authentication boundary', () => {
  it.each([
    { ...staff, session: { offline: true } },
    { ...staff, session: null },
    { ...staff, role: 'super_admin' },
    { ...staff, loading: true },
    { ...staff, organization: null },
  ])('does not report an ineligible session', (auth) => {
    useAuth.mockReturnValue(auth)
    render(<FacilityContactReporter />)
    expect(startFacilityContactReporting).not.toHaveBeenCalled()
  })
  it('starts for cloud staff and stops on sign-out', () => {
    const stop = vi.fn()
    startFacilityContactReporting.mockReturnValue(stop)
    useAuth.mockReturnValue(staff)
    const view = render(<FacilityContactReporter />)
    expect(startFacilityContactReporting).toHaveBeenCalledOnce()
    useAuth.mockReturnValue({ ...staff, session: null })
    view.rerender(<FacilityContactReporter />)
    expect(stop).toHaveBeenCalledOnce()
  })
})
