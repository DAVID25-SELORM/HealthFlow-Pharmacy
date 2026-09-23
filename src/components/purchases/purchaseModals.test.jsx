import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ReceiveGoodsModal from './ReceiveGoodsModal'
import CancelOrderModal from './CancelOrderModal'
import PurchaseOrderDocument from './PurchaseOrderDocument'

const purchase = (overrides = {}) => ({
  id: 'p1',
  purchase_number: 'PO-000123',
  status: 'partially_received',
  supplier_name: 'MedSupply Ltd',
  purchase_date: '2026-09-20',
  ordered_at: '2026-09-21T09:00:00Z',
  notes: 'Deliver before Friday',
  purchase_items: [
    { id: 'i1', drug_name: 'Amoxicillin 500mg', generic_name: 'Amoxicillin', quantity: 100, received_quantity: 60, unit: 'capsule', unit_cost: 2.5 },
    { id: 'i2', drug_name: 'Ibuprofen 200mg', quantity: 10, received_quantity: 10, unit: 'tablet', unit_cost: 1 },
    { id: 'i3', drug_name: 'Vitamin C 500mg', quantity: 20, received_quantity: 0, unit: 'tablet', unit_cost: 0.5 },
  ],
  ...overrides,
})

describe('ReceiveGoodsModal', () => {
  const onSubmit = vi.fn()
  const onClose = vi.fn()
  beforeEach(() => vi.clearAllMocks())

  it('lists only items with something outstanding and defaults to receiving all of it', () => {
    render(<ReceiveGoodsModal purchase={purchase()} onClose={onClose} onSubmit={onSubmit} />)
    expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument()
    expect(screen.getByText('Vitamin C 500mg')).toBeInTheDocument()
    expect(screen.queryByText('Ibuprofen 200mg')).not.toBeInTheDocument()
    expect(screen.getByText(/Ordered 100 · Received 60 · Outstanding 40/)).toBeInTheDocument()
    expect(screen.getAllByLabelText('Quantity received')[0]).toHaveValue(40)
  })

  it('submits a partial delivery with batch, expiry and cost, and a receipt key', async () => {
    render(<ReceiveGoodsModal purchase={purchase()} onClose={onClose} onSubmit={onSubmit} />)
    const [qty1, qty2] = screen.getAllByLabelText('Quantity received')
    fireEvent.change(qty1, { target: { value: '25' } })
    fireEvent.change(qty2, { target: { value: '' } })
    fireEvent.change(screen.getAllByLabelText('Batch no.')[0], { target: { value: 'B-77' } })
    fireEvent.change(screen.getAllByLabelText('Expiry date')[0], { target: { value: '2029-03-31' } })
    fireEvent.change(screen.getAllByLabelText('Unit cost (GHS)')[0], { target: { value: '3.2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Receive stock' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const [lines, options] = onSubmit.mock.calls[0]
    expect(lines).toEqual([{ purchaseItemId: 'i1', quantity: 25, batchNumber: 'B-77', expiryDate: '2029-03-31', unitCost: '3.2' }])
    expect(options.receiptKey).toBeTruthy()
  })

  it('reuses the same receipt key on a retry, so the delivery can never be posted twice', async () => {
    render(<ReceiveGoodsModal purchase={purchase()} onClose={onClose} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Receive stock' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Receive stock' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSubmit.mock.calls[0][1].receiptKey).toBe(onSubmit.mock.calls[1][1].receiptKey)
  })

  it('refuses to receive more than is outstanding and does not submit', () => {
    render(<ReceiveGoodsModal purchase={purchase()} onClose={onClose} onSubmit={onSubmit} />)
    fireEvent.change(screen.getAllByLabelText('Quantity received')[0], { target: { value: '41' } })
    fireEvent.click(screen.getByRole('button', { name: 'Receive stock' }))
    expect(screen.getByRole('alert')).toHaveTextContent('only 40 is outstanding')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('supports a second batch of the same item, checking the combined total', async () => {
    render(<ReceiveGoodsModal purchase={purchase()} onClose={onClose} onSubmit={onSubmit} />)
    fireEvent.change(screen.getAllByLabelText('Quantity received')[0], { target: { value: '30' } })
    fireEvent.click(screen.getAllByRole('button', { name: '+ Another batch' })[0])
    const quantities = screen.getAllByLabelText('Quantity received')
    expect(quantities).toHaveLength(3)
    // 30 + 15 = 45 is more than the 40 outstanding: refused.
    fireEvent.change(quantities[1], { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Receive stock' }))
    expect(screen.getByRole('alert')).toHaveTextContent('receiving 45 but only 40')
    expect(onSubmit).not.toHaveBeenCalled()
    // 30 + 10 = 40 fits, in two batches.
    fireEvent.change(quantities[1], { target: { value: '10' } })
    fireEvent.change(screen.getAllByLabelText('Batch no.')[1], { target: { value: 'B-2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Receive stock' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].filter((line) => line.purchaseItemId === 'i1').map((line) => line.quantity)).toEqual([30, 10])
  })

  it('shows how the entered unit cost differs from the ordered cost, and flags a large change without blocking', async () => {
    render(<ReceiveGoodsModal purchase={purchase()} onClose={onClose} onSubmit={onSubmit} />)
    const cost = screen.getAllByLabelText('Unit cost (GHS)')[0] // ordered at 2.5
    fireEvent.change(cost, { target: { value: '2.6' } })
    expect(screen.getByText('+4% vs ordered cost')).toBeInTheDocument()
    fireEvent.change(cost, { target: { value: '4' } })
    expect(screen.getByText(/\+60% vs ordered cost — please check the invoice/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Receive stock' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled()) // a big change never blocks
  })

  it('shows a message and disables receiving when nothing is outstanding', () => {
    const done = purchase({ purchase_items: [{ id: 'i2', drug_name: 'Ibuprofen 200mg', quantity: 10, received_quantity: 10 }] })
    render(<ReceiveGoodsModal purchase={done} onClose={onClose} onSubmit={onSubmit} />)
    expect(screen.getByText('Nothing is outstanding on this order.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Receive stock' })).toBeDisabled()
  })
})

describe('CancelOrderModal', () => {
  const onConfirm = vi.fn()
  beforeEach(() => vi.clearAllMocks())

  it('requires a reason for an order that has been placed', () => {
    render(<CancelOrderModal purchase={purchase({ status: 'ordered' })} onClose={vi.fn()} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a reason')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('passes the trimmed reason through once entered', async () => {
    render(<CancelOrderModal purchase={purchase({ status: 'ordered' })} onClose={vi.fn()} onConfirm={onConfirm} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Supplier out of stock ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Supplier out of stock'))
  })

  it('does not require a reason for a draft', async () => {
    render(<CancelOrderModal purchase={purchase({ status: 'draft' })} onClose={vi.fn()} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(''))
  })

  it('tells the user what happens to stock already received', () => {
    render(<CancelOrderModal purchase={purchase()} onClose={vi.fn()} onConfirm={onConfirm} />)
    expect(screen.getByText(/70 units already received stay in stock\. The remaining 60 will no longer count as incoming/)).toBeInTheDocument()
  })
})

describe('PurchaseOrderDocument', () => {
  const facility = { name: 'Health Light Pharmacy', address: '12 Market Rd', city: 'Accra', phone: '0244000000', email: 'hello@example.test' }
  const supplier = { name: 'MedSupply Ltd', contact_person: 'Kofi Mensah', phone: '0201112222' }

  it('contains everything a supplier needs to fulfil the order', () => {
    render(<PurchaseOrderDocument purchase={purchase()} facility={facility} supplier={supplier} createdBy="Ama Boateng" onClose={vi.fn()} />)
    const sheet = document.querySelector('.po-print-sheet')
    const inSheet = within(sheet)
    expect(inSheet.getByText('Health Light Pharmacy')).toBeInTheDocument()
    expect(inSheet.getByText(/12 Market Rd, Accra/)).toBeInTheDocument()
    expect(sheet).toHaveTextContent('PO-000123')
    expect(sheet).toHaveTextContent('Ama Boateng')
    expect(inSheet.getByText('MedSupply Ltd')).toBeInTheDocument()
    expect(sheet).toHaveTextContent('Kofi Mensah')
    expect(sheet).toHaveTextContent('Amoxicillin 500mg')
    expect(sheet).toHaveTextContent('Deliver before Friday')
    expect(sheet).toHaveTextContent('Prepared by')
    expect(sheet).toHaveTextContent('Approved by')
  })

  it('shows estimated line and grand totals (quantity x estimated unit cost)', () => {
    render(<PurchaseOrderDocument purchase={purchase()} facility={facility} onClose={vi.fn()} />)
    // 100*2.5 + 10*1 + 20*0.5 = 270
    expect(document.querySelector('.po-sheet-table tfoot')).toHaveTextContent('GHS 270.00')
    expect(document.querySelector('.po-sheet-table tbody')).toHaveTextContent('GHS 250.00')
  })

  it('prints only the sheet: the Print button calls window.print and the controls are print-hidden', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    render(<PurchaseOrderDocument purchase={purchase()} facility={facility} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /print/i }))
    expect(print).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.modal-header')).toHaveClass('po-print-hide')
    print.mockRestore()
  })
})
