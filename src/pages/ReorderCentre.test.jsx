import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ReorderCentre from './ReorderCentre'

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  notify: vi.fn(),
  navigate: vi.fn(),
  getAllDrugs: vi.fn(),
  getOpenOrderQuantitiesByDrug: vi.fn(),
  loadReorderInsights: vi.fn(),
  loadBranchTransferOptions: vi.fn(),
  getPharmacySettings: vi.fn(),
  getBranches: vi.fn(),
  transferInventoryDrug: vi.fn(),
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
vi.mock('../services/purchasesApi', () => ({
  getOpenOrderQuantitiesByDrug: mocks.getOpenOrderQuantitiesByDrug,
  loadReorderInsights: mocks.loadReorderInsights,
  loadBranchTransferOptions: mocks.loadBranchTransferOptions,
}))
vi.mock('../services/branchService', () => ({ getBranches: mocks.getBranches }))
vi.mock('../services/inventoryApi', () => ({ transferInventoryDrug: mocks.transferInventoryDrug }))
vi.mock('../services/settingsService', () => ({ getPharmacySettings: mocks.getPharmacySettings }))

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
    mocks.loadReorderInsights.mockResolvedValue(new Map())
    mocks.getPharmacySettings.mockResolvedValue({ expiry_alert_days: 30 })
    mocks.getBranches.mockResolvedValue([])
    mocks.loadBranchTransferOptions.mockResolvedValue(new Map())
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

describe('ReorderCentre insights (phase 3)', () => {
  const insight = (overrides = {}) => ({ units_sold: 0, history_days: 90, last_cost: null, previous_cost: null, last_supplier: null, ...overrides })
  const rowOf = (name) => screen.getByText(name).closest('tr')

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useAuth.mockReturnValue({ canManagePurchases: true })
    mocks.getOpenOrderQuantitiesByDrug.mockResolvedValue(new Map())
    mocks.getPharmacySettings.mockResolvedValue({ expiry_alert_days: 30 })
    mocks.getAllDrugs.mockResolvedValue([outOfStock, critical, lowNoSupplier, wellStocked])
    mocks.loadReorderInsights.mockResolvedValue(new Map())
  })

  it('asks for insights only for medicines that need attention', async () => {
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())
    const [ids] = mocks.loadReorderInsights.mock.calls[0]
    expect([...ids].sort()).toEqual(['d-critical', 'd-low', 'd-out'])
  })

  it('shows days of stock and usage from real sales, and says "Not enough data" when history is short', async () => {
    mocks.loadReorderInsights.mockResolvedValue(new Map([
      ['d-critical', insight({ units_sold: 180 })], // 2/day, 4 in stock -> 2 days
      ['d-low', insight({ units_sold: 3, history_days: 5 })], // too little history
    ]))
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument())
    expect(rowOf('Amoxicillin 500mg')).toHaveTextContent('2 days')
    expect(rowOf('Amoxicillin 500mg')).toHaveTextContent('2/day')
    expect(rowOf('Ibuprofen 200mg')).toHaveTextContent('Not enough data')
  })

  it('shows last vs previous cost and flags an unusually large change', async () => {
    mocks.loadReorderInsights.mockResolvedValue(new Map([
      ['d-critical', insight({ last_cost: 42, previous_cost: 39.5 })],
      ['d-out', insight({ last_cost: 60, previous_cost: 40 })],
    ]))
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument())
    expect(rowOf('Amoxicillin 500mg')).toHaveTextContent('Last GHS 42.00 · Previous GHS 39.50 · +6.3%')
    expect(rowOf('Amoxicillin 500mg').querySelector('.reorder-price-flagged')).toBeNull()
    expect(rowOf('Paracetamol 500mg').querySelector('.reorder-price-flagged')).not.toBeNull()
  })

  it('warns about stock close to expiry using the configured window', async () => {
    const soon = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10)
    mocks.getAllDrugs.mockResolvedValue([{ ...critical, expiry_date: soon }])
    mocks.getPharmacySettings.mockResolvedValue({ expiry_alert_days: 60 })
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument())
    expect(rowOf('Amoxicillin 500mg')).toHaveTextContent(/4 units expire within 4\d days/)
  })

  it('does not warn when expiry is outside the window', async () => {
    const later = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10)
    mocks.getAllDrugs.mockResolvedValue([{ ...critical, expiry_date: later }])
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument())
    expect(rowOf('Amoxicillin 500mg')).not.toHaveTextContent('expire')
  })

  it('ranks by priority: out of stock, then critical and fast moving, then the rest', async () => {
    mocks.loadReorderInsights.mockResolvedValue(new Map([
      ['d-critical', insight({ units_sold: 180 })], // fast: 2 days left -> priority 2
      ['d-low', insight({ units_sold: 9 })], // slow -> priority 4
    ]))
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())
    const order = [...document.querySelectorAll('.reorder-centre-table tbody .reorder-drug-name')].map((el) => el.textContent)
    expect(order).toEqual(['Paracetamol 500mg', 'Amoxicillin 500mg', 'Ibuprofen 200mg'])
    expect(rowOf('Paracetamol 500mg')).toHaveTextContent('Priority 1')
    expect(rowOf('Amoxicillin 500mg')).toHaveTextContent('Priority 2')
    expect(rowOf('Ibuprofen 200mg')).toHaveTextContent('Priority 4')
    expect(rowOf('Amoxicillin 500mg').querySelector('.reorder-priority')).toHaveAttribute('title', 'Critically low · Fast moving')
  })

  it('sorts by fastest moving, with unknown speed last', async () => {
    mocks.loadReorderInsights.mockResolvedValue(new Map([
      ['d-out', insight({ units_sold: 90 })], // 1/day
      ['d-critical', insight({ units_sold: 450 })], // 5/day
    ]))
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())
    fireEvent.change(screen.getByDisplayValue('Sort: Most urgent'), { target: { value: 'fastest_moving' } })
    const order = [...document.querySelectorAll('.reorder-centre-table tbody .reorder-drug-name')].map((el) => el.textContent)
    expect(order).toEqual(['Amoxicillin 500mg', 'Paracetamol 500mg', 'Ibuprofen 200mg'])
  })

  it('falls back to the supplier it was last bought from, and says so', async () => {
    mocks.loadReorderInsights.mockResolvedValue(new Map([['d-low', insight({ last_supplier: 'Accord Pharma' })]]))
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Ibuprofen 200mg')).toBeInTheDocument())
    expect(rowOf('Ibuprofen 200mg').querySelector('.reorder-supplier-input')).toHaveValue('Accord Pharma')
    expect(rowOf('Ibuprofen 200mg')).toHaveTextContent('From last purchase')
    expect(screen.queryByText('Supplier required', { selector: 'strong' })).not.toBeInTheDocument()
  })

  it('carries price context into the purchase it creates', async () => {
    mocks.loadReorderInsights.mockResolvedValue(new Map([['d-out', insight({ last_cost: 60, previous_cost: 40 })]]))
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())
    const group = screen.getByText('MedSupply Ltd', { selector: 'strong' }).closest('.reorder-supplier-group')
    fireEvent.click(group.querySelector('button'))
    expect(mocks.navigate).toHaveBeenCalledWith('/purchases', {
      state: { reorderItems: [expect.objectContaining({ drugId: 'd-out', priceFlagged: true, priceNote: expect.stringContaining('+50%') })] },
    })
  })

  it('still works, and says so, when sales speed and prices cannot be loaded', async () => {
    mocks.loadReorderInsights.mockRejectedValue(new Error('rpc missing'))
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())
    expect(screen.getByRole('status')).toHaveTextContent('could not be loaded')
    expect(rowOf('Paracetamol 500mg')).not.toHaveTextContent('Not enough data')
    expect(rowOf('Paracetamol 500mg')).toHaveTextContent('Out of stock')
  })
})

