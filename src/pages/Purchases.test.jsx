import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Purchases from './Purchases'

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  notify: vi.fn(),
  navigate: vi.fn(),
  locationState: null,
  isSupabaseConfigured: vi.fn(),
  listPurchases: vi.fn(),
  listSuppliers: vi.fn(),
  getPurchaseStats: vi.fn(),
  getOfflinePurchasesSummary: vi.fn(),
  subscribeOfflinePurchasesQueue: vi.fn(),
  syncOfflinePurchases: vi.fn(),
  getAllDrugs: vi.fn(),
  getBranches: vi.fn(),
  placePurchaseOrder: vi.fn(),
  receivePurchaseOrderGoods: vi.fn(),
  cancelPurchaseDraft: vi.fn(),
  completePurchaseDraft: vi.fn(),
  listPurchaseReceipts: vi.fn(),
  getPurchaseCreatorName: vi.fn(),
  confirmAction: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/purchases', state: mocks.locationState }),
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}))

vi.mock('../context/AuthContext', () => ({ useAuth: mocks.useAuth }))
vi.mock('../context/NotificationContext', () => ({ useNotification: () => ({ notify: mocks.notify }) }))
vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: mocks.isSupabaseConfigured }))
vi.mock('../services/branchService', () => ({ getBranches: mocks.getBranches }))
vi.mock('../services/drugService', () => ({ getAllDrugs: mocks.getAllDrugs }))
vi.mock('../utils/actionConfirmation', () => ({ confirmAction: mocks.confirmAction }))
vi.mock('../services/purchasesApi', () => ({
  cancelPurchaseDraft: mocks.cancelPurchaseDraft,
  completePurchaseDraft: mocks.completePurchaseDraft,
  placePurchaseOrder: mocks.placePurchaseOrder,
  receivePurchaseOrderGoods: mocks.receivePurchaseOrderGoods,
  listPurchaseReceipts: mocks.listPurchaseReceipts,
  getPurchaseCreatorName: mocks.getPurchaseCreatorName,
  createPurchaseDraft: vi.fn(),
  createPurchaseSupplier: vi.fn(),
  getOfflinePurchasesSummary: mocks.getOfflinePurchasesSummary,
  getPurchaseCompletionAudit: vi.fn(),
  getPurchaseStats: mocks.getPurchaseStats,
  listPurchases: mocks.listPurchases,
  listSuppliers: mocks.listSuppliers,
  subscribeOfflinePurchasesQueue: mocks.subscribeOfflinePurchasesQueue,
  syncOfflinePurchases: mocks.syncOfflinePurchases,
}))

describe('Purchases — arriving from Inventory Reorder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.locationState = null
    mocks.useAuth.mockReturnValue({
      profile: { organization_id: 'org-1' },
      branch: null,
      organization: { id: 'org-1' },
      user: { id: 'user-1' },
      canManagePurchases: true,
      canApprovePurchases: true,
    })
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.listPurchases.mockResolvedValue([])
    mocks.listSuppliers.mockResolvedValue([{ id: 'sup-1', name: 'MedSupply Ltd' }])
    mocks.getPurchaseStats.mockResolvedValue({ totalThisMonth: 0, totalAllTime: 0, draftCount: 0, completedCount: 0 })
    mocks.getOfflinePurchasesSummary.mockResolvedValue({ pending: 0, syncing: 0, failed: 0, synced: 0, unsynced: 0, total: 0 })
    mocks.subscribeOfflinePurchasesQueue.mockReturnValue(() => {})
    mocks.getAllDrugs.mockResolvedValue([])
    mocks.getBranches.mockResolvedValue([])
    mocks.listPurchaseReceipts.mockResolvedValue([])
    mocks.getPurchaseCreatorName.mockResolvedValue('Ama Boateng')
    mocks.confirmAction.mockResolvedValue(true)
  })

  it('opens the New Purchase modal pre-filled with the reordered item and matches the supplier by name', async () => {
    mocks.locationState = {
      reorderItems: [
        {
          drugId: 'low-1',
          drugName: 'Amoxicillin 500mg',
          brandName: '',
          genericName: '',
          unit: 'capsule',
          unitCost: 3.5,
          saleOnReturn: false,
          supplier: 'MedSupply Ltd',
          suggestedQuantity: 8,
        },
      ],
    }

    render(<Purchases />)

    await waitFor(() => expect(screen.getByRole('heading', { name: /new purchase order/i })).toBeInTheDocument())
    expect(screen.getByText('Amoxicillin 500mg')).toBeInTheDocument()
    expect(screen.getByText('8')).toBeInTheDocument()
    expect(screen.getByDisplayValue('MedSupply Ltd')).toBeInTheDocument()
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('1 item added from Low Stock'), 'info')
    expect(mocks.navigate).toHaveBeenCalledWith('/purchases', { replace: true, state: null })
  })

  it('does nothing when there is no reorder state', async () => {
    render(<Purchases />)

    await waitFor(() => expect(screen.getByRole('heading', { name: /purchase/i })).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: /new purchase order/i })).not.toBeInTheDocument()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('keeps a suggested quantity of 0 as 0 instead of defaulting it up to 1', async () => {
    mocks.locationState = {
      reorderItems: [
        {
          drugId: 'low-1',
          drugName: 'Amoxicillin 500mg',
          unit: 'capsule',
          unitCost: 3.5,
          supplier: 'MedSupply Ltd',
          suggestedQuantity: 0,
        },
      ],
    }

    render(<Purchases />)

    await waitFor(() => expect(screen.getByRole('heading', { name: /new purchase order/i })).toBeInTheDocument())
    const row = screen.getByText('Amoxicillin 500mg').closest('tr')
    expect(within(row).getByText('0')).toBeInTheDocument()
  })
})

