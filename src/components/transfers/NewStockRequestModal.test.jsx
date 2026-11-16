import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/supabase', () => ({ supabase: {} }))
vi.mock('../../services/branchStockRequestService', async (importOriginal) => ({
  ...(await importOriginal()),
  searchBranchStockForRequest: vi.fn(),
  createBranchStockRequest: vi.fn(),
}))

import { createBranchStockRequest, searchBranchStockForRequest } from '../../services/branchStockRequestService'
import { describeActor } from '../../services/branchTransferService'
import NewStockRequestModal from './NewStockRequestModal'

const branches = [
  { id: 'main', name: 'Main Store', is_main: true, is_active: true },
  { id: 'b1', name: 'Kumasi Branch', is_main: false, is_active: true },
  { id: 'b2', name: 'Tema Branch', is_main: false, is_active: true },
  { id: 'old', name: 'Closed Branch', is_main: false, is_active: false },
]
const para = { id: 'd1', name: 'Paracetamol 500mg', batch_number: 'B-100', expiry_date: '2030-01-01', quantity: '70', unit: 'tab' }
const manager = describeActor({ role: 'branch_manager', profile: { id: 'm1', branch_id: 'b1' } })

const open = () => {
  const onSent = vi.fn()
  const onClose = vi.fn()
  render(<NewStockRequestModal branches={branches} actor={manager} onSent={onSent} onClose={onClose} />)
  return { onSent, onClose }
}

describe('NewStockRequestModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchBranchStockForRequest.mockResolvedValue([para])
    createBranchStockRequest.mockResolvedValue({ request_id: 'r1', request_number: 'REQ-000001', status: 'pending', lines: 1 })
  })

  it('asks the main store by default, for the manager’s own branch, never for a closed or own branch', () => {
    open()
    expect(screen.getByLabelText('Ask *').value).toBe('main')
    const options = [...screen.getByLabelText('Ask *').querySelectorAll('option')].map((o) => o.textContent)
    expect(options).toEqual(['Main Store (main store)', 'Tema Branch'])
    expect(screen.getByLabelText('Stock goes to').value).toBe('Kumasi Branch')
  })

  it('searches the asked branch, adds a line and sends the request for the own branch', async () => {
    const { onSent } = open()
    fireEvent.change(screen.getByLabelText('Search medicines to request'), { target: { value: 'para' } })
    fireEvent.click(await screen.findByRole('button', { name: /Paracetamol 500mg/ }))
    expect(searchBranchStockForRequest).toHaveBeenCalledWith({ sourceBranchId: 'main', term: 'para', limit: 12 })

    const send = screen.getByRole('button', { name: 'Send request' })
    expect(send).toBeDisabled() // no quantity yet
    fireEvent.change(screen.getByLabelText('Quantity of Paracetamol 500mg needed'), { target: { value: '40' } })
    expect(send).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Weekend stock' } })
    fireEvent.click(send)

    await waitFor(() => expect(createBranchStockRequest).toHaveBeenCalledWith({
      sourceBranchId: 'main',
      requestingBranchId: 'b1',
      items: [{ drugId: 'd1', quantity: '40' }],
      notes: 'Weekend stock',
    }))
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ request_number: 'REQ-000001' }), 'Main Store'))
  })

  it('allows asking for more than is available, with a hint, and rejects bad quantities', async () => {
    open()
    fireEvent.change(screen.getByLabelText('Search medicines to request'), { target: { value: 'para' } })
    fireEvent.click(await screen.findByRole('button', { name: /Paracetamol 500mg/ }))
    const quantity = screen.getByLabelText('Quantity of Paracetamol 500mg needed')
    fireEvent.change(quantity, { target: { value: '500' } })
    expect(screen.getByText(/they may send less/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send request' })).toBeEnabled()
    fireEvent.change(quantity, { target: { value: '1.234' } })
    expect(screen.getByText('Use at most 2 decimals.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled()
  })

  it('clears the lines when the asked branch changes and shows the database message when sending fails', async () => {
    open()
    fireEvent.change(screen.getByLabelText('Search medicines to request'), { target: { value: 'para' } })
    fireEvent.click(await screen.findByRole('button', { name: /Paracetamol 500mg/ }))
    fireEvent.change(screen.getByLabelText('Ask *'), { target: { value: 'b2' } })
    expect(screen.queryByLabelText('Quantity of Paracetamol 500mg needed')).toBeNull()

    fireEvent.change(screen.getByLabelText('Search medicines to request'), { target: { value: 'para' } })
    fireEvent.click(await screen.findByRole('button', { name: /Paracetamol 500mg/ }))
    fireEvent.change(screen.getByLabelText('Quantity of Paracetamol 500mg needed'), { target: { value: '5' } })
    createBranchStockRequest.mockRejectedValueOnce(new Error('Only inventory staff can request stock.'))
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Only inventory staff can request stock.')
  })
})
