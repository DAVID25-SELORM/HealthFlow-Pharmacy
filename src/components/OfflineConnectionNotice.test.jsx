import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ offline: true, authorized: false }))
vi.mock('../services/branchServerApi', () => ({
  isServedByOfflineServer: () => mocks.offline,
  getBranchServerConfig: () => ({ authorized: mocks.authorized }),
}))

import OfflineConnectionNotice from './OfflineConnectionNotice'

describe('offline connection notice', () => {
  beforeEach(() => {
    mocks.offline = true
    mocks.authorized = false
  })

  it('tells an unregistered browser how to connect', () => {
    render(<OfflineConnectionNotice />)
    expect(screen.getByRole('alert')).toHaveTextContent('This browser is not connected to the offline server.')
    expect(screen.getByRole('alert')).toHaveTextContent('HealthFlow Offline POS')
  })

  it('stays away from a connected browser and from the online website', () => {
    mocks.authorized = true
    const { rerender } = render(<OfflineConnectionNotice />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    mocks.authorized = false
    mocks.offline = false
    rerender(<OfflineConnectionNotice />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
