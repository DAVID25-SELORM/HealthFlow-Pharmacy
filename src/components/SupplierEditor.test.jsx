import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import SupplierEditor from './SupplierEditor'
import { manageSupplier, updateSupplier } from '../services/purchasesService'
import { confirmAction } from '../utils/actionConfirmation'
vi.mock('../services/purchasesService', () => ({ manageSupplier: vi.fn(), updateSupplier: vi.fn() }))
vi.mock('../utils/actionConfirmation', () => ({ confirmAction: vi.fn() }))

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

it.each([[true, 'Suspend supplier', 'suspend'], [false, 'Reactivate supplier', 'reactivate']])('changes supplier active status %s', async (isActive, label, action) => {
  const saved = vi.fn()
  manageSupplier.mockResolvedValue({ id: 'supplier-1', is_active: !isActive })
  render(<SupplierEditor supplier={{ id: 'supplier-1', name: 'Supplier', is_active: isActive }} onSaved={saved} onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: label }))
  await waitFor(() => expect(saved).toHaveBeenCalledWith({ id: 'supplier-1', is_active: !isActive }))
  expect(manageSupplier).toHaveBeenLastCalledWith('supplier-1', action)
})

it('requires confirmation to delete and reports a history guard failure', async () => {
  manageSupplier.mockClear()
  confirmAction.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  manageSupplier.mockRejectedValue(new Error('This supplier has purchase history. Suspend the supplier instead.'))
  const deleted = vi.fn()
  render(<SupplierEditor supplier={{ id: 'supplier-1', name: 'Supplier' }} onSaved={() => {}} onDeleted={deleted} onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Delete supplier' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Delete supplier' })).toBeEnabled())
  expect(manageSupplier).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Delete supplier' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('purchase history')
  expect(deleted).not.toHaveBeenCalled()
})