const order = (overrides = {}) => ({
  id: 'po-1',
  purchase_number: 'PO-000001',
  status: 'draft',
  supplier_id: 'sup-1',
  supplier_name: 'MedSupply Ltd',
  purchase_date: '2026-09-21',
  total_amount: 250,
  purchase_items: [
    { id: 'i1', drug_id: 'd1', drug_name: 'Amoxicillin 500mg', quantity: 100, received_quantity: 60, unit: 'capsule', unit_cost: 2.5 },
  ],
  ...overrides,
})

describe('Purchases lifecycle actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.locationState = null
    mocks.useAuth.mockReturnValue({
      profile: { organization_id: 'org-1' },
      branch: null,
      organization: { id: 'org-1', name: 'Health Light Pharmacy' },
      user: { id: 'user-1' },
      canManagePurchases: true,
      canApprovePurchases: true,
    })
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.listSuppliers.mockResolvedValue([{ id: 'sup-1', name: 'MedSupply Ltd' }])
    mocks.getPurchaseStats.mockResolvedValue({ totalThisMonth: 0, totalAllTime: 0, draftCount: 1, orderedCount: 2, completedCount: 0 })
    mocks.getOfflinePurchasesSummary.mockResolvedValue({ pending: 0, syncing: 0, failed: 0, synced: 0, unsynced: 0, total: 0 })
    mocks.subscribeOfflinePurchasesQueue.mockReturnValue(() => {})
    mocks.getAllDrugs.mockResolvedValue([])
    mocks.getBranches.mockResolvedValue([])
    mocks.listPurchaseReceipts.mockResolvedValue([])
    mocks.getPurchaseCreatorName.mockResolvedValue('Ama Boateng')
    mocks.confirmAction.mockResolvedValue(true)
  })

  const rowFor = async (number) => {
    await waitFor(() => expect(screen.getByText(number)).toBeInTheDocument())
    return screen.getByText(number).closest('tr')
  }

  it('shows the lifecycle statuses with readable labels and an Open Orders count', async () => {
    mocks.listPurchases.mockResolvedValue([
      order({ id: 'a', purchase_number: 'PO-A', status: 'ordered' }),
      order({ id: 'b', purchase_number: 'PO-B', status: 'partially_received' }),
      order({ id: 'c', purchase_number: 'PO-C', status: 'completed' }),
    ])
    render(<Purchases />)
    const rowA = await rowFor('PO-A')
    expect(within(rowA).getByText('Ordered')).toBeInTheDocument()
    expect(within(await rowFor('PO-B')).getByText('Partially received')).toBeInTheDocument()
    expect(within(await rowFor('PO-C')).getByText('Received')).toBeInTheDocument()
    expect(screen.getByText('Open Orders').nextSibling).toHaveTextContent('2')
  })

  it('offers Place order on a draft, and placing it calls the service without touching stock', async () => {
    mocks.listPurchases.mockResolvedValue([order()])
    mocks.placePurchaseOrder.mockResolvedValue({ status: 'ordered' })
    render(<Purchases />)
    const row = await rowFor('PO-000001')
    expect(within(row).queryByTitle(/Receive goods/)).not.toBeInTheDocument()
    fireEvent.click(within(row).getByTitle('Place order with supplier'))
    await waitFor(() => expect(mocks.placePurchaseOrder).toHaveBeenCalledWith('po-1'))
    expect(mocks.completePurchaseDraft).not.toHaveBeenCalled()
  })

  it('offers Receive goods (not Complete or Place) on a placed order', async () => {
    mocks.listPurchases.mockResolvedValue([order({ status: 'ordered' })])
    render(<Purchases />)
    const row = await rowFor('PO-000001')
    expect(within(row).getByTitle(/Receive goods/)).toBeInTheDocument()
    expect(within(row).queryByTitle('Place order with supplier')).not.toBeInTheDocument()
    expect(within(row).queryByTitle(/Complete/)).not.toBeInTheDocument()
  })

  it('hides Receive goods from someone who cannot approve purchases', async () => {
    mocks.useAuth.mockReturnValue({
      profile: { organization_id: 'org-1' }, branch: null, organization: { id: 'org-1' }, user: { id: 'u' },
      canManagePurchases: true, canApprovePurchases: false,
    })
    mocks.listPurchases.mockResolvedValue([order({ status: 'ordered' })])
    render(<Purchases />)
    const row = await rowFor('PO-000001')
    expect(within(row).queryByTitle(/Receive goods/)).not.toBeInTheDocument()
    expect(within(row).getByTitle('Cancel order')).toBeInTheDocument()
  })

  it('receives part of an order: opens the form, submits, and reports what is still outstanding', async () => {
    mocks.listPurchases.mockResolvedValue([order({ status: 'partially_received' })])
    mocks.receivePurchaseOrderGoods.mockResolvedValue({ status: 'partially_received', outstanding: 15 })
    render(<Purchases />)
    fireEvent.click(within(await rowFor('PO-000001')).getByTitle(/Receive goods/))
    const form = await screen.findByRole('form', { name: 'Receive goods' })
    fireEvent.change(within(form).getByLabelText('Quantity received'), { target: { value: '25' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Receive stock' }))
    await waitFor(() => expect(mocks.receivePurchaseOrderGoods).toHaveBeenCalledTimes(1))
    const [id, lines, options] = mocks.receivePurchaseOrderGoods.mock.calls[0]
    expect(id).toBe('po-1')
    expect(lines).toEqual([expect.objectContaining({ purchaseItemId: 'i1', quantity: 25 })])
    expect(options.receiptKey).toBeTruthy()
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('15 still outstanding'), 'success'))
  })

  it('cancelling a placed order needs a reason and sends it with the request', async () => {
    mocks.listPurchases.mockResolvedValue([order({ status: 'ordered' })])
    mocks.cancelPurchaseDraft.mockResolvedValue({ status: 'cancelled' })
    render(<Purchases />)
    fireEvent.click(within(await rowFor('PO-000001')).getByTitle('Cancel order'))
    const dialog = await screen.findByRole('form', { name: 'Cancel order' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }))
    expect(mocks.cancelPurchaseDraft).not.toHaveBeenCalled()
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Supplier out of stock' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }))
    await waitFor(() => expect(mocks.cancelPurchaseDraft).toHaveBeenCalledWith('po-1', { reason: 'Supplier out of stock' }))
  })

  it('prints a purchase order preview with the facility, supplier and creator', async () => {
    mocks.listPurchases.mockResolvedValue([order({ status: 'ordered', created_by: 'user-9', purchase_items: [{ id: 'i1', drug_name: 'Amoxicillin 500mg', quantity: 100, received_quantity: 0, unit: 'capsule', unit_cost: 2.5 }] })])
    render(<Purchases />)
    fireEvent.click(within(await rowFor('PO-000001')).getByTitle('Print purchase order'))
    const preview = await screen.findByLabelText('Purchase order preview')
    expect(within(preview).getAllByText('Health Light Pharmacy').length).toBeGreaterThan(0)
    await waitFor(() => expect(preview).toHaveTextContent('Ama Boateng'))
    expect(mocks.getPurchaseCreatorName).toHaveBeenCalledWith('user-9')
    expect(preview).toHaveTextContent('Amoxicillin 500mg')
  })

  it('does not offer to print a cancelled order', async () => {
    mocks.listPurchases.mockResolvedValue([order({ status: 'cancelled' })])
    render(<Purchases />)
    const row = await rowFor('PO-000001')
    expect(within(row).queryByTitle('Print purchase order')).not.toBeInTheDocument()
  })
})
