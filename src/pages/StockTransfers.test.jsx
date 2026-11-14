import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { auth, tenant, notify, getBranches, createBranch } = vi.hoisted(() => ({
  auth: { current: {} },
  tenant: { current: {} },
  notify: vi.fn(),
  getBranches: vi.fn(),
  createBranch: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ supabase: {} }))
vi.mock('../lib/appEvents', () => ({ dispatchHealthflowDataChanged: vi.fn() }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth.current }))
vi.mock('../context/TenantContext', () => ({ useTenant: () => tenant.current }))
vi.mock('../context/NotificationContext', () => ({ useNotification: () => ({ notify }) }))
vi.mock('../services/branchService', () => ({ getBranches, createBranch }))
vi.mock('../services/drugService', () => ({ searchDrugs: vi.fn().mockResolvedValue([]) }))
vi.mock('../services/branchTransferService', async (importOriginal) => ({
  ...(await importOriginal()),
  listBranchTransfers: vi.fn(),
}))

import { listBranchTransfers } from '../services/branchTransferService'
import StockTransfers from './StockTransfers'

const branches = [
  { id: 'main', name: 'Main Store', is_main: true, is_active: true },
  { id: 'b1', name: 'Kumasi Branch', is_main: false, is_active: true },
]
const row = (id, overrides = {}) => ({
  id,
  transfer_number: `TRF-00000${id}`,
  status: 'pending',
  source_branch_id: 'main',
  destination_branch_id: 'b1',
  created_by: 'sender',
  created_by_name: 'Ama Mensah',
  created_at: '2026-11-11T09:00:00Z',
  items: [{ id: `i${id}`, medicine_name: 'Paracetamol 500mg', quantity_sent: '30.00', quantity_received: null }],
  ...overrides,
})
const signIn = (role, branchId = null, extra = {}) => {
  auth.current = { role, assignedRoles: [role], profile: { id: 'me', branch_id: branchId } }
  tenant.current = { organization: { name: 'HealthFlow Pharmacy' }, canUseMultiBranch: true, ...extra }
}
const view = () => render(<StockTransfers />)

describe('StockTransfers page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getBranches.mockResolvedValue(branches)
    listBranchTransfers.mockResolvedValue([
      row('1'),
      row('2', { status: 'received', items: [{ id: 'i9', medicine_name: 'Zinc', quantity_sent: '10', quantity_received: '8' }] }),
      row('3', { status: 'rejected', resolution_notes: 'wrong strength' }),
    ])
  })

  it('lists transfers and counts each view, highlighting what needs the manager', async () => {
    signIn('branch_manager', 'b1')
    view()
    expect(await screen.findByText('TRF-000001')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Needs my action\s*1/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /In transit\s*1/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Completed\s*2/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /All\s*3/ })).toBeInTheDocument()
    expect(screen.getByText('Confirm')).toBeInTheDocument() // the action flag on TRF-000001
    expect(screen.getByText('Short')).toBeInTheDocument() // received 8 of 10

    fireEvent.click(screen.getByRole('tab', { name: /Needs my action/ }))
    expect(screen.getByText('TRF-000001')).toBeInTheDocument()
    expect(screen.queryByText('TRF-000002')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Completed/ }))
    expect(screen.queryByText('TRF-000001')).toBeNull()
    expect(screen.getByText('TRF-000002')).toBeInTheDocument()
    expect(screen.getByText('TRF-000003')).toBeInTheDocument()
  })

  it('searches by medicine and opens the transfer note', async () => {
    signIn('admin')
    view()
    await screen.findByText('TRF-000001')
    fireEvent.change(screen.getByPlaceholderText(/Search number, branch or medicine/), { target: { value: 'zinc' } })
    expect(screen.queryByText('TRF-000001')).toBeNull()
    fireEvent.click(within(screen.getByText('TRF-000002').closest('tr')).getByRole('button', { name: 'Open' }))
    expect(await screen.findByText('STOCK TRANSFER NOTE')).toBeInTheDocument()
  })

  it('offers New transfer to inventory staff, but not to staff without a way to send', async () => {
    signIn('pharmacist', 'main')
    view()
    await screen.findByText('TRF-000001')
    expect(screen.getByRole('button', { name: /New transfer/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add branch/ })).toBeNull() // only administrators and branch managers add branches
  })

  it('lets a branch manager add a branch and then refreshes the list', async () => {
    signIn('branch_manager', 'b1')
    createBranch.mockResolvedValue({ id: 'b9', name: 'Takoradi Branch' })
    view()
    await screen.findByText('TRF-000001')
    fireEvent.click(screen.getByRole('button', { name: /Add branch/ }))
    fireEvent.change(await screen.findByLabelText(/Branch name/), { target: { value: 'Takoradi Branch' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' }))
    await waitFor(() => expect(createBranch).toHaveBeenCalledWith(expect.objectContaining({ name: 'Takoradi Branch' })))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Branch "Takoradi Branch" created.', 'success'))
    expect(getBranches.mock.calls.length).toBeGreaterThan(1)
  })

  it('shows the multi-branch lock for a pharmacy with one branch and the switch off', async () => {
    signIn('admin', null, { canUseMultiBranch: false })
    getBranches.mockResolvedValue([branches[0]])
    listBranchTransfers.mockResolvedValue([])
    view()
    expect(await screen.findByText('Transfers need at least two branches')).toBeInTheDocument()
    expect(screen.getByText(/Multi-branch is not enabled for this pharmacy yet/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Add branch/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Multi-branch is not enabled')
    expect(screen.getByRole('button', { name: 'Create branch' })).toBeDisabled()
    expect(createBranch).not.toHaveBeenCalled()
  })

  it('invites a pharmacy with one branch and the switch on to add another', async () => {
    signIn('admin')
    getBranches.mockResolvedValue([branches[0]])
    listBranchTransfers.mockResolvedValue([])
    view()
    expect(await screen.findByText(/Use Add branch above/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /New transfer/ })).toBeNull()
  })

  it('reports a load failure', async () => {
    signIn('admin')
    listBranchTransfers.mockRejectedValue(new Error('Unable to load transfers.'))
    view()
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load transfers.')
  })
})