describe('ReorderCentre branches and transfer advice (phase 4)', () => {
  const branches = [
    { id: 'br-main', name: 'Accra Main', is_main: true, is_active: true },
    { id: 'br-b', name: 'Kumasi', is_active: true },
    { id: 'br-closed', name: 'Closed', is_active: false },
  ]
  const kumasiSpare = {
    target_drug_id: 'd-critical', source_drug_id: 'src-1', source_branch_id: 'br-b', source_branch_name: 'Kumasi',
    batch_number: 'B9', expiry_date: '2029-01-01', source_quantity: 90, source_reorder_level: 20, spare_quantity: 70,
  }
  const rowOf = (name) => screen.getByText(name).closest('tr')

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useAuth.mockReturnValue({ canManagePurchases: true, canAdjustStock: true, profile: {} })
    mocks.getOpenOrderQuantitiesByDrug.mockResolvedValue(new Map())
    mocks.loadReorderInsights.mockResolvedValue(new Map())
    mocks.getPharmacySettings.mockResolvedValue({ expiry_alert_days: 30 })
    mocks.getAllDrugs.mockResolvedValue([outOfStock, critical, lowNoSupplier, wellStocked])
    mocks.getBranches.mockResolvedValue(branches)
    mocks.loadBranchTransferOptions.mockResolvedValue(new Map([['d-critical', [kumasiSpare]]]))
  })

  it('loads the main branch by default and offers only active branches', async () => {
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())
    expect(mocks.getAllDrugs).toHaveBeenCalledWith({ useTierAccess: true, branchId: 'br-main' })
    const select = screen.getByLabelText('Branch')
    expect(select).toHaveValue('br-main')
    expect([...select.options].map((o) => o.textContent)).toEqual(['Accra Main', 'Kumasi'])
  })

  it('reloads for the chosen branch', async () => {
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'br-b' } })
    await waitFor(() => expect(mocks.getAllDrugs).toHaveBeenLastCalledWith({ useTierAccess: true, branchId: 'br-b' }))
  })

  it('fixes a branch-bound user to their own branch and gives them no transfer advice', async () => {
    mocks.useAuth.mockReturnValue({ canManagePurchases: true, canAdjustStock: true, profile: { branch_id: 'br-b' } })
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())
    expect(mocks.getAllDrugs).toHaveBeenCalledWith({ useTierAccess: true, branchId: 'br-b' })
    expect(screen.getByLabelText('Branch')).toBeDisabled()
    expect(mocks.loadBranchTransferOptions).not.toHaveBeenCalled()
  })

  it('behaves exactly as before for a single-branch pharmacy: no selector, no branch filter, no advice', async () => {
    mocks.getBranches.mockResolvedValue([])
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())
    expect(screen.queryByLabelText('Branch')).not.toBeInTheDocument()
    expect(mocks.getAllDrugs).toHaveBeenCalledWith({ useTierAccess: true, branchId: undefined })
    expect(mocks.loadBranchTransferOptions).not.toHaveBeenCalled()
  })

  it('asks for transfer options only for the medicines that need attention, in the chosen branch', async () => {
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument())
    const [branchId, ids] = mocks.loadBranchTransferOptions.mock.calls[0]
    expect(branchId).toBe('br-main')
    expect([...ids].sort()).toEqual(['d-critical', 'd-low', 'd-out'])
  })

  it('shows which branch has spare stock next to the suggestion', async () => {
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument())
    expect(rowOf('Amoxicillin 500mg')).toHaveTextContent('Kumasi has 70 spare — transfer instead')
    expect(rowOf('Paracetamol 500mg')).not.toHaveTextContent('spare')
  })

  it('never transfers on its own: just showing the advice moves no stock', async () => {
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument())
    expect(mocks.transferInventoryDrug).not.toHaveBeenCalled()
  })

  it('transfers only after the user confirms, from the chosen source into the selected branch', async () => {
    mocks.transferInventoryDrug.mockResolvedValue({ success: true })
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument())
    fireEvent.click(within(rowOf('Amoxicillin 500mg')).getByRole('button', { name: /transfer instead/ }))
    const dialog = await screen.findByRole('form', { name: 'Transfer stock instead of buying' })
    expect(within(dialog).getByLabelText('Quantity to transfer')).toHaveValue(56) // 60 target - 4 stock
    expect(mocks.transferInventoryDrug).not.toHaveBeenCalled()
    fireEvent.change(within(dialog).getByLabelText('Quantity to transfer'), { target: { value: '30' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer stock' }))
    await waitFor(() => expect(mocks.transferInventoryDrug).toHaveBeenCalledTimes(1))
    expect(mocks.transferInventoryDrug).toHaveBeenCalledWith(expect.objectContaining({
      drugId: 'src-1', destinationBranchId: 'br-main', quantity: 30,
    }))
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith('Transferred 30 Amoxicillin 500mg from Kumasi.', 'success'))
    expect(mocks.getAllDrugs.mock.calls.length).toBeGreaterThan(1) // reloads so the suggestion shrinks
  })

  it('refuses to transfer more than the source can spare', async () => {
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument())
    fireEvent.click(within(rowOf('Amoxicillin 500mg')).getByRole('button', { name: /transfer instead/ }))
    const dialog = await screen.findByRole('form', { name: 'Transfer stock instead of buying' })
    fireEvent.change(within(dialog).getByLabelText('Quantity to transfer'), { target: { value: '71' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer stock' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('only has 70 spare')
    expect(mocks.transferInventoryDrug).not.toHaveBeenCalled()
  })

  it('only offers the transfer action to someone allowed to move stock; others just see the advice', async () => {
    mocks.useAuth.mockReturnValue({ canManagePurchases: true, canAdjustStock: false, profile: {} })
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument())
    expect(rowOf('Amoxicillin 500mg')).toHaveTextContent('Kumasi has 70 spare')
    expect(within(rowOf('Amoxicillin 500mg')).queryByRole('button', { name: /transfer instead/ })).not.toBeInTheDocument()
  })

  it('reports a failed transfer without reloading or losing the page', async () => {
    mocks.transferInventoryDrug.mockRejectedValue(new Error('Insufficient stock for this transfer.'))
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument())
    fireEvent.click(within(rowOf('Amoxicillin 500mg')).getByRole('button', { name: /transfer instead/ }))
    const dialog = await screen.findByRole('form', { name: 'Transfer stock instead of buying' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer stock' }))
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith('Insufficient stock for this transfer.', 'error'))
    expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument()
  })

  it('still works when transfer options cannot be loaded', async () => {
    mocks.loadBranchTransferOptions.mockRejectedValue(new Error('function missing'))
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument())
    expect(rowOf('Amoxicillin 500mg')).not.toHaveTextContent('spare')
  })

  it('does not hide the purchase path: the supplier groups and order buttons are still there', async () => {
    render(<ReorderCentre />)
    await waitFor(() => expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: /Create Purchase Order/ }).length).toBeGreaterThan(0)
  })
})
