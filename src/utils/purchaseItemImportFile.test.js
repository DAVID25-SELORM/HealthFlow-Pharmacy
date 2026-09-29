import { describe, expect, it, vi } from 'vitest'
import { PURCHASE_IMPORT_COLUMNS, PURCHASE_IMPORT_MAX_FILE_BYTES } from './purchaseItemImport'

vi.mock('read-excel-file/browser', () => ({ readSheet: vi.fn() }))
vi.mock('write-excel-file/browser', () => ({ default: vi.fn() }))

import { readSheet } from 'read-excel-file/browser'
import writeExcelFile from 'write-excel-file/browser'
import { downloadPurchaseImportTemplate, readPurchaseImportRows } from './purchaseItemImportFile'

describe('readPurchaseImportRows', () => {
  it('rejects with no file chosen', async () => {
    await expect(readPurchaseImportRows(null)).rejects.toThrow('Choose a file')
  })

  it('rejects a file over the size limit before attempting to read it', async () => {
    const file = { name: 'big.csv', size: PURCHASE_IMPORT_MAX_FILE_BYTES + 1 }
    await expect(readPurchaseImportRows(file)).rejects.toThrow(/too large/)
    expect(readSheet).not.toHaveBeenCalled()
  })

  it('rejects an unsupported file type', async () => {
    const file = { name: 'items.pdf', size: 100 }
    await expect(readPurchaseImportRows(file)).rejects.toThrow('Unsupported file type')
  })

  it('reads a .xlsx file through read-excel-file, never evaluating spreadsheet formulas itself', async () => {
    const rows = [['Drug / Item', 'Qty'], ['Paracetamol', 10]]
    readSheet.mockResolvedValueOnce(rows)
    const file = { name: 'purchase.xlsx', size: 100 }

    await expect(readPurchaseImportRows(file)).resolves.toEqual(rows)
    expect(readSheet).toHaveBeenCalledWith(file)
  })

  it('wraps a read-excel-file failure with a specific message instead of a bare failure', async () => {
    readSheet.mockRejectedValueOnce(new Error('corrupt workbook'))
    await expect(readPurchaseImportRows({ name: 'bad.xlsx', size: 100 })).rejects.toThrow(/Could not read this Excel file: corrupt workbook/)
  })

  it('reads a real .csv File through the browser FileReader/CSV parser', async () => {
    const file = new File(['Drug / Item,Qty\nParacetamol,10\n'], 'purchase.csv', { type: 'text/csv' })
    await expect(readPurchaseImportRows(file)).resolves.toEqual([
      ['Drug / Item', 'Qty'],
      ['Paracetamol', '10'],
    ])
  })
})

describe('downloadPurchaseImportTemplate', () => {
  it('writes a header row followed by one example row, in the documented column order', async () => {
    const toFile = vi.fn().mockResolvedValue(undefined)
    writeExcelFile.mockReturnValue({ toFile })

    await downloadPurchaseImportTemplate()

    expect(writeExcelFile).toHaveBeenCalledTimes(1)
    const [sheetData] = writeExcelFile.mock.calls[0]
    expect(sheetData).toHaveLength(2)
    expect(sheetData[0]).toEqual(PURCHASE_IMPORT_COLUMNS.map((column) => column.header))
    expect(sheetData[1][0]).toBe('Paracetamol 500mg') // Drug / Item
    expect(toFile).toHaveBeenCalledWith('purchase_order_import_template.xlsx')
  })
})
