import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const salesPage = readFileSync(resolve(process.cwd(), 'src/pages/Sales.jsx'), 'utf8')
const salesStyles = readFileSync(resolve(process.cwd(), 'src/pages/Sales.css'), 'utf8')
const receipt = readFileSync(resolve(process.cwd(), 'src/components/Receipt/Receipt.jsx'), 'utf8')

describe('POS sale confirmation contract', () => {
  it('opens a review gate before any sale transaction path starts', () => {
    const reviewGate = salesPage.indexOf('if (!confirmed)')
    const transactionStart = salesPage.indexOf('try {', salesPage.indexOf('const handleCompleteSale'))

    expect(reviewGate).toBeGreaterThan(-1)
    expect(transactionStart).toBeGreaterThan(reviewGate)
    expect(salesPage).toContain('setShowSaleConfirmation(true)')
    expect(salesPage).toContain('Confirm & Complete Sale')
  })

  it('guards confirmation against duplicate clicks and provides a mobile layout', () => {
    expect(salesPage).toContain('if (confirmingSale || processing)')
    expect(salesPage).toContain('disabled={confirmingSale || processing}')
    expect(salesStyles).toContain('.sale-confirmation-overlay')
    expect(salesStyles).toContain('max-height: 100dvh')
  })

  it('keeps the receipt settlement-aware without a decorative QR request', () => {
    expect(receipt).toContain("<span>Patient Paid</span>")
    expect(receipt).toContain("<span>Private / Non-NHIS</span>")
    expect(receipt).not.toContain('api.qrserver.com')
    expect(receipt).toContain("isNhisSettlement ? 'NHIS Covered' : 'Insurance Covered'")
  })
})
