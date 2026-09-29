// Browser-only file I/O for purchase order bulk import: reading the uploaded workbook/CSV into rows, and writing
// the downloadable template. Kept separate from purchaseItemImport.js so that module's parsing/validation/matching
// logic stays framework- and browser-API-free and easy to unit test.
import { readSheet } from 'read-excel-file/browser'
import writeExcelFile from 'write-excel-file/browser'
import {
  PURCHASE_IMPORT_COLUMNS,
  PURCHASE_IMPORT_MAX_FILE_BYTES,
  parsePurchaseImportCsv,
} from './purchaseItemImport'

const isCsvFile = (file) => /\.csv$/i.test(file?.name || '') || file?.type === 'text/csv'
const isExcelFile = (file) => /\.xlsx?$/i.test(file?.name || '')

/**
 * Reads an uploaded .xlsx or .csv file into a plain rows array (first row = header), the same shape
 * purchaseImportRowsToObjects() expects. Rejects anything else outright — spreadsheet formulas are never
 * evaluated (read-excel-file reads computed cell values only) and no other file type is accepted.
 */
export const readPurchaseImportRows = (file) => {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('Choose a file to import.'))
      return
    }
    if (file.size > PURCHASE_IMPORT_MAX_FILE_BYTES) {
      reject(new Error(`File is too large. Please upload a file smaller than ${Math.round(PURCHASE_IMPORT_MAX_FILE_BYTES / (1024 * 1024))} MB.`))
      return
    }
    if (isExcelFile(file)) {
      readSheet(file).then(resolve).catch((error) => reject(new Error(`Could not read this Excel file: ${error.message || error}`)))
      return
    }
    if (isCsvFile(file)) {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('Could not read this CSV file.'))
      reader.onload = () => {
        try {
          resolve(parsePurchaseImportCsv(String(reader.result || '')))
        } catch (error) {
          reject(new Error(`Could not read this CSV file: ${error.message || error}`))
        }
      }
      reader.readAsText(file)
      return
    }
    reject(new Error('Unsupported file type. Upload a .xlsx or .csv file.'))
  })
}

/** Downloadable template: header row plus one example row the user deletes before filling in their own items. */
export const downloadPurchaseImportTemplate = async () => {
  const exampleRow = {
    drugName: 'Paracetamol 500mg',
    brandName: 'Panadol',
    genericName: 'Paracetamol',
    unit: 'tablet',
    quantity: 100,
    unitCost: 0.5,
    discountPercent: 0,
    batchNumber: 'BATCH001',
    expiryDate: '2027-12-31',
    saleOnReturn: 'No',
  }
  const sheetData = [
    PURCHASE_IMPORT_COLUMNS.map((column) => column.header),
    PURCHASE_IMPORT_COLUMNS.map((column) => exampleRow[column.key] ?? ''),
  ]
  await writeExcelFile(sheetData).toFile('purchase_order_import_template.xlsx')
}
