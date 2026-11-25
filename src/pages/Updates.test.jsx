import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  role: 'admin',
  notice: null,
  offline: true,
  getBranchUpdateStatus: vi.fn(),
  checkBranchServerUpdates: vi.fn(),
  installBranchServerUpdate: vi.fn(),
  waitForBranchUpdateCompletion: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ role: mocks.role }) }))
vi.mock('../hooks/useBranchUpdateNotice', () => ({ useBranchUpdateNotice: () => mocks.notice }))
vi.mock('../services/branchUpdateNotice', () => ({ refreshBranchUpdateNotice: vi.fn() }))
vi.mock('../utils/appDialog', () => ({ requestAppConfirmation: mocks.confirm }))
vi.mock('../services/branchServerApi', () => ({
  isServedByOfflineServer: () => mocks.offline,
  getBranchUpdateStatus: mocks.getBranchUpdateStatus,
  checkBranchServerUpdates: mocks.checkBranchServerUpdates,
  installBranchServerUpdate: mocks.installBranchServerUpdate,
  waitForBranchUpdateCompletion: mocks.waitForBranchUpdateCompletion,
}))

import Updates from './Updates'
import BranchUpdateBanner from '../components/BranchUpdateBanner'

const waiting = {
  configured: true,
  state: 'available',
  currentVersion: '1.0.0',
  latestVersion: '2.0.0',
  releaseNotes: 'Invented release notes',
  lastCheckedAt: '2030-01-02T12:00:00.000Z',
  lastCheckError: '',
  available: true,
  inProgress: false,
  installerSupported: true,
  installerReady: true,
}

const renderPage = (element = <Updates />, path = '/updates') =>
  render(<MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  mocks.role = 'admin'
  mocks.offline = true
  mocks.notice = { currentVersion: '1.0.0', latestVersion: '2.0.0', releaseNotes: 'Invented release notes', available: true, inProgress: false }
  mocks.getBranchUpdateStatus.mockResolvedValue(waiting)
  mocks.installBranchServerUpdate.mockResolvedValue({ ...waiting, state: 'installing', inProgress: false, restartRequired: true })
  mocks.waitForBranchUpdateCompletion.mockResolvedValue({ currentVersion: '2.0.0', state: 'installed' })
  mocks.confirm.mockResolvedValue(true)
})

describe('Updates page', () => {
  it('shows an administrator the new version and what changed', async () => {
    renderPage()
    expect(await screen.findByRole('button', { name: 'Update now' })).toBeEnabled()
    expect(screen.getByRole('heading', { name: 'A new version is ready' })).toBeInTheDocument()
    expect(screen.getByText('1.0.0')).toBeInTheDocument()
    expect(screen.getByText('2.0.0')).toBeInTheDocument()
    expect(screen.getByText('Invented release notes')).toBeInTheDocument()
  })

  it('installs only after the administrator confirms the restart', async () => {
    mocks.confirm.mockResolvedValue(false)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }))

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
    expect(mocks.confirm.mock.calls[0][0].warning).toMatch(/everyone using this offline server/i)
    expect(mocks.installBranchServerUpdate).not.toHaveBeenCalled()
  })

  it('follows the install and offers a reload when it worked', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }))

    expect(await screen.findByText('HealthFlow was updated to version 2.0.0.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload HealthFlow' })).toBeInTheDocument()
    expect(mocks.waitForBranchUpdateCompletion).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: '2.0.0' }))
  })

  it('says when the previous version was restored', async () => {
    mocks.waitForBranchUpdateCompletion.mockImplementation(async ({ onStatus }) => {
      onStatus({ ...waiting, state: 'rolled_back' })
      throw new Error('Invented reason')
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }))

    expect(await screen.findByText('The update did not work. Your previous version was restored.')).toBeInTheDocument()
    expect(screen.getByText('Invented reason')).toBeInTheDocument()
  })

  it('keeps watching when the request gives up but the server is still installing', async () => {
    mocks.installBranchServerUpdate.mockRejectedValue(new Error('Invented timeout'))
    mocks.getBranchUpdateStatus
      .mockResolvedValueOnce(waiting)
      .mockResolvedValue({ ...waiting, state: 'downloading', inProgress: true })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }))

    await waitFor(() => expect(mocks.waitForBranchUpdateCompletion).toHaveBeenCalled())
    expect(screen.queryByText('Invented timeout')).not.toBeInTheDocument()
  })

  it('tells other staff to ask the administrator, with no update button', () => {
    mocks.role = 'cashier'
    renderPage()

    expect(screen.getByText('Ask your administrator to update HealthFlow.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /update now|check now/i })).not.toBeInTheDocument()
    expect(mocks.getBranchUpdateStatus).not.toHaveBeenCalled()
  })

  it('does not offer updates on the online website', () => {
    mocks.offline = false
    renderPage()
    expect(screen.getByText(/The online version updates by itself/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('update notification', () => {
  it('appears on other pages, links to Updates, and can be put off until later', () => {
    renderPage(<BranchUpdateBanner />, '/sales')
    expect(screen.getByText('A new HealthFlow version (2.0.0) is ready.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Updates' })).toHaveAttribute('href', '/updates')

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('asks other computers to reload after the server was updated, without reloading by itself', () => {
    mocks.notice = { currentVersion: '2.0.0', available: false, inProgress: false, reloadNeeded: true }
    renderPage(<BranchUpdateBanner />, '/sales')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.getByText(/Finish what you are typing/)).toBeInTheDocument()
  })

  it('shows nothing when no update is waiting', () => {
    mocks.notice = { currentVersion: '2.0.0', available: false, inProgress: false }
    renderPage(<BranchUpdateBanner />, '/sales')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
