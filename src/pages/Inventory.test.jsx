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
  getBranches: vi.fn(),
  notify: vi.fn(),
  parseExcelFile: vi.fn(),
  provisionDefaultMedicationCatalog: vi.fn(),
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

vi.mock('../services/branchService', () => ({
  getBranches: mocks.getBranches,
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
  provisionDefaultMedicationCatalog: mocks.provisionDefaultMedicationCatalog,
  updateDrug: mocks.updateDrug,
}))

vi.mock('../services/settingsService', () => ({
  getPharmacySettings: mocks.getPharmacySettings,
}))

const getFieldAfterLabel = (labelText) => {
  const label = screen.getByText(labelText)
  return label.parentElement.querySelector('input, select')
}

describe('Inventory', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mocks.useAuth.mockReturnValue({ role: 'admin', canAdjustStock: true })
    mocks.getBranches.mockResolvedValue([])
    mocks.useTenant.mockReturnValue({ tierLimits: { hasAdvancedInventory: true } })
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.getAllDrugs.mockResolvedValue([])
    mocks.getPharmacySettings.mockResolvedValue({ default_markup_percent: 25 })
    mocks.provisionDefaultMedicationCatalog.mockResolvedValue({ inserted: 0, reactivated: 0, claimed: 0 })
    mocks.calculateDrugStatus.mockReturnValue({ class: 'good', label: 'Good Stock' })
    mocks.isDefaultCatalogDrug.mockReturnValue(false)
  })

  it('explains the plan restriction when Import Excel is clicked on Basic', async () => {
    mocks.useTenant.mockReturnValue({ tierLimits: { hasAdvancedInventory: false } })
    render(<Inventory />)
    await waitFor(() => expect(mocks.getAllDrugs).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Import Excel' }))
    expect(mocks.notify).toHaveBeenCalledWith(
      'Bulk inventory import is available on Professional or Enterprise plans.', 'info'
    )
    expect(mocks.parseExcelFile).not.toHaveBeenCalled()
  })

  it('opens the Excel file picker on an eligible plan', async () => {
    render(<Inventory />)
    await waitFor(() => expect(mocks.getAllDrugs).toHaveBeenCalled())
    const input = screen.getByLabelText('Import Excel file')
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Import Excel' }))
    expect(input).not.toBeDisabled()
    expect(click).toHaveBeenCalledOnce()
    click.mockRestore()
  })

  it('keeps server failure reasons visible and retries only failed rows', async () => {
    const good = { name: 'Good drug', quantity: 1, price: 2, expiry_date: '2028-01-01' }
    const bad = { ...good, name: 'Failed drug' }
    mocks.parseExcelFile.mockResolvedValue([good, bad])
    mocks.validateImportData.mockReturnValue({ validRows: [good, bad], validCount: 2, invalidRows: [], invalidCount: 0, totalRows: 2 })
    mocks.importDrugs.mockResolvedValueOnce({ successful: [good], created: [good], failed: [{ drug: bad, error: 'Stock quantity exceeds the supported range.' }] })
    mocks.importDrugs.mockResolvedValueOnce({ successful: [bad], created: [bad], failed: [] })
    render(<Inventory />)
    await waitFor(() => expect(mocks.getAllDrugs).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('Import Excel file'), { target: { files: [new File(['test'], 'stock.xlsx')] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 Drug(s)' }))
    await screen.findByText('Stock quantity exceeds the supported range.')
    expect(screen.getByText('Import Drugs from Excel')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 Drug(s)' }))
    await waitFor(() => expect(mocks.importDrugs).toHaveBeenNthCalledWith(2, [bad]))
    await waitFor(() => expect(screen.queryByText('Import Drugs from Excel')).not.toBeInTheDocument())
  })

  it('loads both regular and NHIS reference medicines without triggering catalogue maintenance', async () => {
    render(<Inventory />)

    await waitFor(() => {
      expect(mocks.getAllDrugs).toHaveBeenCalledWith({
        includeCatalog: true,
        branchId: undefined,
      })
    })
  })

  it('filters by item type and makes medicine fields optional for equipment', async () => {
    mocks.getAllDrugs.mockResolvedValue([
      { id: 'med', name: 'Test medicine', quantity: 2, category: 'medicine' },
      { id: 'equip', name: 'Test equipment', quantity: 1, category: 'medical_equipment' },
    ])
    render(<Inventory />)
    await screen.findByText('Test equipment')
    fireEvent.change(screen.getByLabelText('Filter item type'), { target: { value: 'medical_equipment' } })
    expect(screen.queryByText('Test medicine')).not.toBeInTheDocument()
    expect(screen.getByText('Test equipment')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /add item/i }))
    fireEvent.change(getFieldAfterLabel('Item Type *'), { target: { value: 'medical_equipment' } })
    expect(getFieldAfterLabel('Expiry Date (if applicable)')).not.toBeRequired()
    expect(getFieldAfterLabel('Unit *')).toHaveValue('unit')
    expect(screen.queryByText('Medicine access level')).not.toBeInTheDocument()
    fireEvent.change(getFieldAfterLabel('Item Type *'), { target: { value: 'medicine' } })
    expect(getFieldAfterLabel('Expiry Date *')).toBeRequired()
  })

  it('auto-calculates selling price from cost price until the price is edited manually', async () => {
    render(<Inventory />)

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /inventory management/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /add item/i }))

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
