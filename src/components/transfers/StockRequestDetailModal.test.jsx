import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/supabase', () => ({ supabase: {} }))
vi.mock('../../services/branchStockRequestService', async (importOriginal) => ({
  ...(await importOriginal()),
  approveBranchStockRequest: vi.fn(),
  declineBranchStockRequest: vi.fn(),
  cancelBranchStockRequest: vi.fn(),
}))

import {
  approveBranchStockRequest,
  cancelBranchStockRequest,
  declineBranchStockRequest,
} from '../../services/branchStockRequestService'
import { describeActor } from '../../services/branchTransferService'
import StockRequestDetailModal from './StockRequestDetailModal'

const names = { main: 'Main Store', b1: 'Kumasi Branch' }
const branchName = (id) => names[id] || 'Unknown'
const request = (overrides = {}) => ({
  id: 'r1',
  request_number: 'REQ-000001',
  status: 'pending',
  requesting_branch_id: 'b1',
  source_branch_id: 'main',
  created_by: 'asker',
  created_by_name: 'Kofi Boateng',
  created_at: '2026-11-17T09:00:00Z',
  notes: 'Weekend stock',
  items: [
    { id: 'i1', medicine_name: 'Amoxicillin 250mg', batch_number: 'A1', unit: 'caps', quantity_requested: '5.00', quantity_approved: null },
    { id: 'i2', medicine_name: 'Paracetamol 500mg', batch_number: 'P1', unit: 'tabs', quantity_requested: '40.00', quantity_approved: null },
  ],
  ...overrides,
})
const mainPharmacist = describeActor({ role: 'pharmacist', profile: { id: 'p1', branch_id: 'main' } })
const kumasiManager = describeActor({ role: 'branch_manager', profile: { id: 'm1', branch_id: 'b1' } })

const open = (actor, req = request()) => {
  const onChanged = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  render(<StockRequestDetailModal request={req} branchName={branchName} actor={actor} onClose={onClose} onChanged={onChanged} />)
  return { onChanged, onClose }
}

describe('StockRequestDetailModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    approveBranchStockRequest.mockResolvedValue({ request_id: 'r1', request_number: 'REQ-000001', status: 'approved', transfer_id: 't1', transfer_number: 'TRF-000009' })
    declineBranchStockRequest.mockResolvedValue({ request_id: 'r1', request_number: 'REQ-000001', status: 'declined' })
    cancelBranchStockRequest.mockResolvedValue({ request_id: 'r1', request_number: 'REQ-000001', status: 'cancelled' })
  })

  it('shows who asked whom, for what, to the asked branch with Approve and Decline', () => {
    open(mainPharmacist)
    expect(screen.getByText(/asked/)).toHaveTextContent('Kumasi Branch asked Main Store for stock')
    expect(screen.getByText('Amoxicillin 250mg')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Decline/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Cancel request/ })).toBeNull()
  })

  it('shows the asking branch manager Cancel only, with a waiting message when nobody can decide for them', () => {
    open(kumasiManager)
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^Cancel request/ })).toBeInTheDocument()
  })

  it('approves with a lowered quantity and a dropped line', async () => {
    const { onChanged } = open(mainPharmacist)
    fireEvent.click(screen.getByRole('button', { name: /^Approve/ }))
    fireEvent.change(screen.getByLabelText('Quantity of Paracetamol 500mg to send'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('Quantity of Amoxicillin 250mg to send'), { target: { value: '0' } })
    expect(screen.getByText(/Sending less than asked:.*Paracetamol 500mg/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Note to Kumasi Branch/), { target: { value: 'Only 30 spare' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve and send' }))
    await waitFor(() => expect(approveBranchStockRequest).toHaveBeenCalledWith({
      requestId: 'r1',
      lines: [{ itemId: 'i1', quantityApproved: '0' }, { itemId: 'i2', quantityApproved: '30' }],
      notes: 'Only 30 spare',
    }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' })))
  })

  it('will not approve more than asked, or nothing at all', () => {
    open(mainPharmacist)
    fireEvent.click(screen.getByRole('button', { name: /^Approve/ }))
    fireEvent.change(screen.getByLabelText('Quantity of Paracetamol 500mg to send'), { target: { value: '41' } })
    expect(screen.getByText(/cannot send more than the 40 asked for/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Quantity of Paracetamol 500mg to send'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Quantity of Amoxicillin 250mg to send'), { target: { value: '0' } })
    expect(screen.getByText(/Nothing to send/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeDisabled()
  })

  it('declines only with a reason of 5 characters or more', async () => {
    const { onChanged } = open(mainPharmacist)
    fireEvent.click(screen.getByRole('button', { name: /^Decline/ }))
    const submit = screen.getByRole('button', { name: 'Decline request' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Need it for Tema' } })
    fireEvent.click(submit)
    await waitFor(() => expect(declineBranchStockRequest).toHaveBeenCalledWith({ requestId: 'r1', reason: 'Need it for Tema' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('lets the asker cancel with a reason', async () => {
    open(kumasiManager)
    fireEvent.click(screen.getByRole('button', { name: /^Cancel request/ }))
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Ordered elsewhere' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }))
    await waitFor(() => expect(cancelBranchStockRequest).toHaveBeenCalledWith({ requestId: 'r1', reason: 'Ordered elsewhere' }))
  })

  it('shows the database message and keeps the form when approving fails (stock ran short)', async () => {
    approveBranchStockRequest.mockRejectedValueOnce(new Error('Not enough Paracetamol 500mg in stock: 3 available, 40 requested.'))
    const { onChanged } = open(mainPharmacist)
    fireEvent.click(screen.getByRole('button', { name: /^Approve/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve and send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough Paracetamol 500mg in stock')
    expect(onChanged).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeEnabled() // they can lower the quantity and retry
  })

  it('shows what was approved on a closed request and offers no buttons', () => {
    open(mainPharmacist, request({
      status: 'approved', resolved_at: '2026-11-17T10:00:00Z', resolved_by_name: 'Ama Mensah', resolution_notes: 'Only 30 spare',
      items: [{ id: 'i2', medicine_name: 'Paracetamol 500mg', batch_number: 'P1', unit: 'tabs', quantity_requested: '40.00', quantity_approved: '30.00' }],
    }))
    expect(screen.getByText(/Approved/, { selector: 'p strong' })).toBeInTheDocument()
    expect(screen.getByText(/Only 30 spare/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull()
    expect(screen.getByText(/confirms what arrived on the Transfers tab/)).toBeInTheDocument()
  })
})
