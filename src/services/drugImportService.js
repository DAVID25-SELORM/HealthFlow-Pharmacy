import { readSheet } from 'read-excel-file/browser'
import writeExcelFile from 'write-excel-file/browser'
import { assertNonNegativeNumber, assertRequiredText, normalizeText } from '../utils/validation'
import { invokeTierAccess } from './tierAccessService'

/**
 * Drug Import Service
 * Handles bulk import of drugs from Excel files
 */

const REQUIRED_COLUMNS = ['name', 'expiry_date', 'quantity', 'price']
const OPTIONAL_COLUMNS = ['batch_number', 'supplier', 'category', 'description', 'cost_price', 'reorder_level', 'unit']
const ALL_COLUMNS = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]
const RESERVED_DEFAULT_BATCH_PREFIX = 'PDF-IMP-'
const MAX_IMPORT_FILE_SIZE_BYTES = 2 * 1024 * 1024

const assertSafeDrugName = (value) => {
  const name = assertRequiredText(value, 'Drug name')
  if (/[<>]/.test(name)) {
    throw new Error('Drug name cannot contain HTML or script characters.')
  }
  return name
}

const formatDateCell = (value) => {
  if (value instanceof Date) {
    return value.toISOString().split('T')[0]
  }

  return String(value || '')
}

const rowsToObjects = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return []
  }

  const headers = rows[0].map((header) => normalizeText(header).toLowerCase())
  return rows.slice(1).map((row) => {
    const object = {}
    headers.forEach((header, index) => {
      object[header] = row[index] ?? ''
    })
    return object
  })
}

/**
 * Validate Excel column headers
 */
const validateHeaders = (headers) => {
  const normalizedHeaders = headers.map(h => normalizeText(h).toLowerCase())
  const missingRequired = REQUIRED_COLUMNS.filter(col => !normalizedHeaders.includes(col))
  
  if (missingRequired.length > 0) {
    throw new Error(`Missing required columns: ${missingRequired.join(', ')}`)
  }
  
  return normalizedHeaders
}

/**
 * Validate and normalize a single drug row
 */
const validateDrugRow = (row, rowIndex) => {
  const errors = []
  
  try {
    // Required fields
    const name = assertSafeDrugName(row.name)
    const batchNumber = normalizeText(row.batch_number) || null

    if (batchNumber && batchNumber.toUpperCase().startsWith(RESERVED_DEFAULT_BATCH_PREFIX)) {
      errors.push(
        `Batch numbers starting with ${RESERVED_DEFAULT_BATCH_PREFIX} are reserved for the default medicine catalog`
      )
    }
    
    if (!row.expiry_date) {
      errors.push('Expiry date is required')
    }
    
    const quantity = assertNonNegativeNumber(row.quantity, 'Quantity')
    const price = assertNonNegativeNumber(row.price, 'Price')
    
    // Validate date format (YYYY-MM-DD or recognizable date)
    const expiryDate = formatDateCell(row.expiry_date)
    
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      errors.push('Expiry date must be in YYYY-MM-DD format')
    }
    
    if (errors.length > 0) {
      return {
        valid: false,
        errors,
        row: rowIndex + 1,
        data: row
      }
    }
    
    // Build validated drug object
    return {
      valid: true,
      data: {
        name,
        batch_number: batchNumber,
        expiry_date: expiryDate,
        quantity,
        price,
        cost_price: row.cost_price ? assertNonNegativeNumber(row.cost_price, 'Cost price') : 0,
        supplier: normalizeText(row.supplier) || null,
        category: normalizeText(row.category) || null,
        description: normalizeText(row.description) || null,
        reorder_level: row.reorder_level ? assertNonNegativeNumber(row.reorder_level, 'Reorder level') : 10,
        unit: normalizeText(row.unit) || 'tablet',
        status: 'active'
      }
    }
  } catch (error) {
    return {
      valid: false,
      errors: [error.message],
      row: rowIndex + 1,
      data: row
    }
  }
}

/**
 * Parse Excel file and return drug data
 */
export const parseExcelFile = (file) => {
  return new Promise((resolve, reject) => {
    if (file?.size > MAX_IMPORT_FILE_SIZE_BYTES) {
      reject(new Error('Excel file is too large. Please upload a file smaller than 2 MB.'))
      return
    }

    readSheet(file)
      .then((rows) => {
        const jsonData = rowsToObjects(rows)

        if (jsonData.length === 0) {
          reject(new Error('Excel file is empty'))
          return
        }

        validateHeaders(Object.keys(jsonData[0]))
        resolve(jsonData)
      })
      .catch((error) => reject(error))
  })
}

/**
 * Validate all rows and return validation results
 */
export const validateImportData = (data) => {
  const validRows = []
  const invalidRows = []
  
  data.forEach((row, index) => {
    const result = validateDrugRow(row, index)
    
    if (result.valid) {
      validRows.push(result.data)
    } else {
      invalidRows.push({
        row: result.row,
        errors: result.errors,
        data: result.data
      })
    }
  })
  
  return {
    validRows,
    invalidRows,
    totalRows: data.length,
    validCount: validRows.length,
    invalidCount: invalidRows.length
  }
}

/**
 * Import drugs to database in batches
 */
export const importDrugs = async (drugs, batchSize = 50) => {
  void batchSize

  return await invokeTierAccess({
    action: 'bulk_import_drugs',
    drugs,
  })
}

/**
 * Generate sample Excel template
 */
export const generateTemplate = async () => {
  const sampleData = [
    {
      name: 'Paracetamol 500mg',
      batch_number: 'BT001',
      expiry_date: '2026-12-31',
      quantity: 500,
      price: 5.00,
      cost_price: 3.00,
      supplier: 'PharmaCare Ltd',
      category: 'Pain Relief',
      description: 'Analgesic and antipyretic',
      reorder_level: 100,
      unit: 'tablet'
    },
    {
      name: 'Amoxicillin 500mg',
      batch_number: 'BT002',
      expiry_date: '2026-08-15',
      quantity: 200,
      price: 37.00,
      cost_price: 25.00,
      supplier: 'Beta Healthcare',
      category: 'Antibiotics',
      description: 'Broad spectrum antibiotic',
      reorder_level: 50,
      unit: 'capsule'
    }
  ]
  
  const sheetData = [
    ALL_COLUMNS,
    ...sampleData.map((row) => ALL_COLUMNS.map((column) => row[column] ?? '')),
  ]

  await writeExcelFile(sheetData).toFile('drug_import_template.xlsx')
}
