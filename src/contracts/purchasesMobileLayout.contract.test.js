import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const purchasesPage = readFileSync(resolve(process.cwd(), 'src/pages/Purchases.jsx'), 'utf8')
const purchasesCss = readFileSync(resolve(process.cwd(), 'src/pages/Purchases.css'), 'utf8')

describe('purchases mobile layout contract', () => {
  it('converts the purchase list to labelled records on phone widths', () => {
    expect(purchasesPage).toContain('data-label="Purchase order"')
    expect(purchasesPage).toContain('data-label="Supplier"')
    expect(purchasesCss).toContain('.purchases-table td::before')
    expect(purchasesCss).toContain('content: attr(data-label);')
    expect(purchasesCss).toContain('.purchases-table thead {\n    display: none;')
  })
})
