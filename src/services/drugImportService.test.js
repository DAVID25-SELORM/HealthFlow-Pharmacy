import { describe, it, expect } from 'vitest'
import { validateImportData } from '../services/drugImportService'

describe('Drug Import Validation', () => {
  it('validates valid drug data', () => {
    const data = [
      {
        name: 'Paracetamol 500mg',
        batch_number: 'BT001',
        expiry_date: '2026-12-31',
        quantity: 500,
        price: 5.00
      }
    ]

    const result = validateImportData(data)
    
    expect(result.validCount).toBe(1)
    expect(result.invalidCount).toBe(0)
    expect(result.validRows[0].name).toBe('Paracetamol 500mg')
  })

  it('rejects drug with missing name', () => {
    const data = [
      {
        name: '',
        batch_number: 'BT001',
        expiry_date: '2026-12-31',
        quantity: 500,
        price: 5.00
      }
    ]

    const result = validateImportData(data)
    
    expect(result.validCount).toBe(0)
    expect(result.invalidCount).toBe(1)
    expect(result.invalidRows[0].errors[0]).toContain('Drug name')
  })

  it('rejects drug with negative quantity', () => {
    const data = [
      {
        name: 'Paracetamol 500mg',
        batch_number: 'BT001',
        expiry_date: '2026-12-31',
        quantity: -10,
        price: 5.00
      }
    ]

    const result = validateImportData(data)
    
    expect(result.validCount).toBe(0)
    expect(result.invalidCount).toBe(1)
  })

  it('handles Date objects from Excel', () => {
    const data = [
      {
        name: 'Test Drug',
        batch_number: 'BT001',
        expiry_date: new Date('2026-12-31'),
        quantity: 100,
        price: 10.00
      }
    ]

    const result = validateImportData(data)
    
    expect(result.validCount).toBe(1)
    expect(result.validRows[0].expiry_date).toBe('2026-12-31')
  })

  it('rejects invalid date format', () => {
    const data = [
      {
        name: 'Test Drug',
        batch_number: 'BT001',
        expiry_date: '31/12/2026',
        quantity: 100,
        price: 10.00
      }
    ]

    const result = validateImportData(data)
    
    expect(result.validCount).toBe(0)
    expect(result.invalidCount).toBe(1)
    expect(result.invalidRows[0].errors[0]).toContain('YYYY-MM-DD format')
  })

  it('handles mixed valid and invalid rows', () => {
    const data = [
      {
        name: 'Valid Drug',
        batch_number: 'BT001',
        expiry_date: '2026-12-31',
        quantity: 100,
        price: 10.00
      },
      {
        name: '',
        batch_number: 'BT002',
        expiry_date: '2026-12-31',
        quantity: 100,
        price: 10.00
      },
      {
        name: 'Another Valid Drug',
        batch_number: 'BT003',
        expiry_date: '2026-11-30',
        quantity: 50,
        price: 20.00
      }
    ]

    const result = validateImportData(data)
    
    expect(result.validCount).toBe(2)
    expect(result.invalidCount).toBe(1)
    expect(result.totalRows).toBe(3)
  })
})
