import { render, screen, waitFor, within } from '@testing-library/react'
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
vi.mock('../services/purchasesApi', () => ({
  cancelPurchaseDraft: vi.fn(),
  completePurchaseDraft: vi.fn(),
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
