import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/supabase', () => ({ supabase: {} }))
vi.mock('../../services/branchTransferService', async (importOriginal) => ({
  ...(await importOriginal()),
  receiveBranchTransfer: vi.fn(),
  rejectBranchTransfer: vi.fn(),
  cancelBranchTransfer: vi.fn(),
}))

import {
  cancelBranchTransfer,
  describeActor,
  receiveBranchTransfer,
  rejectBranchTransfer,
} from '../../services/branchTransferService'
import TransferDetailModal from './TransferDetailModal'

const names = { main: 'Main Store', b1: 'Kumasi Branch' }
const branchName = (id) => names[id] || 'Unknown'
const pending = (overrides = {}) => ({
  id: 't1',
  transfer_number: 'TRF-000001',
  status: 'pending',
  source_branch_id: 'main',
  destination_branch_id: 'b1',
  created_by: 'sender',
  created_by_name: 'Ama Mensah',
  created_at: '2026-11-11T09:00:00Z',
  notes: 'Weekly top-up',
  items: [
    { id: 'i1', medicine_name: 'Paracetamol 500mg', batch_number: 'B-100', expiry_date: '2030-01-01', unit: 'tab', quantity_sent: '30.00', quantity_received: null },
    { id: 'i2', medicine_name: 'Amoxicillin 250mg', batch_number: 'B-200', expiry_date: '2030-01-01', unit: 'cap', quantity_sent: '10.00', quantity_received: null },
  ],
  ...overrides,
})
const managerB1 = describeActor({ role: 'branch_manager', profile: { id: 'm1', branch_id: 'b1' } })
const sender = describeActor({ role: 'pharmacist', profile: { id: 'sender', branch_id: 'main' } })
const bystander = describeActor({ role: 'pharmacist', profile: { id: 'p2', branch_id: 'b1' } })

const open = (transfer, actor, extra = {}) => {
  const onChanged = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  render(<TransferDetailModal transfer={transfer} branchName={branchName} actor={actor} facility={{ name: 'HealthFlow Pharmacy' }} onChanged={onChanged} onClose={onClose} {...extra} />)
  return { onChanged, onClose }
}

describe('TransferDetailModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    receiveBranchTransfer.mockResolvedValue({ transfer_id: 't1', transfer_number: 'TRF-000001', status: 'received', discrepancy: true })
    rejectBranchTransfer.mockResolvedValue({ transfer_id: 't1', transfer_number: 'TRF-000001', status: 'rejected' })
    cancelBranchTransfer.mockResolvedValue({ transfer_id: 't1', transfer_number: 'TRF-000001', status: 'cancelled' })
  })

  it('shows the transfer note with both branches, the lines and signature spaces', () => {
    open(pending(), bystander)
    expect(screen.getByText('STOCK TRANSFER NOTE')).toBeInTheDocument()
    expect(screen.getAllByText('Main Store').length).toBeGreaterThan(0)
    expect(screen.getByText('Kumasi Branch')).toBeInTheDocument()
    expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument()
    expect(screen.getByText(/Received by \(name, signature, date\)/)).toBeInTheDocument()
    expect(screen.getByText('In transit')).toBeInTheDocument()
  })

  it('shows no actions, only a waiting message, to staff who cannot confirm or cancel', () => {
    open(pending(), bystander)
    expect(screen.queryByRole('button', { name: /Confirm receipt/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Cancel transfer/ })).toBeNull()
    expect(screen.getByText(/Waiting for a manager or administrator at Kumasi Branch/)).toBeInTheDocument()
  })

  it('lets the receiving branch manager confirm a short delivery and tells them what goes back', async () => {
    const { onChanged } = open(pending(), managerB1)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm receipt' }))

    const paracetamol = screen.getByLabelText('Received quantity of Paracetamol 500mg')
    expect(paracetamol.value).toBe('30')
    fireEvent.change(paracetamol, { target: { value: '25' } })
    expect(screen.getByText(/1 line\(s\) short: Paracetamol 500mg/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Receiving note (optional)'), { target: { value: 'one pack damaged' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm what arrived' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(receiveBranchTransfer).toHaveBeenCalledWith({
      transferId: 't1',
      lines: [{ itemId: 'i1', quantityReceived: '25' }, { itemId: 'i2', quantityReceived: '10' }],
      notes: 'one pack damaged',
    })
  })

  it('blocks receiving more than was sent, or nothing at all', () => {
    open(pending(), managerB1)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm receipt' }))
    const confirm = screen.getByRole('button', { name: 'Confirm what arrived' })

    fireEvent.change(screen.getByLabelText('Received quantity of Paracetamol 500mg'), { target: { value: '31' } })
    expect(screen.getByText(/cannot receive more than the 30 sent/)).toBeInTheDocument()
    expect(confirm).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Received quantity of Paracetamol 500mg'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Received quantity of Amoxicillin 250mg'), { target: { value: '0' } })
    expect(screen.getByText(/Use Reject to send the whole transfer back/)).toBeInTheDocument()
    expect(confirm).toBeDisabled()
    expect(receiveBranchTransfer).not.toHaveBeenCalled()
  })

  it('needs a reason before rejecting', async () => {
    const { onChanged } = open(pending(), managerB1)
    fireEvent.click(screen.getByRole('button', { name: 'Reject…' }))
    const submit = screen.getByRole('button', { name: 'Reject transfer' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Reason *'), { target: { value: 'Wrong strength sent' } })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(rejectBranchTransfer).toHaveBeenCalledWith({ transferId: 't1', reason: 'Wrong strength sent' })
  })

  it('lets the sender cancel while pending, but not confirm receipt', async () => {
    const { onChanged } = open(pending(), sender)
    expect(screen.queryByRole('button', { name: 'Confirm receipt' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel transfer…' }))
    fireEvent.change(screen.getByLabelText('Reason *'), { target: { value: 'Sent by mistake' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel transfer' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(cancelBranchTransfer).toHaveBeenCalledWith({ transferId: 't1', reason: 'Sent by mistake' })
  })

  it('keeps the dialog open and shows the database message when an action fails', async () => {
    receiveBranchTransfer.mockRejectedValue(new Error('This transfer is already received.'))
    const { onChanged } = open(pending(), managerB1)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm receipt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm what arrived' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already received')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('shows a completed transfer with the short quantity and no actions', () => {
    open(pending({
      status: 'received',
      resolved_at: '2026-11-11T12:00:00Z',
      resolved_by_name: 'Kofi Boateng',
      resolution_notes: 'one pack damaged',
      items: [
        { id: 'i1', medicine_name: 'Paracetamol 500mg', unit: 'tab', quantity_sent: '30.00', quantity_received: '25.00' },
        { id: 'i2', medicine_name: 'Amoxicillin 250mg', unit: 'cap', quantity_sent: '10.00', quantity_received: '10.00' },
      ],
    }), managerB1)
    expect(document.querySelector('.stx-badge--received')).toHaveTextContent('Received')
    expect(screen.getByText(/short 5/)).toBeInTheDocument()
    expect(screen.getByText(/5 unit\(s\) were short on arrival and went back to Main Store/)).toBeInTheDocument()
    expect(screen.getByText(/one pack damaged/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm receipt' })).toBeNull()
  })
})
