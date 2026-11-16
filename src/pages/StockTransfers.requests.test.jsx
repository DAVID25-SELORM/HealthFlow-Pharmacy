import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { auth, tenant, notify, getBranches } = vi.hoisted(() => ({
  auth: { current: {} },
  tenant: { current: {} },
  notify: vi.fn(),
  getBranches: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ supabase: {} }))
vi.mock('../lib/appEvents', () => ({ dispatchHealthflowDataChanged: vi.fn() }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth.current }))
vi.mock('../context/TenantContext', () => ({ useTenant: () => tenant.current }))
vi.mock('../context/NotificationContext', () => ({ useNotification: () => ({ notify }) }))
vi.mock('../services/branchService', () => ({ getBranches, createBranch: vi.fn() }))
vi.mock('../services/drugService', () => ({ searchDrugs: vi.fn().mockResolvedValue([]) }))
vi.mock('../services/branchTransferService', async (importOriginal) => ({
  ...(await importOriginal()),
  listBranchTransfers: vi.fn(),
}))
vi.mock('../services/branchStockRequestService', async (importOriginal) => ({
  ...(await importOriginal()),
  listBranchStockRequests: vi.fn(),
  approveBranchStockRequest: vi.fn(),
}))

import { listBranchTransfers } from '../services/branchTransferService'
import { approveBranchStockRequest, listBranchStockRequests } from '../services/branchStockRequestService'
import StockTransfers from './StockTransfers'

const branches = [
  { id: 'main', name: 'Main Store', is_main: true, is_active: true },
  { id: 'b1', name: 'Kumasi Branch', is_main: false, is_active: true },
]
const transfer = {
  id: 't9', transfer_number: 'TRF-000009', status: 'pending', source_branch_id: 'main', destination_branch_id: 'b1',
  created_by: 'p1', created_at: '2026-11-17T10:00:00Z',
  items: [{ id: 'ti', medicine_name: 'Paracetamol 500mg', quantity_sent: '30.00', quantity_received: null }],
}
const asked = (id, overrides = {}) => ({
  id,
  request_number: `REQ-00000${id}`,
  status: 'pending',
  requesting_branch_id: 'b1',
  source_branch_id: 'main',
  created_by: 'm1',
  created_by_name: 'Kofi Boateng',
  created_at: '2026-11-17T09:00:00Z',
  items: [{ id: `ri${id}`, medicine_name: 'Paracetamol 500mg', quantity_requested: '40.00', quantity_approved: null }],
  ...overrides,
})
const signIn = (role, branchId = null) => {
  auth.current = { role, assignedRoles: [role], profile: { id: branchId === 'b1' ? 'm1' : 'p1', branch_id: branchId } }
  tenant.current = { organization: { name: 'HealthFlow Pharmacy' }, canUseMultiBranch: true }
}

describe('StockTransfers: stock requests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getBranches.mockResolvedValue(branches)
    listBranchTransfers.mockResolvedValue([])
    listBranchStockRequests.mockResolvedValue([asked('1'), asked('2', { status: 'declined', resolution_notes: 'no stock', resolved_at: '2026-11-17T11:00:00Z' })])
  })

  it('offers Request stock to a branch manager, and not to an administrator', async () => {
    signIn('branch_manager', 'b1')
    const { unmount } = render(<StockTransfers />)
    expect(await screen.findByRole('button', { name: /Request stock/ })).toBeInTheDocument()
    unmount()
    signIn('admin')
    render(<StockTransfers />)
    await screen.findByRole('tab', { name: /Stock requests/ })
    expect(screen.queryByRole('button', { name: /Request stock/ })).toBeNull()
  })

  it('shows the main store the requests waiting for its decision', async () => {
    signIn('pharmacist', 'main')
    render(<StockTransfers />)
    expect(await screen.findByRole('tab', { name: /Stock requests\s*1 to decide/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /Stock requests/ }))
    expect(await screen.findByText('REQ-000001')).toBeInTheDocument()
    expect(screen.getByText('Decide')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Needs my action\s*1/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /Closed/ }))
    expect(screen.queryByText('REQ-000001')).toBeNull()
    expect(screen.getByText('REQ-000002')).toBeInTheDocument()
  })

  it('approving opens the new transfer on the Transfers tab', async () => {
    signIn('pharmacist', 'main')
    approveBranchStockRequest.mockResolvedValue({ request_id: '1', request_number: 'REQ-000001', status: 'approved', transfer_id: 't9', transfer_number: 'TRF-000009' })
    render(<StockTransfers />)
    fireEvent.click(await screen.findByRole('tab', { name: /Stock requests/ }))
    fireEvent.click(within1(await screen.findByText('REQ-000001')))
    fireEvent.click(await screen.findByRole('button', { name: /^Approve/ }))
    listBranchTransfers.mockResolvedValue([transfer])
    fireEvent.click(screen.getByRole('button', { name: 'Approve and send' }))
    await waitFor(() => expect(approveBranchStockRequest).toHaveBeenCalled())
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining('TRF-000009 is on its way'), 'success'))
    expect(await screen.findByText('STOCK TRANSFER NOTE')).toBeInTheDocument()
  })

  it('keeps transfers working and explains on the requests tab when requests cannot load', async () => {
    signIn('branch_manager', 'b1')
    listBranchTransfers.mockResolvedValue([transfer])
    listBranchStockRequests.mockRejectedValue(new Error('Could not find the table branch_stock_requests'))
    render(<StockTransfers />)
    expect(await screen.findByText('TRF-000009')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Stock requests/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('branch_stock_requests')
  })

  it('invites a branch manager to ask when there are no requests yet', async () => {
    signIn('branch_manager', 'b1')
    listBranchStockRequests.mockResolvedValue([])
    render(<StockTransfers />)
    fireEvent.click(await screen.findByRole('tab', { name: /Stock requests/ }))
    expect(await screen.findByText('No stock requests yet')).toBeInTheDocument()
    expect(screen.getByText(/Use Request stock/)).toBeInTheDocument()
  })
})

// The row's Open button sits next to the request number.
const within1 = (cell) => cell.closest('tr').querySelector('button')
