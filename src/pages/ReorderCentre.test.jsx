import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ReorderCentre from './ReorderCentre'

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  notify: vi.fn(),
  navigate: vi.fn(),
  getAllDrugs: vi.fn(),
  getOpenOrderQuantitiesByDrug: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('../context/AuthContext', () => ({ useAuth: mocks.useAuth }))
vi.mock('../context/NotificationContext', () => ({ useNotification: () => ({ notify: mocks.notify }) }))
vi.mock('../services/drugService', () => ({
  getAllDrugs: mocks.getAllDrugs,
  isDefaultCatalogDrug: () => false,
}))
vi.mock('../services/purchasesApi', () => ({ getOpenOrderQuantitiesByDrug: mocks.getOpenOrderQuantitiesByDrug }))

const outOfStock = {
  id: 'd-out', name: 'Paracetamol 500mg', quantity: 0, reorder_level: 20, target_stock_level: 100,
  cost_price: 1.2, unit: 'tablet', supplier: 'MedSupply Ltd', category: 'medicine', status: 'active',
}
const critical = {
  id: 'd-critical', name: 'Amoxicillin 500mg', quantity: 4, reorder_level: 20, target_stock_level: 60,
  cost_price: 3.5, unit: 'capsule', supplier: 'Accord Pharma', category: 'medicine', status: 'active',
}
const lowNoSupplier = {
  id: 'd-low', name: 'Ibuprofen 200mg', quantity: 15, reorder_level: 20, cost_price: 0.8,
  unit: 'tablet', supplier: '', category: 'medicine', status: 'active',
}
const wellStocked = {
  id: 'd-ok', name: 'Vitamin C 500mg', quantity: 200, reorder_level: 20, cost_price: 0.5,
  unit: 'tablet', supplier: 'MedSupply Ltd', category: 'supplement', status: 'active',
}

describe('ReorderCentre', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useAuth.mockReturnValue({ canManagePurchases: true })
    mocks.getAllDrugs.mockResolvedValue([outOfStock, critical, lowNoSupplier, wellStocked])
    mocks.getOpenOrderQuantitiesByDrug.mockResolvedValue(new Map())
  })

  it('lists only medicines that need attention, with severity counts, excluding well-stocked ones', async () => {
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())

    expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument()
    expect(screen.getByText('Ibuprofen 200mg')).toBeInTheDocument()
    expect(screen.queryByText('Vitamin C 500mg')).not.toBeInTheDocument()

    // one out-of-stock, one critical (4 <= 25% of 20), one low (15 <= 20)
    const summary = screen.getByText('Out of stock', { selector: '.reorder-summary-label' }).closest('.reorder-summary-card')
    expect(summary.querySelector('.reorder-summary-value')).toHaveTextContent('1')
  })

  it('filters by severity tab', async () => {
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Critical' }))

    expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument()
    expect(screen.queryByText('Paracetamol 500mg')).not.toBeInTheDocument()
    expect(screen.queryByText('Ibuprofen 200mg')).not.toBeInTheDocument()
  })

  it('groups medicines by supplier and creates a purchase order for one supplier at a time', async () => {
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())

    const medSupplyGroup = screen.getByText('MedSupply Ltd', { selector: 'strong' }).closest('.reorder-supplier-group')
    expect(medSupplyGroup).toBeTruthy()
    fireEvent.click(medSupplyGroup.querySelector('button'))

    expect(mocks.navigate).toHaveBeenCalledWith('/purchases', {
      state: {
        reorderItems: [
          expect.objectContaining({ drugId: 'd-out', supplier: 'MedSupply Ltd', suggestedQuantity: 100 }),
        ],
      },
    })
  })

  it('requires a supplier to be assigned before a no-supplier group can be ordered', async () => {
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Ibuprofen 200mg')).toBeInTheDocument())

    const requiredGroup = screen.getByText('Supplier required', { selector: 'strong' }).closest('.reorder-supplier-group')
    const orderButton = requiredGroup.querySelector('button')
    expect(orderButton).toBeDisabled()

    // Suppliers are assigned in the table row, then the medicine moves to that supplier's group.
    const row = screen.getByText('Ibuprofen 200mg').closest('tr')
    fireEvent.change(row.querySelector('.reorder-supplier-input'), { target: { value: 'New Supplier Co' } })

    await waitFor(() => {
      const updatedGroup = screen.getByText('New Supplier Co', { selector: 'strong' }).closest('.reorder-supplier-group')
      expect(updatedGroup.querySelector('button')).not.toBeDisabled()
    })
    expect(screen.queryByText('Supplier required', { selector: 'strong' })).not.toBeInTheDocument()
  })

  it('subtracts quantity already on order from the suggested quantity shown', async () => {
    mocks.getOpenOrderQuantitiesByDrug.mockResolvedValue(new Map([['d-out', { quantity: 60 }]]))
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())

    const row = screen.getByText('Paracetamol 500mg').closest('tr')
    expect(row).toHaveTextContent('60') // already on order
    expect(row).toHaveTextContent('40') // 100 target - 0 current - 60 on order
  })

  it('shows nothing needs restocking when every medicine is well stocked', async () => {
    mocks.getAllDrugs.mockResolvedValue([wellStocked])
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Nothing needs restocking right now.')).toBeInTheDocument())
  })

  it('denies access to a user who cannot manage purchases', async () => {
    mocks.useAuth.mockReturnValue({ canManagePurchases: false })
    render(<ReorderCentre />)
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument()
    expect(mocks.getAllDrugs).not.toHaveBeenCalled()
  })
})
