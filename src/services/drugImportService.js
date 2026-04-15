import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { assertNonNegativeNumber, assertRequiredText, normalizeText } from '../utils/validation'

/**
 * Drug Import Service
 * Handles bulk import of drugs from Excel files
 */

const REQUIRED_COLUMNS = ['name', 'batch_number', 'expiry_date', 'quantity', 'price']
const OPTIONAL_COLUMNS = ['supplier', 'category', 'description', 'cost_price', 'reorder_level', 'unit']
const ALL_COLUMNS = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]

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
    const name = assertRequiredText(row.name, 'Drug name')
    const batchNumber = assertRequiredText(row.batch_number, 'Batch number')
    
    if (!row.expiry_date) {
      errors.push('Expiry date is required')
    }
    
    const quantity = assertNonNegativeNumber(row.quantity, 'Quantity')
    const price = assertNonNegativeNumber(row.price, 'Price')
    
    // Validate date format (YYYY-MM-DD or recognizable date)
    const expiryDate = row.expiry_date instanceof Date 
      ? row.expiry_date.toISOString().split('T')[0]
      : String(row.expiry_date)
    
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
        unit: normalizeText(row.unit) || 'tablets',
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
    const reader = new FileReader()
    
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result)
        const workbook = XLSX.read(data, { type: 'array', cellDates: true })
        
        // Get first sheet
        const sheetName = workbook.SheetNames[0]
        const worksheet = workbook.Sheets[sheetName]
        
        // Convert to JSON
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' })
        
        if (jsonData.length === 0) {
          reject(new Error('Excel file is empty'))
          return
        }
        
        // Validate headers
        const headers = Object.keys(jsonData[0])
        validateHeaders(headers)
        
        // Normalize column names
        const normalizedData = jsonData.map(row => {
          const normalized = {}
          Object.keys(row).forEach(key => {
            const normalizedKey = normalizeText(key).toLowerCase()
            normalized[normalizedKey] = row[key]
          })
          return normalized
        })
        
        resolve(normalizedData)
      } catch (error) {
        reject(error)
      }
    }
    
    reader.onerror = () => {
      reject(new Error('Failed to read Excel file'))
    }
    
    reader.readAsArrayBuffer(file)
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
  const results = {
    successful: [],
    failed: []
  }
  
  // Process in batches to avoid overwhelming the database
  for (let i = 0; i < drugs.length; i += batchSize) {
    const batch = drugs.slice(i, i + batchSize)
    
    try {
      const { data, error } = await supabase
        .from('drugs')
        .insert(batch)
        .select()
      
      if (error) {
        // If batch fails, try inserting one by one to identify problematic rows
        for (const drug of batch) {
          try {
            const { data: singleData, error: singleError } = await supabase
              .from('drugs')
              .insert([drug])
              .select()
            
            if (singleError) {
              results.failed.push({
                drug,
                error: singleError.message
              })
            } else {
              results.successful.push(singleData[0])
            }
          } catch (singleErr) {
            results.failed.push({
              drug,
              error: singleErr.message
            })
          }
        }
      } else {
        results.successful.push(...data)
      }
    } catch (batchError) {
      // Batch failed completely, try one by one
      for (const drug of batch) {
        try {
          const { data: singleData, error: singleError } = await supabase
            .from('drugs')
            .insert([drug])
            .select()
          
          if (singleError) {
            results.failed.push({
              drug,
              error: singleError.message
            })
          } else {
            results.successful.push(singleData[0])
          }
        } catch (singleErr) {
          results.failed.push({
            drug,
            error: singleErr.message
          })
        }
      }
    }
  }
  
  return results
}

/**
 * Generate sample Excel template
 */
export const generateTemplate = () => {
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
      unit: 'tablets'
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
      unit: 'capsules'
    }
  ]
  
  const worksheet = XLSX.utils.json_to_sheet(sampleData)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Drugs')
  
  // Generate and download
  XLSX.writeFile(workbook, 'drug_import_template.xlsx')
}
