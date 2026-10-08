import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import SupplierEditor from './SupplierEditor'
import { updateSupplier } from '../services/purchasesService'
vi.mock('../services/purchasesService', () => ({ updateSupplier: vi.fn() }))

it('edits supplier details and reports the saved record', async () => {
  const saved = vi.fn()
  updateSupplier.mockResolvedValue({ id: 'supplier-1', name: 'New name' })
  render(<SupplierEditor supplier={{ id: 'supplier-1', name: 'Old name', phone: '123' }} onSaved={saved} onClose={() => {}} />)
  fireEvent.change(screen.getByLabelText('Supplier name'), { target: { value: 'New name' } })
  fireEvent.change(screen.getByLabelText('Contact person'), { target: { value: 'Officer' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save supplier' }))
  await waitFor(() => expect(saved).toHaveBeenCalledWith({ id: 'supplier-1', name: 'New name' }))
  expect(updateSupplier).toHaveBeenCalledWith('supplier-1', expect.objectContaining({ name: 'New name', phone: '123', contactPerson: 'Officer' }))
})

it('keeps edits available when the save fails', async () => {
  updateSupplier.mockRejectedValue(new Error('Permission denied'))
  render(<SupplierEditor supplier={{ id: 'supplier-1', name: 'Supplier' }} onSaved={() => {}} onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save supplier' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied')
  expect(screen.getByLabelText('Supplier name')).toHaveValue('Supplier')
})
