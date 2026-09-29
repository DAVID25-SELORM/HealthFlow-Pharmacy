import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NotificationProvider } from '../../context/NotificationContext'
import PurchaseItemImportPanel from './PurchaseItemImportPanel'

vi.mock('../../utils/purchaseItemImportFile', () => ({
  readPurchaseImportRows: vi.fn(),
  downloadPurchaseImportTemplate: vi.fn().mockResolvedValue(undefined),
}))

import { downloadPurchaseImportTemplate, readPurchaseImportRows } from '../../utils/purchaseItemImportFile'

const HEADER = ['Drug / Item', 'Brand Name', 'Generic Name', 'Unit', 'Qty', 'Unit Cost', 'Discount %', 'Batch No.', 'Expiry Date', 'Sale on Return']
const drugs = [{ id: 'd1', name: 'Paracetamol 500mg', brand_name: 'Panadol', generic_name: 'Paracetamol' }]
const unitOptions = ['tablet', 'capsule']
const calcGross = (qty, cost) => (Number.parseFloat(qty) || 0) * (Number.parseFloat(cost) || 0)
const calcDiscountValue = (qty, cost, type, value) => Math.min(Math.max((calcGross(qty, cost) * (Number.parseFloat(value) || 0)) / 100, 0), calcGross(qty, cost))
const calcNetTotal = (qty, cost, type, value) => Math.max(0, calcGross(qty, cost) - calcDiscountValue(qty, cost, type, value))
const fmtCurrency = (n) => `GHS ${Number(n || 0).toFixed(2)}`

const renderPanel = (onImport = vi.fn()) => {
  render(
    <NotificationProvider>
      <PurchaseItemImportPanel
        drugs={drugs}
        allowedUnits={unitOptions}
        fallbackUnit="tablet"
        calcDiscountValue={calcDiscountValue}
        calcNetTotal={calcNetTotal}
        fmtCurrency={fmtCurrency}
        onImport={onImport}
      />
    </NotificationProvider>
  )
  return onImport
}

const uploadFile = async (rows) => {
  readPurchaseImportRows.mockResolvedValueOnce(rows)
  const input = document.querySelector('input[type="file"]')
  await act(async () => {
    fireEvent.change(input, { target: { files: [{ name: 'purchase.xlsx', size: 100 }] } })
  })
}

