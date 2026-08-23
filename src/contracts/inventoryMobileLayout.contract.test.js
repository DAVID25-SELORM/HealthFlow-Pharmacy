import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const inventoryPage = readFileSync(resolve(process.cwd(), 'src/pages/Inventory.jsx'), 'utf8')
const inventoryCss = readFileSync(resolve(process.cwd(), 'src/pages/Inventory.css'), 'utf8')

describe('inventory mobile layout contract', () => {
  it('uses the existing inventory data as labelled cards on mobile', () => {
    expect(inventoryPage).toContain('data-label="Medicine"')
    expect(inventoryPage).toContain('data-label="Selling price"')
    expect(inventoryCss).toContain('.inventory-table td::before')
    expect(inventoryCss).toContain('content: attr(data-label);')
    expect(inventoryCss).toContain('.inventory-table thead {\n    display: none;')
  })
})
