import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Inventory from './Inventory'

const mocks = vi.hoisted(() => ({
  addDrug: vi.fn(),
  calculateDrugStatus: vi.fn(),
  deleteDrug: vi.fn(),
  dispatchHealthflowDataChanged: vi.fn(),
  generateTemplate: vi.fn(),
  getAllDrugs: vi.fn(),
  getPharmacySettings: vi.fn(),
  importDrugs: vi.fn(),
  isDefaultCatalogDrug: vi.fn(),
  isSupabaseConfigured: vi.fn(),
  notify: vi.fn(),
  parseExcelFile: vi.fn(),
  setSearchParams: vi.fn(),
  updateDrug: vi.fn(),
  useAuth: vi.fn(),
  useTenant: vi.fn(),
  validateImportData: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(), mocks.setSearchParams],
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: mocks.useAuth,
}))

vi.mock('../context/NotificationContext', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

vi.mock('../context/TenantContext', () => ({
  useTenant: mocks.useTenant,
}))

vi.mock('../lib/appEvents', () => ({
  dispatchHealthflowDataChanged: mocks.dispatchHealthflowDataChanged,
}))

vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: mocks.isSupabaseConfigured,
}))

vi.mock('../services/drugImportService', () => ({
  generateTemplate: mocks.generateTemplate,
  importDrugs: mocks.importDrugs,
  parseExcelFile: mocks.parseExcelFile,
  validateImportData: mocks.validateImportData,
}))

vi.mock('../services/drugService', () => ({
  addDrug: mocks.addDrug,
  calculateDrugStatus: mocks.calculateDrugStatus,
  deleteDrug: mocks.deleteDrug,
  getAllDrugs: mocks.getAllDrugs,
  isDefaultCatalogDrug: mocks.isDefaultCatalogDrug,
  updateDrug: mocks.updateDrug,
}))

vi.mock('../services/settingsService', () => ({
  getPharmacySettings: mocks.getPharmacySettings,
}))

const getFieldAfterLabel = (labelText) => {
  const label = screen.getByText(labelText)
  return label.parentElement.querySelector('input')
}

describe('Inventory', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mocks.useAuth.mockReturnValue({ role: 'admin' })
    mocks.useTenant.mockReturnValue({ tierLimits: { hasAdvancedInventory: true } })
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.getAllDrugs.mockResolvedValue([])
    mocks.getPharmacySettings.mockResolvedValue({ default_markup_percent: 25 })
    mocks.calculateDrugStatus.mockReturnValue({ class: 'good', label: 'Good Stock' })
    mocks.isDefaultCatalogDrug.mockReturnValue(false)
  })

  it('auto-calculates selling price from cost price until the price is edited manually', async () => {
    render(<Inventory />)

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /inventory management/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /add drug/i }))

    const costPriceInput = getFieldAfterLabel('Cost Price (GHS)')
    const sellingPriceInput = getFieldAfterLabel('Selling Price (GHS) *')

    fireEvent.change(costPriceInput, { target: { value: '10' } })

    expect(sellingPriceInput).toHaveValue(12.5)

    fireEvent.change(sellingPriceInput, { target: { value: '13.75' } })
    fireEvent.change(costPriceInput, { target: { value: '20' } })

    expect(sellingPriceInput).toHaveValue(13.75)
  })

  it('only shows NHIS prices for medicines matched to the NHIS catalog', async () => {
    mocks.useTenant.mockReturnValue({
      canUseNhisTopups: true,
      tierLimits: { hasAdvancedInventory: true },
    })
    mocks.getAllDrugs.mockResolvedValue([
      {
        id: 'nhis-listed',
        name: 'Aciclovir Cream, 5%',
        batch_number: 'PDF-IMP-00848',
        expiry_date: '2028-12-31',
        quantity: 0,
        price: 133,
        cost_price: 106.4,
        nhis_code: 'ACICLOCR1',
        nhis_price: 38.5,
        is_nhis_listed: true,
        status: 'active',
      },
      {
        id: 'not-listed',
        name: 'Actifed Multi-Action Cough Syrup',
        batch_number: 'PDF-IMP-00001',
        expiry_date: '2028-12-31',
        quantity: 0,
        price: 43,
        cost_price: 34.4,
        nhis_code: null,
        nhis_price: 0,
        is_nhis_listed: false,
        status: 'active',
      },
    ])

    render(<Inventory />)

    await waitFor(() => {
      expect(screen.getByText('Aciclovir Cream, 5%')).toBeInTheDocument()
    })

    expect(screen.getByText('GHS 38.50')).toBeInTheDocument()
    expect(screen.getAllByText('-').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTitle('Edit Aciclovir Cream, 5%'))
    expect(getFieldAfterLabel('NHIS Code')).toHaveValue('ACICLOCR1')
    expect(getFieldAfterLabel('NHIS Price (GHS)')).toHaveValue(38.5)

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    fireEvent.click(screen.getByTitle('Edit Actifed Multi-Action Cough Syrup'))
    expect(getFieldAfterLabel('NHIS Code')).toHaveDisplayValue('')
    expect(getFieldAfterLabel('NHIS Price (GHS)')).toHaveDisplayValue('')
  })
})