describe('PurchaseItemImportPanel', () => {
  it('downloads the template on request', async () => {
    renderPanel()
    fireEvent.click(screen.getByText('Download Template'))
    expect(downloadPurchaseImportTemplate).toHaveBeenCalledTimes(1)
  })

  it('previews a valid, a matched-with-typo (warning), and an invalid row after upload', async () => {
    renderPanel()
    await uploadFile([
      HEADER,
      ['Paracetamol 500mg', '', '', 'tablet', '100', '0.5', '10', 'B1', '2027-12-31', 'No'],
      ['Some Unknown Drug', '', '', 'tablet', '10', '1', '', '', '', ''],
      ['', '', '', '', '-5', 'bad', '', '', '', ''],
    ])

    expect(screen.getByText('2 of 3 rows ready to import')).toBeTruthy()
    expect(screen.getByText('1 row needs attention and will not be imported')).toBeTruthy()
    const badges = document.querySelectorAll('.purchase-import-badge')
    expect([...badges].map((el) => el.textContent)).toEqual(['Valid', 'Needs a look', 'Invalid'])
  })

  it('shows a file-level error (not a bare "import failed") for a file missing required columns', async () => {
    renderPanel()
    await uploadFile([['Brand Name'], ['Panadol']])
    expect(screen.getByRole('alert').textContent).toMatch(/Missing required column/)
  })

  it('imports only the importable rows, with totals computed by the injected calculators', async () => {
    const onImport = renderPanel()
    await uploadFile([
      HEADER,
      ['Paracetamol 500mg', '', '', 'tablet', '100', '0.5', '10', 'B1', '2027-12-31', 'No'],
      ['', '', '', '', '-5', 'bad', '', '', '', ''], // invalid, excluded
    ])

    fireEvent.click(screen.getByText('Import 1 Valid Row'))

    expect(onImport).toHaveBeenCalledTimes(1)
    const [items, summary] = onImport.mock.calls[0]
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ drugId: 'd1', drugName: 'Paracetamol 500mg', quantity: 100, unitCost: 0.5, discountPercent: 10, netTotal: 45 })
    expect(summary).toMatchObject({ totalRows: 2, validRows: 1, invalidRows: 1 })
  })

  it('lets the user match an unmatched row to an existing drug, turning it valid', async () => {
    renderPanel()
    await uploadFile([HEADER, ['Paracetamool 500mg', '', '', 'tablet', '10', '1', '', '', '', '']])
    expect(screen.getByText('Needs a look')).toBeTruthy()

    fireEvent.click(screen.getByText('Match Item'))
    fireEvent.change(screen.getByPlaceholderText('Search inventory…'), { target: { value: 'Paracetamol' } })
    fireEvent.click(screen.getByText('Paracetamol 500mg'))

    expect(screen.getByText('Valid')).toBeTruthy()
    expect(screen.queryByText('Match Item')).toBeNull()
  })

  it('removes a row from the preview without affecting the others', async () => {
    renderPanel()
    await uploadFile([
      HEADER,
      ['Paracetamol 500mg', '', '', 'tablet', '100', '0.5', '0', '', '', ''],
      ['Amoxicillin 500mg', '', '', 'tablet', '10', '1', '0', '', '', ''],
    ])
    expect(screen.getByText('2 of 2 rows ready to import')).toBeTruthy()

    const [firstRemoveButton] = screen.getAllByLabelText('Remove row')
    fireEvent.click(firstRemoveButton)

    expect(screen.getByText('1 of 1 row ready to import')).toBeTruthy()
    expect(screen.queryByText('Paracetamol 500mg')).toBeNull()
  })

  it('offers to combine identical duplicate rows, and combines their quantities on import', async () => {
    const onImport = renderPanel()
    await uploadFile([
      HEADER,
      ['Paracetamol 500mg', '', '', 'tablet', '60', '0.5', '0', 'B1', '2027-12-31', 'No'],
      ['Paracetamol 500mg', '', '', 'tablet', '40', '0.5', '0', 'B1', '2027-12-31', 'No'],
    ])

    expect(screen.getByText(/Combine 2 rows that look identical/)).toBeTruthy()
    fireEvent.click(screen.getByText('Import 2 Valid Rows'))

    const [items] = onImport.mock.calls[0]
    expect(items).toHaveLength(1)
    expect(items[0].quantity).toBe(100)
  })

  it('keeps rows with different batches as separate lines even with the combine toggle on', async () => {
    const onImport = renderPanel()
    await uploadFile([
      HEADER,
      ['Paracetamol 500mg', '', '', 'tablet', '60', '0.5', '0', 'B1', '2027-12-31', 'No'],
      ['Paracetamol 500mg', '', '', 'tablet', '40', '0.5', '0', 'B2', '2027-12-31', 'No'],
    ])
    expect(screen.queryByText(/Combine/)).toBeNull()

    fireEvent.click(screen.getByText('Import 2 Valid Rows'))
    const [items] = onImport.mock.calls[0]
    expect(items).toHaveLength(2)
  })

  it('discards the previewed rows without importing anything', async () => {
    const onImport = renderPanel()
    await uploadFile([HEADER, ['Paracetamol 500mg', '', '', 'tablet', '10', '1', '0', '', '', '']])
    fireEvent.click(screen.getByText('Discard'))

    expect(screen.queryByText(/ready to import/)).toBeNull()
    expect(onImport).not.toHaveBeenCalled()
  })

  it('disables the Import button and imports nothing when every row is invalid', async () => {
    renderPanel()
    await uploadFile([HEADER, ['Paracetamol 500mg', '', '', '', 'not-a-number', 'also-not-a-number', '', '', '', '']])
    expect(screen.getByText('Import 0 Valid Rows')).toBeDisabled()
  })
})
