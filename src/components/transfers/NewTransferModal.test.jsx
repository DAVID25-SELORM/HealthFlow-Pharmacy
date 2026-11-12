import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/supabase', () => ({ supabase: {} }))
vi.mock('../../services/drugService', () => ({ searchDrugs: vi.fn() }))
vi.mock('../../services/branchTransferService', async (importOriginal) => ({
  ...(await importOriginal()),
  dispatchBranchTransfer: vi.fn(),
}))

import { searchDrugs } from '../../services/drugService'
import { describeActor, dispatchBranchTransfer } from '../../services/branchTransferService'
import NewTransferModal from './NewTransferModal'

const branches = [
  { id: 'main', name: 'Main Store', is_main: true, is_active: true },
  { id: 'b1', name: 'Kumasi Branch', is_main: false, is_active: true },
  { id: 'b2', name: 'Tema Branch', is_main: false, is_active: true },
  { id: 'old', name: 'Closed Branch', is_main: false, is_active: false },
]
const para = { id: 'd1', name: 'Paracetamol 500mg', batch_number: 'B-100', expiry_date: '2030-01-01', quantity: '70', unit: 'tab' }
const expired = { id: 'd2', name: 'Old Syrup', batch_number: 'B-300', expiry_date: '2020-01-01', quantity: '10', unit: 'btl' }
const admin = describeActor({ role: 'admin', profile: { id: 'a1', branch_id: null } })
const mainPharmacist = describeActor({ role: 'pharmacist', profile: { id: 'p1', branch_id: 'main' } })

const open = (actor = admin, props = {}) => {
  const onSent = vi.fn()
  const onClose = vi.fn()
  render(<NewTransferModal branches={branches} actor={actor} onSent={onSent} onClose={onClose} {...props} />)
  return { onSent, onClose }
}

const addParacetamol = async () => {
  fireEvent.change(screen.getByLabelText('Search medicines to add'), { target: { value: 'para' } })
  fireEvent.click(await screen.findByRole('button', { name: /Paracetamol 500mg/ }))
}

describe('NewTransferModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchDrugs.mockResolvedValue([para, expired])
    dispatchBranchTransfer.mockResolvedValue({ transfer_id: 't1', transfer_number: 'TRF-000001', status: 'pending', lines: 1 })
  })

  it('starts from the main store and offers only active, different branches as destination', () => {
    open()
    expect(screen.getByLabelText('From branch *').value).toBe('main')
    const destinations = [...screen.getByLabelText('To branch *').querySelectorAll('option')].map((o) => o.textContent)
    expect(destinations).toEqual(['Select branch', 'Kumasi Branch', 'Tema Branch'])
  })

  it('keeps branch-bound staff on their own branch', () => {
    const inB1 = describeActor({ role: 'pharmacist', profile: { id: 'p9', branch_id: 'b1' } })
    open(inB1)
    const sources = [...screen.getByLabelText('From branch *').querySelectorAll('option')].map((o) => o.textContent)
    expect(sources).toEqual(['Kumasi Branch'])
  })

  it('searches only the sending branch, adds a line and sends the transfer', async () => {
    const { onSent } = open(mainPharmacist)
    fireEvent.change(screen.getByLabelText('To branch *'), { target: { value: 'b1' } })
    await addParacetamol()

    expect(searchDrugs).toHaveBeenCalledWith('para', { branchId: 'main', inStockOnly: true, limit: 12 })
    const send = screen.getByRole('button', { name: /^Send/ })
    expect(send).toBeDisabled() // no quantity yet

    fireEvent.change(screen.getByLabelText('Quantity of Paracetamol 500mg to send'), { target: { value: '30' } })
    expect(send).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Weekly top-up' } })
    fireEvent.click(send)

    await waitFor(() => expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ transfer_number: 'TRF-000001' }), 'Kumasi Branch'))
    expect(dispatchBranchTransfer).toHaveBeenCalledWith({
      sourceBranchId: 'main',
      destinationBranchId: 'b1',
      items: [{ drugId: 'd1', quantity: '30' }],
      notes: 'Weekly top-up',
    })
  })

  it('will not add expired stock or the same line twice', async () => {
    open()
    fireEvent.change(screen.getByLabelText('Search medicines to add'), { target: { value: 'sy' } })
    const expiredButton = await screen.findByRole('button', { name: /Old Syrup/ })
    expect(expiredButton).toBeDisabled()
    expect(expiredButton).toHaveTextContent('EXPIRED')

    fireEvent.click(await screen.findByRole('button', { name: /Paracetamol 500mg/ }))
    fireEvent.change(screen.getByLabelText('Search medicines to add'), { target: { value: 'para' } })
    expect(await screen.findByRole('button', { name: /Paracetamol 500mg.*added/ })).toBeDisabled()
  })

  it('blocks a quantity above stock, zero, or too many decimals', async () => {
    open()
    fireEvent.change(screen.getByLabelText('To branch *'), { target: { value: 'b1' } })
    await addParacetamol()
    const qty = screen.getByLabelText('Quantity of Paracetamol 500mg to send')
    const send = screen.getByRole('button', { name: /^Send/ })

    fireEvent.change(qty, { target: { value: '71' } })
    expect(screen.getByText('Only 70 in stock.')).toBeInTheDocument()
    expect(send).toBeDisabled()
    fireEvent.change(qty, { target: { value: '0' } })
    expect(send).toBeDisabled()
    fireEvent.change(qty, { target: { value: '1.234' } })
    expect(screen.getByText('Use at most 2 decimals.')).toBeInTheDocument()
    expect(send).toBeDisabled()
    fireEvent.change(qty, { target: { value: '70' } })
    expect(send).toBeEnabled()
  })

  it('clears the lines when the sending branch changes, since stock belongs to a branch', async () => {
    open()
    await addParacetamol()
    expect(screen.getByLabelText('Quantity of Paracetamol 500mg to send')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('From branch *'), { target: { value: 'b2' } })
    expect(screen.queryByLabelText('Quantity of Paracetamol 500mg to send')).toBeNull()
  })

  it('shows the database refusal and stays open', async () => {
    dispatchBranchTransfer.mockRejectedValue(new Error('Not enough Paracetamol 500mg in stock: 5 available, 30 requested.'))
    const { onSent } = open()
    fireEvent.change(screen.getByLabelText('To branch *'), { target: { value: 'b1' } })
    await addParacetamol()
    fireEvent.change(screen.getByLabelText('Quantity of Paracetamol 500mg to send'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough Paracetamol')
    expect(onSent).not.toHaveBeenCalled()
  })
})
